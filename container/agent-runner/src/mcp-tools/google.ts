/**
 * Google Workspace MCP tool — `google_workspace_status`.
 *
 * Returns whether this agent_group has a connected Google account
 * (Gmail / Drive / Calendar via the native googleapis MCP servers).
 *
 * If not connected, returns a magic_link the agent should DM to the user
 * who initiated the request, so they can authorize their Workspace.
 *
 * The actual Gmail/Drive/Calendar tool calls are wired separately as
 * remote MCP servers in agent-runner config (part 4 of the integration).
 * This tool exists so the agent can decide before-the-fact whether to
 * proceed with a Google action or fall back to "send the magic link".
 */
import fs from 'fs';
import { loadConfig } from '../config.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/**
 * Sentinel watched by poll-loop.ts: when present at end-of-turn, the
 * container exits cleanly so the next inbound message spawns a fresh one
 * with up-to-date MCP wiring (Google access_token, scopes, etc.).
 */
const RESTART_SENTINEL_PATH = '/workspace/.restart-requested';

function requestRestartAfterTurn(): void {
  try {
    fs.writeFileSync(RESTART_SENTINEL_PATH, `oauth-link-sent ${new Date().toISOString()}\n`);
  } catch (e) {
    console.error(`[mcp-tools] failed to drop restart sentinel: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const DEFAULT_API_BASE = 'https://ghosty.studio';

function apiBase(): string {
  return process.env.GHOSTY_STUDIO_API_BASE?.trim() || DEFAULT_API_BASE;
}

function adminToken(): string | null {
  const t = process.env.NANOCLAW_ADMIN_TOKEN?.trim();
  return t || null;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

async function fetchAccessTokenStatus(
  agentGroupId: string,
  userId: string,
  token: string,
): Promise<
  | { connected: true; email: string; expiresAt: string }
  | { connected: false }
  | { error: string }
> {
  try {
    const url = `${apiBase()}/api/oauth/google/access-token?agent_group_id=${encodeURIComponent(agentGroupId)}&user_id=${encodeURIComponent(userId)}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 200) {
      const data = (await r.json()) as {
        access_token: string;
        expires_at: string;
        connected_email: string;
      };
      return { connected: true, email: data.connected_email, expiresAt: data.expires_at };
    }
    if (r.status === 404) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (data.error === 'needs_oauth') return { connected: false };
      return { error: `unexpected 404: ${JSON.stringify(data)}` };
    }
    if (r.status === 401) {
      return { error: 'NANOCLAW_ADMIN_TOKEN no autenticó contra ghosty.studio (¿se rotó?)' };
    }
    const body = await r.text().catch(() => '');
    return { error: `${r.status} ${body.slice(0, 200)}` };
  } catch (e: any) {
    return { error: `network: ${e?.message ?? String(e)}` };
  }
}

async function fetchOAuthLink(
  agentGroupId: string,
  initiatingUserId: string,
  token: string,
): Promise<{ link: string } | { error: string }> {
  try {
    const r = await fetch(`${apiBase()}/api/oauth/google/link`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        agent_group_id: agentGroupId,
        initiating_user_id: initiatingUserId,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { error: `${r.status} ${body.slice(0, 200)}` };
    }
    const data = (await r.json()) as { link: string };
    return { link: data.link };
  } catch (e: any) {
    return { error: `network: ${e?.message ?? String(e)}` };
  }
}

export const googleWorkspaceStatus: McpToolDefinition = {
  tool: {
    name: 'google_workspace_status',
    description:
      "Check whether a SPECIFIC user has connected their Google Workspace account in this agent group. Each user has their own credential — you cannot use someone else's. Call this BEFORE attempting any Google action *on behalf of* that user.\n\nReturns one of:\n  • { connected: true, email: \"x@y.com\" } — that user authorized; you can proceed with Gmail/Drive/Calendar tools using `as_user_id` set to the same value.\n  • { connected: false, magic_link: \"https://...\" } — the user hasn't authorized yet. SEND THE magic_link TO THAT USER VERBATIM (do not paraphrase the URL).\n\nThe magic_link is single-use and expires in 10 minutes. The link is scoped to that user — only their click will store credentials for them.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: {
          type: 'string',
          description:
            'User id whose Google account is being checked / connected. Required. Format "<channel>:<handle>", e.g. "whatsapp:5215512345678@s.whatsapp.net". Pass the from_user_id of the message that triggered this request — this is the user who will be acting (and who needs to be the one clicking the magic link).',
        },
      },
      required: ['as_user_id'],
    },
  },
  handler: async (args) => {
    const cfg = loadConfig();
    const agentGroupId = cfg.agentGroupId;
    if (!agentGroupId) {
      return err('agentGroupId no está en container.json — el host no lo escribió');
    }
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) {
      return err('as_user_id is required. Pass the from_user_id of the message that triggered this request.');
    }

    const token = adminToken();
    if (!token) {
      return err(
        'NANOCLAW_ADMIN_TOKEN no está disponible en el container. Verifica que el host lo pasó como env var (src/container-runner.ts) y que el .env del droplet lo tiene.',
      );
    }

    const status = await fetchAccessTokenStatus(agentGroupId, asUserId, token);
    if ('error' in status) return err(status.error);

    if (status.connected) {
      return ok(
        JSON.stringify(
          {
            connected: true,
            user_id: asUserId,
            email: status.email,
            access_token_expires_at: status.expiresAt,
          },
          null,
          2,
        ),
      );
    }

    const linkResult = await fetchOAuthLink(agentGroupId, asUserId, token);
    if ('error' in linkResult) return err(linkResult.error);

    // Drop the restart sentinel so the container exits cleanly at end of this
    // turn. The user's next message after authorizing spawns a fresh container
    // that wires Gmail/Drive/Calendar MCP servers at startup with the new
    // credential. Without this, the running container would keep its empty
    // Google MCP config until idle sweep (~60s) or a manual `docker stop`.
    requestRestartAfterTurn();
    log(`magic link generated for agent_group=${agentGroupId} user=${asUserId} (restart armed)`);

    return ok(
      JSON.stringify(
        {
          connected: false,
          user_id: asUserId,
          magic_link: linkResult.link,
          instructions:
            'Send the magic_link to THIS user (the one with id ' + asUserId + ') VERBATIM. The link is scoped to them — only their click stores their credentials. After they authorize, their next message wakes a fresh container with their tools available.',
        },
        null,
        2,
      ),
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Google REST API tools
// ─────────────────────────────────────────────────────────────────────────
//
// Google's official MCP servers (gmailmcp/drivemcp/calendarmcp) require
// enrollment in their Developer Preview Program. Until that's approved we
// hit the regular Google REST APIs directly with the same OAuth token —
// the token already has the right scopes (gmail.modify, drive, calendar)
// and the regular APIs work without preview enrollment.
//
// Each tool below:
//   1. Resolves the access_token via /api/oauth/google/access-token
//      (refreshes server-side if expired).
//   2. Calls the relevant googleapis.com REST endpoint.
//   3. Returns the parsed result, or a useful error message.
//
// The OneCLI proxy is bypassed for googleapis.com via NO_PROXY (set by
// the host in container-runner.ts) so the SSL handshake works directly.

async function getAccessToken(asUserId: string): Promise<
  { token: string; email: string } | { error: string; needsOauth?: { magicLink: string } }
> {
  const cfg = loadConfig();
  const agentGroupId = cfg.agentGroupId;
  if (!agentGroupId) return { error: 'agentGroupId missing in container.json' };
  const admin = adminToken();
  if (!admin) return { error: 'NANOCLAW_ADMIN_TOKEN missing in container env' };

  const url = `${apiBase()}/api/oauth/google/access-token?agent_group_id=${encodeURIComponent(agentGroupId)}&user_id=${encodeURIComponent(asUserId)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${admin}` } });
  if (r.status === 200) {
    const data = (await r.json()) as { access_token: string; connected_email: string };
    return { token: data.access_token, email: data.connected_email };
  }
  if (r.status === 404) {
    // User hasn't authorized — auto-fetch a magic link scoped to them and arm
    // a container restart so the agent can send it and wait for the next msg.
    const linkResult = await fetchOAuthLink(agentGroupId, asUserId, admin);
    if ('error' in linkResult) {
      return { error: `user ${asUserId} not connected and link generation failed: ${linkResult.error}` };
    }
    requestRestartAfterTurn();
    return {
      error: `user ${asUserId} has not connected Google Workspace yet. Send them this magic link verbatim (single-use, 10 min): ${linkResult.link}`,
      needsOauth: { magicLink: linkResult.link },
    };
  }
  const body = await r.text().catch(() => '');
  return { error: `access-token endpoint ${r.status}: ${body.slice(0, 200)}` };
}

async function googleApi<T = unknown>(
  asUserId: string,
  url: string,
  init: { method?: string; body?: string | object; query?: Record<string, string | number | undefined> } = {},
): Promise<T | { error: string }> {
  const auth = await getAccessToken(asUserId);
  if ('error' in auth) return { error: auth.error };

  let fullUrl = url;
  if (init.query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const qs = q.toString();
    if (qs) fullUrl += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json',
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    if (typeof init.body === 'string') {
      body = init.body;
      headers['Content-Type'] = headers['Content-Type'] ?? 'text/plain';
    } else {
      body = JSON.stringify(init.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  const r = await fetch(fullUrl, { method: init.method ?? 'GET', headers, body });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      msg = j.error?.message ?? j.error_description ?? msg;
    } catch {}
    return { error: `Google API ${r.status}: ${msg}` };
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

function asResult<T>(result: T | { error: string }) {
  if (typeof result === 'object' && result !== null && 'error' in result) {
    return err((result as { error: string }).error);
  }
  return ok(JSON.stringify(result, null, 2));
}

// ── Calendar ────────────────────────────────────────────────────────────

const calendarListEvents: McpToolDefinition = {
  tool: {
    name: 'calendar_list_events',
    description:
      "List events from a SPECIFIC user's primary Google Calendar (the user identified by `as_user_id`). Use for 'qué tengo agendado', 'mis juntas de mañana', 'eventos esta semana'.\n\nDates are interpreted in the user's timezone unless an offset is included. Defaults: timeMin=now, timeMax=now+7d, maxResults=20.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose calendar to list (the from_user_id of the message that asked). Required." },
        timeMin: { type: 'string', description: 'ISO 8601 timestamp (lower bound). Default: now.' },
        timeMax: { type: 'string', description: 'ISO 8601 timestamp (upper bound). Default: 7 days from now.' },
        q: { type: 'string', description: 'Free-text search across event fields (summary, description, location, attendees).' },
        maxResults: { type: 'integer', description: 'Max events to return. Default 20, hard cap 100.' },
        calendarId: { type: 'string', description: "Calendar id. Default: 'primary'." },
      },
      required: ['as_user_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required (the from_user_id of who is asking)');
    const calendarId = (args.calendarId as string) || 'primary';
    const timeMin = (args.timeMin as string) || new Date().toISOString();
    const timeMax = (args.timeMax as string) || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const maxResults = Math.min(Number(args.maxResults) || 20, 100);
    const result = await googleApi<{ items: unknown[] }>(
      asUserId,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        query: {
          timeMin,
          timeMax,
          maxResults,
          singleEvents: 'true',
          orderBy: 'startTime',
          q: args.q as string | undefined,
        },
      },
    );
    if ('error' in result) return err(result.error);
    const items = (result.items ?? []) as Array<{
      id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
      location?: string; htmlLink?: string; attendees?: Array<{ email: string; responseStatus?: string }>;
    }>;
    return ok(JSON.stringify({
      count: items.length,
      events: items.map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        location: e.location,
        attendees: e.attendees?.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`),
        link: e.htmlLink,
      })),
    }, null, 2));
  },
};

const calendarCreateEvent: McpToolDefinition = {
  tool: {
    name: 'calendar_create_event',
    description:
      "Create an event in a SPECIFIC user's primary Google Calendar (the user identified by `as_user_id`). Use for 'agenda X', 'crea un evento Y'.\n\nDateTimes should include offset or you must pass `timeZone`. The user's local timezone is in the <context timezone='...'/> header.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose calendar to create the event in. Required." },
        summary: { type: 'string', description: 'Event title.' },
        startTime: { type: 'string', description: "ISO 8601 datetime, e.g. '2026-04-26T09:00:00' (with timeZone) or '2026-04-26T09:00:00-06:00' (with offset)." },
        endTime: { type: 'string', description: "ISO 8601. If omitted, defaults to startTime + 30min." },
        description: { type: 'string', description: 'Long-form notes/agenda.' },
        location: { type: 'string', description: 'Physical or virtual location.' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attendee email addresses to invite.',
        },
        calendarId: { type: 'string', description: "Calendar id. Default: 'primary'." },
        timeZone: { type: 'string', description: "IANA timezone for start/end (e.g. 'America/Mexico_City', 'UTC'). Default: 'America/Mexico_City'. ALWAYS pass this — the container runs UTC and a naive dateTime will otherwise be saved 6h off." },
      },
      required: ['as_user_id', 'summary', 'startTime'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const calendarId = (args.calendarId as string) || 'primary';
    const start = args.startTime as string;
    if (!start) return err('startTime is required');
    const end = (args.endTime as string) || new Date(new Date(start).getTime() + 30 * 60 * 1000).toISOString();
    const timeZone = (args.timeZone as string) || 'America/Mexico_City';
    const body: Record<string, unknown> = {
      summary: args.summary,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
    };
    if (args.description) body.description = args.description;
    if (args.location) body.location = args.location;
    if (Array.isArray(args.attendees)) body.attendees = (args.attendees as string[]).map((email) => ({ email }));

    const result = await googleApi<{ id: string; htmlLink: string; summary: string; start: unknown; end: unknown }>(
      asUserId,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', body },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({
      created: true,
      id: result.id,
      summary: result.summary,
      start: result.start,
      end: result.end,
      link: result.htmlLink,
    }, null, 2));
  },
};

// ── Gmail ───────────────────────────────────────────────────────────────

function buildRfc2822(input: { to: string; subject: string; body: string; cc?: string; bcc?: string; bodyHtml?: string; from?: string }): string {
  const lines: string[] = [];
  if (input.from) lines.push(`From: ${input.from}`);
  lines.push(`To: ${input.to}`);
  if (input.cc) lines.push(`Cc: ${input.cc}`);
  if (input.bcc) lines.push(`Bcc: ${input.bcc}`);
  lines.push(`Subject: ${encodeMimeHeader(input.subject)}`);
  lines.push('MIME-Version: 1.0');
  if (input.bodyHtml) {
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('');
    lines.push(input.bodyHtml);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('');
    lines.push(input.body);
  }
  return lines.join('\r\n');
}

function encodeMimeHeader(s: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects.
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const gmailSend: McpToolDefinition = {
  tool: {
    name: 'gmail_send',
    description:
      "Send an email FROM a SPECIFIC user's connected Gmail account (the user identified by `as_user_id`). The 'From' header is automatically that user's email — you do NOT pick a sender.\n\nUse for 'manda un correo a X', 'envía un email diciendo Y'. For long messages, prefer plain text via `body`. Use `bodyHtml` only if the user asked for formatting.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Gmail account to send FROM (the from_user_id of the message that asked). Required." },
        to: { type: 'string', description: 'Recipient email(s), comma-separated for multiple.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text body. Required unless bodyHtml is provided.' },
        bodyHtml: { type: 'string', description: 'HTML body (alternative to body). Use sparingly.' },
        cc: { type: 'string', description: 'Cc recipients, comma-separated.' },
        bcc: { type: 'string', description: 'Bcc recipients, comma-separated.' },
      },
      required: ['as_user_id', 'to', 'subject'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const to = args.to as string;
    const subject = (args.subject as string) ?? '';
    const body = (args.body as string) ?? '';
    const bodyHtml = args.bodyHtml as string | undefined;
    if (!to) return err('to is required');
    if (!body && !bodyHtml) return err('body or bodyHtml is required');

    const auth = await getAccessToken(asUserId);
    if ('error' in auth) return err(auth.error);

    const mime = buildRfc2822({
      to,
      subject,
      body,
      bodyHtml,
      cc: args.cc as string | undefined,
      bcc: args.bcc as string | undefined,
      from: auth.email,
    });

    const result = await googleApi<{ id: string; threadId: string; labelIds: string[] }>(
      asUserId,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { method: 'POST', body: { raw: b64url(mime) } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({
      sent: true,
      from: auth.email,
      to,
      subject,
      gmail_message_id: result.id,
      thread_id: result.threadId,
    }, null, 2));
  },
};

const gmailSearch: McpToolDefinition = {
  tool: {
    name: 'gmail_search',
    description:
      "Search a SPECIFIC user's Gmail and return a summary list (sender, subject, snippet, date) for the first N matches. Use Gmail's search syntax: 'from:juan', 'subject:reporte', 'is:unread', 'after:2026/04/20', etc.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Gmail to search (the from_user_id of the message that asked). Required." },
        q: { type: 'string', description: "Gmail query string (e.g. 'from:boss is:unread')." },
        maxResults: { type: 'integer', description: 'Max results. Default 10, cap 25.' },
      },
      required: ['as_user_id', 'q'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const q = args.q as string;
    if (!q) return err('q is required');
    const maxResults = Math.min(Number(args.maxResults) || 10, 25);

    const list = await googleApi<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(
      asUserId,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
      { query: { q, maxResults } },
    );
    if ('error' in list) return err(list.error);
    const ids = (list.messages ?? []).map((m) => m.id);
    if (ids.length === 0) return ok(JSON.stringify({ count: 0, messages: [] }));

    const messages = await Promise.all(
      ids.map((id) =>
        googleApi<{
          id: string; snippet: string; payload: { headers: Array<{ name: string; value: string }> };
          internalDate: string; labelIds?: string[];
        }>(asUserId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, {
          query: { format: 'metadata', 'metadataHeaders': 'From,Subject,Date,To' as never },
        }),
      ),
    );

    const formatted = messages.map((m) => {
      if ('error' in m) return { error: m.error };
      const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value;
      return {
        id: m.id,
        from: h('From'),
        to: h('To'),
        subject: h('Subject'),
        date: h('Date'),
        snippet: m.snippet,
        unread: m.labelIds?.includes('UNREAD') ?? false,
      };
    });

    return ok(JSON.stringify({ count: formatted.length, messages: formatted }, null, 2));
  },
};

// ── Drive ───────────────────────────────────────────────────────────────

const driveSearch: McpToolDefinition = {
  tool: {
    name: 'drive_search',
    description:
      "Search a SPECIFIC user's Google Drive. Returns file id, name, mimeType, modifiedTime, webViewLink.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Drive to search (the from_user_id of the message that asked). Required." },
        q: { type: 'string', description: "Drive query string." },
        maxResults: { type: 'integer', description: 'Max results. Default 10, cap 50.' },
      },
      required: ['as_user_id', 'q'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const q = args.q as string;
    if (!q) return err('q is required');
    const maxResults = Math.min(Number(args.maxResults) || 10, 50);

    const result = await googleApi<{ files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink: string }> }>(
      asUserId,
      'https://www.googleapis.com/drive/v3/files',
      {
        query: {
          q,
          pageSize: maxResults,
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
        },
      },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({ count: (result.files ?? []).length, files: result.files ?? [] }, null, 2));
  },
};

registerTools([googleWorkspaceStatus, calendarListEvents, calendarCreateEvent, gmailSend, gmailSearch, driveSearch]);
