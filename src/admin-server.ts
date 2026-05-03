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
import { getAgentGroup, updateAgentGroup } from './db/agent-groups.js';
import { getMessagingGroupAgents } from './db/messaging-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './container-runtime.js';
import { getUser } from './modules/permissions/db/users.js';
import { getOwners } from './modules/permissions/db/user-roles.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { createGroupCore } from './modules/channels/apply.js';
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
  } catch {
    /* fall through */
  }
  return raw.slice(0, 500);
}

interface InboundContent {
  sender?: string;
  author?: { fullName?: string; userName?: string; userId?: string };
  senderId?: string;
}

/**
 * Resolve a friendly name for the inbound message author. Order:
 *   1. Real names from chat-sdk content (author.fullName / author.userName).
 *   2. users.display_name lookup against the JID we can dig out of the
 *      content (senderId, author.userId, or `sender` when it looks like a
 *      JID, not a name). The `whatsapp` adapter writes `content.sender` as
 *      the raw JID, so a JID-shaped `sender` MUST go through user lookup
 *      before being returned verbatim.
 *   3. Pretty-printed JID (strip `@s.whatsapp.net`, etc.).
 *   4. `content.sender` if it didn't look like a JID (unlikely, defensive).
 *   5. Literal "unknown".
 */
function resolveInboundSenderName(raw: string, channelType: string | null): string {
  let parsed: InboundContent = {};
  try {
    parsed = JSON.parse(raw) as InboundContent;
  } catch {
    /* */
  }

  const realName = parsed.author?.fullName || parsed.author?.userName;
  if (realName) return realName;

  const candidates = [parsed.senderId, parsed.author?.userId, parsed.sender].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  for (const c of candidates) {
    if (!looksLikeJid(c)) continue;
    if (channelType) {
      const userId = c.includes(':') ? c : `${channelType}:${c}`;
      try {
        const user = getUser(userId);
        if (user?.display_name) return user.display_name;
      } catch {
        /* DB issue — fall through to pretty-print */
      }
    }
    return prettyJid(c);
  }

  // Last-resort: a `sender` value that didn't look like a JID is presumably
  // already a name (legacy adapters).
  if (parsed.sender) return parsed.sender;
  return 'unknown';
}

function looksLikeJid(s: string): boolean {
  // "12345@s.whatsapp.net", "abc@g.us", "telegram:123", etc.
  return s.includes('@') || /^[a-z]+:[A-Za-z0-9._-]+/.test(s);
}

function prettyJid(jid: string): string {
  // "5217712412825@s.whatsapp.net" → "+5217712412825"; "12345@g.us" → "12345"
  const at = jid.indexOf('@');
  const local = at === -1 ? jid : jid.slice(0, at);
  return /^\d+$/.test(local) ? `+${local}` : local;
}

/**
 * Normalize a SQLite-emitted timestamp to ISO 8601.
 *
 * inbound.db rows: `datetime('now')` from the host stores `"YYYY-MM-DD HH:MM:SS"`
 * (UTC, no Z). The agent-runner uses the same default in outbound.db. Other
 * callers may insert full ISO with offset. Both must come out as ISO so the
 * dashboard parses with one `new Date(s)`.
 */
function normalizeTimestamp(s: string | null | undefined): string | null {
  if (!s) return null;
  // Already ISO?
  if (s.includes('T')) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  // SQLite "YYYY-MM-DD HH:MM:SS" — treat as UTC.
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function activityFor(agentGroupId: string, mgId: string, channelType: string | null): ActivityResponse {
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

    const nowMs = Date.now();
    const since24hMs = nowMs - 24 * 3600 * 1000;
    const since7dMs = nowMs - 7 * 24 * 3600 * 1000;

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
          const inRows = inDb
            .prepare(
              "SELECT id, content, timestamp FROM messages_in WHERE kind IN ('chat','chat-sdk') ORDER BY timestamp DESC LIMIT 100",
            )
            .all() as Array<{ id: string; content: string; timestamp: string }>;
          for (const r of inRows) {
            const iso = normalizeTimestamp(r.timestamp) ?? r.timestamp;
            const tsMs = Date.parse(iso);
            all.push({
              id: r.id,
              senderName: resolveInboundSenderName(r.content, channelType),
              content: previewContent(r.content),
              timestamp: iso,
              isFromBot: false,
              isFromMe: false,
            });
            if (Number.isFinite(tsMs)) {
              if (tsMs > since24hMs) count24h++;
              if (tsMs > since7dMs) count7d++;
            }
          }
        } finally {
          inDb.close();
        }
      }

      // Outbound (bot → user)
      if (fs.existsSync(outPath)) {
        const outDb = new Database(outPath, { readonly: true });
        try {
          const outRows = outDb
            .prepare(
              "SELECT id, content, timestamp FROM messages_out WHERE kind IN ('chat','chat-sdk') ORDER BY timestamp DESC LIMIT 100",
            )
            .all() as Array<{ id: string; content: string; timestamp: string }>;
          for (const r of outRows) {
            const iso = normalizeTimestamp(r.timestamp) ?? r.timestamp;
            const tsMs = Date.parse(iso);
            all.push({
              id: r.id,
              senderName: 'bot',
              content: previewContent(r.content),
              timestamp: iso,
              isFromBot: true,
              isFromMe: true,
            });
            if (Number.isFinite(tsMs)) {
              if (tsMs > since24hMs) count24h++;
              if (tsMs > since7dMs) count7d++;
            }
            if (!lastBot || iso > lastBot.timestamp) {
              lastBot = { content: previewContent(r.content), timestamp: iso };
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

function tailContainerLogs(agentGroupId: string, lines: number): string {
  const ps = spawnSync(
    CONTAINER_RUNTIME_BIN,
    ['ps', '--filter', `label=nanoclaw-agent-group-id=${agentGroupId}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  if (ps.status !== 0) return '';
  const name = (ps.stdout || '').trim().split('\n')[0];
  if (!name) return '';

  const logs = spawnSync(CONTAINER_RUNTIME_BIN, ['logs', '--tail', String(lines), name], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  // `logs` writes both stdout (app stdout) and stderr (app stderr) — concat.
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

  // POST /admin/agents — create a new WhatsApp group, persist wiring, return jid + invite link.
  // Body: { name: string, isolation?, folder?, agent_group_id?, engage_mode?, engage_pattern?,
  //         unknown_sender_policy?, assistant_name?, actor_user_id? }
  // Defaults to isolation="separate-agent" with folder derived from name (slugify).
  if (method === 'POST' && parts[0] === 'admin' && parts[1] === 'agents' && parts.length === 2) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'invalid_json' });
      return;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      send(res, 400, { error: 'name_required' });
      return;
    }

    // Resolve actor user. Body override > first global owner.
    let actorUserId = typeof body.actor_user_id === 'string' ? body.actor_user_id : '';
    if (!actorUserId) {
      const owners = getOwners();
      if (owners.length === 0) {
        send(res, 503, { error: 'no_global_owner_configured' });
        return;
      }
      actorUserId = owners[0].user_id;
    }

    // Default folder: slugify(name) when isolation=separate-agent (most common HTTP path).
    const isolation = (body.isolation as string | undefined) ?? 'separate-agent';
    let folder = typeof body.folder === 'string' ? body.folder.trim() : '';
    if (isolation === 'separate-agent' && !folder) {
      folder =
        `whatsapp_${name
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40)}` || `whatsapp_group_${Date.now()}`;
    }

    const result = await createGroupCore(
      {
        name,
        isolation: isolation as Parameters<typeof createGroupCore>[0]['isolation'],
        folder: folder || undefined,
        agent_group_id: typeof body.agent_group_id === 'string' ? body.agent_group_id : undefined,
        engage_mode: body.engage_mode as Parameters<typeof createGroupCore>[0]['engage_mode'],
        engage_pattern: body.engage_pattern as string | null | undefined,
        unknown_sender_policy: body.unknown_sender_policy as Parameters<
          typeof createGroupCore
        >[0]['unknown_sender_policy'],
        assistant_name: typeof body.assistant_name === 'string' ? body.assistant_name : undefined,
      },
      actorUserId,
    );

    if (!result.ok) {
      send(res, result.partial ? 502 : 400, {
        error: 'create_group_failed',
        message: result.error,
        partial: result.partial,
      });
      return;
    }

    // Build the same shape that GET /admin/agents/:jid returns so ghosty-studio
    // doesn't need a follow-up fetch.
    const resolved = resolveJid(result.platformId);
    const container = resolved ? readContainerConfig(resolved.agentGroup.folder) : null;
    send(res, 200, {
      jid: result.platformId,
      name,
      agent_group_id: result.agentGroupId,
      folder: result.folder,
      invite_link: result.inviteLink,
      isolation: result.isolation,
      ...(resolved ? publicAgent(result.platformId, resolved, container) : {}),
    });
    return;
  }

  // GET /admin/agents
  if (method === 'GET' && parts[0] === 'admin' && parts[1] === 'agents' && parts.length === 2) {
    const rows = getDb()
      .prepare(
        `
      SELECT mg.platform_id AS jid
        FROM messaging_groups mg
        JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       GROUP BY mg.id
       ORDER BY mg.created_at
    `,
      )
      .all() as Array<{ jid: string }>;
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
      send(res, 200, activityFor(resolved.agentGroup.id, resolved.mg.id, resolved.mg.channel_type));
      return;
    }

    // GET /admin/agents/:jid/invite-link
    if (method === 'GET' && parts.length === 4 && parts[3] === 'invite-link') {
      const adapter = getChannelAdapter('whatsapp');
      if (!adapter || !adapter.getInviteLink) {
        send(res, 503, { error: 'whatsapp_adapter_unavailable' });
        return;
      }
      if (!adapter.isConnected()) {
        send(res, 503, { error: 'whatsapp_adapter_disconnected' });
        return;
      }
      try {
        const link = await adapter.getInviteLink(jid);
        send(res, 200, { invite_link: link });
      } catch (err) {
        log.warn('getInviteLink failed', { jid, err: err instanceof Error ? err.message : String(err) });
        send(res, 502, {
          error: 'invite_link_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // GET /admin/agents/:jid/logs?tail=N
    if (method === 'GET' && parts.length === 4 && parts[3] === 'logs') {
      const requested = Number(url.searchParams.get('tail') ?? 200);
      const tail = Math.min(Math.max(Number.isFinite(requested) ? requested : 200, 1), 1000);
      send(res, 200, { logs: tailContainerLogs(resolved.agentGroup.id, tail) });
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

      const allowed = ['name', 'trigger', 'requiresTrigger', 'mcpServers', 'claudeMd'] as const;
      const supplied = allowed.filter((k) => k in body);
      if (supplied.length === 0) {
        send(res, 400, { error: 'no_supported_fields', allowed });
        return;
      }

      const ignored: string[] = [];
      let touchedFiles = false;
      let touchedDb = false;

      // name → agent_groups.name (display name shown in dashboard list)
      if (typeof body.name === 'string') {
        updateAgentGroup(resolved.agentGroup.id, { name: body.name });
        touchedDb = true;
      }

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
          getDb()
            .prepare("UPDATE messaging_group_agents SET engage_mode = 'mention' WHERE id = ?")
            .run(resolved.mga.id);
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
      // composed CLAUDE.md regenerated. DB-only changes (engage_mode, name)
      // are read by the host on every message — no restart needed.
      let restartedContainer = false;
      if (touchedFiles) {
        const ps = spawnSync(
          CONTAINER_RUNTIME_BIN,
          ['ps', '--filter', `label=nanoclaw-agent-group-id=${resolved.agentGroup.id}`, '--format', '{{.Names}}'],
          { encoding: 'utf8' },
        );
        const name = (ps.stdout || '').trim().split('\n').filter(Boolean)[0];
        if (name) {
          try {
            stopContainer(name);
            restartedContainer = true;
          } catch (e) {
            log.warn('Admin PATCH: failed to stop container', {
              name,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      // Echo the fresh detail so the dashboard doesn't have to re-fetch.
      const fresh = resolveJid(jid);
      const container = fresh ? readContainerConfig(fresh.agentGroup.folder) : null;
      const detail: DropletAgentDetail | null = fresh
        ? {
            ...publicAgent(jid, fresh, container),
            containerConfig: container,
            claudeMd: readClaudeMd(fresh.agentGroup.folder),
          }
        : null;

      send(res, 200, {
        ok: true,
        applied: supplied.filter((k) => !ignored.some((i) => i.startsWith(k))),
        ignored,
        restarted_container: restartedContainer,
        db_updated: touchedDb,
        detail,
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
    const startedAt = Date.now();
    res.on('finish', () => {
      log.info('admin', {
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });
    handle(req, res, cfg).catch((err) => {
      log.error('Admin handler threw', { url: req.url, err });
      try {
        send(res, 500, { error: 'internal' });
      } catch {
        /* response already sent */
      }
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
