/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

const GOOGLE_MCP_ENDPOINTS: Record<string, string> = {
  gmail: 'https://gmailmcp.googleapis.com/mcp/v1',
  drive: 'https://drivemcp.googleapis.com/mcp/v1',
  calendar: 'https://calendarmcp.googleapis.com/mcp/v1',
};

async function wireGoogleWorkspaceMcps(
  mcpServers: Record<string, McpServerConfig>,
  agentGroupId: string,
): Promise<void> {
  if (!agentGroupId) {
    log('Google Workspace: skipped (agentGroupId missing in container.json)');
    return;
  }
  const adminToken = process.env.NANOCLAW_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    log('Google Workspace: skipped (NANOCLAW_ADMIN_TOKEN missing in container env)');
    return;
  }
  const apiBase = (process.env.GHOSTY_STUDIO_API_BASE?.trim() || 'https://ghosty.studio').replace(/\/+$/, '');

  let result: { access_token: string; connected_email: string } | null = null;
  try {
    const r = await fetch(
      `${apiBase}/api/oauth/google/access-token?agent_group_id=${encodeURIComponent(agentGroupId)}`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    if (r.status === 200) {
      result = (await r.json()) as { access_token: string; connected_email: string };
    } else if (r.status === 404) {
      log('Google Workspace: not connected for this agent group (use google_workspace_status to onboard)');
      return;
    } else {
      const body = await r.text().catch(() => '');
      log(`Google Workspace: skip — access-token endpoint ${r.status}: ${body.slice(0, 200)}`);
      return;
    }
  } catch (err) {
    log(`Google Workspace: skip — network error fetching access_token: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!result) return;

  const headers = { Authorization: `Bearer ${result.access_token}` };
  for (const [name, url] of Object.entries(GOOGLE_MCP_ENDPOINTS)) {
    mcpServers[name] = { type: 'http', url, headers };
  }
  log(`Google Workspace: wired ${Object.keys(GOOGLE_MCP_ENDPOINTS).join(', ')} as ${result.connected_email}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    easybits: {
      command: 'npx',
      args: ['-y', '@easybits.cloud/mcp', '--tools', process.env.EASYBITS_TOOLSETS || 'core,design,websites,forms'],
      env: { EASYBITS_API_KEY: process.env.EASYBITS_API_KEY || '' },
    },
    brightdata: {
      command: 'npx',
      args: ['-y', '@brightdata/mcp'],
      env: {
        // BrightData MCP reads API_TOKEN from env at startup (it's not an
        // HTTP-injected credential), so OneCLI's gateway can't supply it.
        API_TOKEN: process.env.BRIGHTDATA_API_TOKEN || '',
        // GROUPS gates which tool families BrightData exposes. Without
        // `social`, LinkedIn/X/IG scraping returns 400. Match v1's set.
        GROUPS: 'geo,social,business,ecommerce,finance',
        // Bypass OneCLI MITM proxy for BrightData API. The MCP MUST connect
        // directly to api.brightdata.com — going through OneCLI's self-signed
        // cert breaks SSL handshake (NODE_EXTRA_CA_CERTS file not always
        // present). v1 ran without proxy entirely; this matches that behavior
        // for just the BD endpoints while preserving proxy for other traffic.
        NO_PROXY: 'api.brightdata.com,brightdata.com',
        no_proxy: 'api.brightdata.com,brightdata.com',
      },
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  // Google Workspace: native MCP servers (gmail/drive/calendar.mcp.googleapis.com)
  // are gated by Google's Developer Preview Program. While we wait for that
  // approval, the agent uses REST-API-backed MCP tools (calendar_list_events,
  // calendar_create_event, gmail_send, etc.) registered by mcp-tools/google.ts.
  // When preview is granted, uncomment the line below to swap to native MCPs:
  //   await wireGoogleWorkspaceMcps(mcpServers, config.agentGroupId);

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
