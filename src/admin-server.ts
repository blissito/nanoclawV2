/**
 * Admin HTTP API consumed by ghosty-studio.
 *
 * Read & edit per-agent-group config keyed by chat JID. Same NANOCLAW_ADMIN_TOKEN
 * the usage-reporter uses, constant-time compared. Bind 0.0.0.0:8787 by default
 * — ghosty stores this as `Deployment.apiUrl`, do not change without updating
 * ghosty's DB row.
 *
 * v2 entity-model mapping (the prompt's API was originally drawn for v1's
 * RegisteredGroup table; v2 splits it across messaging_groups, agent_groups,
 * and messaging_group_agents):
 *   :jid                            → messaging_groups.platform_id
 *   first matching messaging group  → take first MGA (by priority desc, ties first-created)
 *                                   → agent_groups (via mga.agent_group_id)
 *   trigger / requiresTrigger       → derived from MGA.engage_mode (+ container.json.assistantName)
 *   mcpServers (read)               → Object.keys(container.json.mcpServers)
 *   mcpServers (write)              → unsupported in v2 (server config requires
 *                                     {url, headers}; bare names aren't enough).
 *                                     Logged + ignored, rest of PATCH proceeds.
 *   claudeMd                        → groups/<folder>/CLAUDE.local.md (the
 *                                     user-editable one; CLAUDE.md is composed
 *                                     at container spawn).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

import { GROUPS_DIR } from './config.js';
import { log } from './log.js';
import { getDb } from './db/connection.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroupAgents } from './db/messaging-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

const DEFAULT_PORT = 8787;

let server: http.Server | null = null;

interface AdminConfig {
  token: string;
  port: number;
  host: string;
}

function loadAdminConfig(): AdminConfig | null {
  const token = process.env.NANOCLAW_ADMIN_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    port: Number(process.env.NANOCLAW_ADMIN_PORT ?? DEFAULT_PORT),
    host: process.env.NANOCLAW_ADMIN_HOST ?? '0.0.0.0',
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

// ── JID resolution ────────────────────────────────────────────────────────

interface ResolvedAgent {
  mg: MessagingGroup;
  mga: MessagingGroupAgent;
  agentGroup: { id: string; name: string; folder: string; created_at: string };
}

/**
 * Find the (messaging_group, primary MGA, agent_group) trio for a JID.
 * "Primary MGA" = highest priority, ties broken by first created.
 *
 * If multiple messaging_groups share the same platform_id across channels
 * (rare — usually only WhatsApp uses @g.us format), pick the first one.
 */
function resolveJid(jid: string): ResolvedAgent | null {
  const mg = getDb()
    .prepare('SELECT * FROM messaging_groups WHERE platform_id = ? ORDER BY created_at LIMIT 1')
    .get(jid) as MessagingGroup | undefined;
  if (!mg) return null;

  const mgas = getMessagingGroupAgents(mg.id);
  if (mgas.length === 0) return null;
  const mga = [...mgas].sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))[0];

  const ag = getAgentGroup(mga.agent_group_id);
  if (!ag) return null;
  return { mg, mga, agentGroup: { id: ag.id, name: ag.name, folder: ag.folder, created_at: ag.created_at } };
}

// ── Per-group filesystem ──────────────────────────────────────────────────

function groupDir(folder: string): string {
  return path.join(GROUPS_DIR, folder);
}

function readContainerConfig(folder: string): Record<string, unknown> | null {
  const p = path.join(groupDir(folder), 'container.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeContainerConfig(folder: string, config: Record<string, unknown>): void {
  const p = path.join(groupDir(folder), 'container.json');
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * The user-editable CLAUDE: prefer CLAUDE.local.md (auto-loaded into the
 * composed CLAUDE.md mounted into the container). Fall back to CLAUDE.md
 * for backward compat with ghosty's expectation of the field name.
 */
function readClaudeMd(folder: string): string | null {
  const local = path.join(groupDir(folder), 'CLAUDE.local.md');
  const root = path.join(groupDir(folder), 'CLAUDE.md');
  try {
    return fs.readFileSync(local, 'utf8');
  } catch {
    try {
      return fs.readFileSync(root, 'utf8');
    } catch {
      return null;
    }
  }
}

function writeClaudeMd(folder: string, content: string): void {
  // Always write to CLAUDE.local.md — that's the user-editable layer that
  // composeClaudeMd picks up at container spawn. CLAUDE.md is composed
  // dynamically; writing to it gets clobbered.
  const p = path.join(groupDir(folder), 'CLAUDE.local.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

// ── Activity ──────────────────────────────────────────────────────────────

interface ActivityMessage {
  id: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromBot: boolean;
  isFromMe: boolean;
}

interface ActivityResponse {
  lastMessageAt: string | null;
  lastMessage: { senderName: string; content: string; isFromBot: boolean; isFromMe: boolean } | null;
  lastBotReply: { content: string; timestamp: string } | null;
  messagesLast24h: number;
  messagesLast7d: number;
  recent: ActivityMessage[];
  error?: string;
}

function previewContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    if (typeof parsed.text === 'string') return parsed.text.slice(0, 500);
  } catch { /* fall through */ }
  return raw.slice(0, 500);
}

function senderNameFromInboundContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { sender?: string; author?: { fullName?: string; userName?: string } };
    return parsed.sender || parsed.author?.fullName || parsed.author?.userName || 'unknown';
  } catch {
    return 'unknown';
  }
}

function activityFor(agentGroupId: string, mgId: string): ActivityResponse {
  const empty: ActivityResponse = {
    lastMessageAt: null,
    lastMessage: null,
    lastBotReply: null,
    messagesLast24h: 0,
    messagesLast7d: 0,
    recent: [],
  };

  try {
    const sessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.messaging_group_id === mgId);
    if (sessions.length === 0) return empty;

    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    let count24h = 0;
    let count7d = 0;
    let lastBot: { content: string; timestamp: string } | null = null;
    const all: ActivityMessage[] = [];

    for (const session of sessions) {
      const inPath = inboundDbPath(agentGroupId, session.id);
      const outPath = outboundDbPath(agentGroupId, session.id);

      // Inbound (user → bot)
      if (fs.existsSync(inPath)) {
        const inDb = new Database(inPath, { readonly: true });
        try {
          const inRows = inDb.prepare(
            "SELECT id, content, timestamp FROM messages_in WHERE kind IN ('chat','chat-sdk') ORDER BY timestamp DESC LIMIT 100",
          ).all() as Array<{ id: string; content: string; timestamp: string }>;
          for (const r of inRows) {
            all.push({
              id: r.id,
              senderName: senderNameFromInboundContent(r.content),
              content: previewContent(r.content),
              timestamp: r.timestamp,
              isFromBot: false,
              isFromMe: false,
            });
            if (r.timestamp > since24h) count24h++;
            if (r.timestamp > since7d) count7d++;
          }
        } finally {
          inDb.close();
        }
      }

      // Outbound (bot → user)
      if (fs.existsSync(outPath)) {
        const outDb = new Database(outPath, { readonly: true });
        try {
          const outRows = outDb.prepare(
            "SELECT id, content, timestamp FROM messages_out WHERE kind IN ('chat','chat-sdk') ORDER BY timestamp DESC LIMIT 100",
          ).all() as Array<{ id: string; content: string; timestamp: string }>;
          for (const r of outRows) {
            all.push({
              id: r.id,
              senderName: 'bot',
              content: previewContent(r.content),
              timestamp: r.timestamp,
              isFromBot: true,
              isFromMe: true,
            });
            if (r.timestamp > since24h) count24h++;
            if (r.timestamp > since7d) count7d++;
            if (!lastBot || r.timestamp > lastBot.timestamp) {
              lastBot = { content: previewContent(r.content), timestamp: r.timestamp };
            }
          }
        } finally {
          outDb.close();
        }
      }
    }

    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const recent = all.slice(0, 50);
    const last = recent[0] ?? null;

    return {
      lastMessageAt: last?.timestamp ?? null,
      lastMessage: last
        ? { senderName: last.senderName, content: last.content, isFromBot: last.isFromBot, isFromMe: last.isFromMe }
        : null,
      lastBotReply: lastBot,
      messagesLast24h: count24h,
      messagesLast7d: count7d,
      recent,
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Container logs ────────────────────────────────────────────────────────

function tailDockerLogs(agentGroupId: string, lines: number): string {
  const ps = spawnSync('docker', [
    'ps', '--filter', `label=nanoclaw-agent-group-id=${agentGroupId}`, '--format', '{{.Names}}',
  ], { encoding: 'utf8' });
  if (ps.status !== 0) return '';
  const name = (ps.stdout || '').trim().split('\n')[0];
  if (!name) return '';

  const logs = spawnSync('docker', ['logs', '--tail', String(lines), name], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  // docker logs writes both stdout (app stdout) and stderr (app stderr) — concat.
  return (logs.stdout || '') + (logs.stderr || '');
}

// ── Public response shapes ────────────────────────────────────────────────

interface DropletAgent {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger: boolean;
  isMain: boolean;
  mcpServers: string[] | null;
  addedAt: string;
}

interface DropletAgentDetail extends DropletAgent {
  containerConfig: Record<string, unknown> | null;
  claudeMd: string | null;
}

function publicAgent(jid: string, resolved: ResolvedAgent, container: Record<string, unknown> | null): DropletAgent {
  const requiresTrigger = resolved.mga.engage_mode === 'mention' || resolved.mga.engage_mode === 'mention-sticky';
  const trigger = (container?.assistantName as string | undefined) || resolved.agentGroup.name;
  const mcpRaw = container?.mcpServers;
  const mcpServers = mcpRaw && typeof mcpRaw === 'object' && !Array.isArray(mcpRaw) ? Object.keys(mcpRaw) : null;
  return {
    jid,
    name: resolved.agentGroup.name,
    folder: resolved.agentGroup.folder,
    trigger,
    requiresTrigger,
    isMain: resolved.agentGroup.folder === 'main',
    mcpServers,
    addedAt: resolved.agentGroup.created_at,
  };
}

// ── Routing ───────────────────────────────────────────────────────────────

async function handle(req: http.IncomingMessage, res: http.ServerResponse, cfg: AdminConfig): Promise<void> {
  // Auth — same answer for missing AND wrong, so probes can't distinguish.
  const auth = req.headers.authorization ?? '';
  const expected = `Bearer ${cfg.token}`;
  if (!auth || !constantTimeEquals(auth, expected)) {
    send(res, 401, { error: 'invalid_bearer_token' });
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean);

  // GET /admin/agents
  if (method === 'GET' && parts[0] === 'admin' && parts[1] === 'agents' && parts.length === 2) {
    const rows = getDb().prepare(`
      SELECT mg.platform_id AS jid
        FROM messaging_groups mg
        JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       GROUP BY mg.id
       ORDER BY mg.created_at
    `).all() as Array<{ jid: string }>;
    const out: DropletAgent[] = [];
    for (const { jid } of rows) {
      const resolved = resolveJid(jid);
      if (!resolved) continue;
      const container = readContainerConfig(resolved.agentGroup.folder);
      out.push(publicAgent(jid, resolved, container));
    }
    send(res, 200, out);
    return;
  }

  // /admin/agents/:jid[...]
  if (parts[0] === 'admin' && parts[1] === 'agents' && parts.length >= 3) {
    const jid = decodeURIComponent(parts[2]);
    const resolved = resolveJid(jid);
    if (!resolved) {
      send(res, 404, { error: 'not_found', jid });
      return;
    }

    // GET /admin/agents/:jid
    if (method === 'GET' && parts.length === 3) {
      const container = readContainerConfig(resolved.agentGroup.folder);
      const detail: DropletAgentDetail = {
        ...publicAgent(jid, resolved, container),
        containerConfig: container,
        claudeMd: readClaudeMd(resolved.agentGroup.folder),
      };
      send(res, 200, detail);
      return;
    }

    // GET /admin/agents/:jid/activity
    if (method === 'GET' && parts.length === 4 && parts[3] === 'activity') {
      send(res, 200, activityFor(resolved.agentGroup.id, resolved.mg.id));
      return;
    }

    // GET /admin/agents/:jid/logs?tail=N
    if (method === 'GET' && parts.length === 4 && parts[3] === 'logs') {
      const requested = Number(url.searchParams.get('tail') ?? 200);
      const tail = Math.min(Math.max(Number.isFinite(requested) ? requested : 200, 1), 1000);
      send(res, 200, { logs: tailDockerLogs(resolved.agentGroup.id, tail) });
      return;
    }

    // PATCH /admin/agents/:jid
    if (method === 'PATCH' && parts.length === 3) {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        send(res, 400, { error: 'invalid_json' });
        return;
      }

      const allowed = ['trigger', 'requiresTrigger', 'mcpServers', 'claudeMd'] as const;
      const supplied = allowed.filter((k) => k in body);
      if (supplied.length === 0) {
        send(res, 400, { error: 'no_supported_fields', allowed });
        return;
      }

      const ignored: string[] = [];
      let touchedFiles = false;
      let touchedDb = false;

      // trigger → container.json.assistantName (closest analog in v2)
      if (typeof body.trigger === 'string') {
        const container = readContainerConfig(resolved.agentGroup.folder) ?? {};
        container.assistantName = body.trigger;
        writeContainerConfig(resolved.agentGroup.folder, container);
        touchedFiles = true;
      }

      // requiresTrigger → MGA.engage_mode (mention | pattern)
      if (typeof body.requiresTrigger === 'boolean') {
        if (body.requiresTrigger) {
          getDb().prepare("UPDATE messaging_group_agents SET engage_mode = 'mention' WHERE id = ?").run(resolved.mga.id);
        } else {
          getDb()
            .prepare("UPDATE messaging_group_agents SET engage_mode = 'pattern', engage_pattern = '.' WHERE id = ?")
            .run(resolved.mga.id);
        }
        touchedDb = true;
      }

      // mcpServers — bare names aren't sufficient to populate {url, headers}
      // entries in container.json. Acknowledge + ignore rather than silently
      // discarding everything else.
      if ('mcpServers' in body) {
        ignored.push('mcpServers (v2 needs {url, headers} per server, not bare names — use MCP install skill)');
      }

      // claudeMd → CLAUDE.local.md
      if (typeof body.claudeMd === 'string') {
        writeClaudeMd(resolved.agentGroup.folder, body.claudeMd);
        touchedFiles = true;
      }

      // If anything in container.json or CLAUDE.local.md changed, kill the
      // running container so the next message wakes a fresh one with the
      // composed CLAUDE.md regenerated. DB-only changes (engage_mode) are
      // read by the host router on every message — no restart needed.
      if (touchedFiles) {
        spawnSync(
          'sh',
          [
            '-c',
            `docker ps --filter label=nanoclaw-agent-group-id=${resolved.agentGroup.id} --format '{{.Names}}' | xargs -r docker stop >/dev/null 2>&1`,
          ],
          { encoding: 'utf8' },
        );
      }

      send(res, 200, {
        ok: true,
        applied: supplied.filter((k) => !ignored.some((i) => i.startsWith(k))),
        ignored,
        restarted_container: touchedFiles,
        db_updated: touchedDb,
      });
      return;
    }

    send(res, 405, { error: 'method_not_allowed' });
    return;
  }

  send(res, 404, { error: 'route_not_found' });
}

export function startAdminServer(): void {
  if (server) return;
  const cfg = loadAdminConfig();
  if (!cfg) {
    log.warn('Admin server skipped — NANOCLAW_ADMIN_TOKEN not set');
    return;
  }

  server = http.createServer((req, res) => {
    handle(req, res, cfg).catch((err) => {
      log.error('Admin handler threw', { url: req.url, err });
      try {
        send(res, 500, { error: 'internal' });
      } catch { /* response already sent */ }
    });
  });

  server.listen(cfg.port, cfg.host, () => {
    log.info('Admin server listening', { host: cfg.host, port: cfg.port });
  });

  server.on('error', (err) => {
    log.error('Admin server error', { err });
  });
}

export function stopAdminServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
