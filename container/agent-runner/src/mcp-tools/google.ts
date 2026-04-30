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

    // 403 with insufficient-scope: token is valid but doesn't cover this API
    // (typical after we add new scopes — refresh tokens keep the OLD scope set).
    // Auto-generate a fresh magic link so the user can re-authorize, then arm
    // a container restart so the new credentials take effect on next message.
    if (r.status === 403 && /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) {
      const cfg = loadConfig();
      const ag = cfg.agentGroupId;
      const admin = adminToken();
      if (ag && admin) {
        const linkResult = await fetchOAuthLink(ag, asUserId, admin);
        if (!('error' in linkResult)) {
          requestRestartAfterTurn();
          return {
            error: `Your Google authorization is missing scopes for this action. Send the user this magic link VERBATIM so they can re-authorize (1 click, 10 min expiry): ${linkResult.link}`,
          };
        }
      }
    }

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
      "Create an event in a SPECIFIC user's primary Google Calendar (the user identified by `as_user_id`). Use for 'agenda X', 'crea un evento Y'.\n\nDateTimes should include offset or you must pass `timeZone`. The user's local timezone is in the <context timezone='...'/> header.\n\nThe tool response includes a `link` (htmlLink to the event). YOU MUST include that link verbatim in your chat reply — the user wants it to tap-confirm/edit. Format your reply like: 'Listo ✅ Evento: <summary> <hora> (<TZ>)\\n🔗 <link>'.",
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
        add_meet: { type: 'boolean', description: "If true, Google generates a Meet video link and attaches it to the event. The response includes `meet_link`. Default: false." },
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

    const query: Record<string, string | number | undefined> = { sendUpdates: 'all' };
    if (args.add_meet) {
      body.conferenceData = {
        createRequest: {
          requestId: `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
      query.conferenceDataVersion = 1;
    }

    // sendUpdates=all → Google emails attendees when an event is created with
    // them on the invite list. Default in the REST API is 'none' which is why
    // attendees weren't getting any notification.
    const result = await googleApi<{ id: string; htmlLink: string; summary: string; start: unknown; end: unknown; hangoutLink?: string; conferenceData?: { entryPoints?: Array<{ entryPointType: string; uri: string }> } }>(
      asUserId,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', body, query },
    );
    if ('error' in result) return err(result.error);
    const meetLink = result.hangoutLink ?? result.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
    return ok(JSON.stringify({
      created: true,
      id: result.id,
      summary: result.summary,
      start: result.start,
      end: result.end,
      link: result.htmlLink,
      meet_link: meetLink,
    }, null, 2));
  },
};

const calendarUpdateEvent: McpToolDefinition = {
  tool: {
    name: 'calendar_update_event',
    description:
      "Update an existing event in `as_user_id`'s primary calendar. Pass only the fields you want to change. To ADD attendees without dropping existing ones, use `attendees_add` (the tool fetches the event first and merges). To REPLACE the entire attendee list, use `attendees`. Returns the updated event with `link`.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose calendar holds the event. Required." },
        event_id: { type: 'string', description: "The event id (returned by calendar_create_event or list_events)." },
        summary: { type: 'string', description: 'New event title.' },
        startTime: { type: 'string', description: "New ISO 8601 start. If you set this, also set timeZone." },
        endTime: { type: 'string', description: "New ISO 8601 end." },
        description: { type: 'string', description: 'New description.' },
        location: { type: 'string', description: 'New location.' },
        attendees_add: { type: 'array', items: { type: 'string' }, description: 'Emails to ADD to the existing invitee list (does NOT remove existing).' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'REPLACE the full attendee list with these emails. Use only when explicitly told to drop everyone else.' },
        calendarId: { type: 'string', description: "Calendar id. Default: 'primary'." },
        timeZone: { type: 'string', description: "IANA timezone. Default: 'America/Mexico_City'." },
        add_meet: { type: 'boolean', description: "If true, add a Meet link to the event. Response includes `meet_link`." },
      },
      required: ['as_user_id', 'event_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const eventId = (args.event_id as string | undefined)?.trim();
    if (!eventId) return err('event_id is required');
    const calendarId = (args.calendarId as string) || 'primary';
    const timeZone = (args.timeZone as string) || 'America/Mexico_City';

    const body: Record<string, unknown> = {};
    if (args.summary) body.summary = args.summary;
    if (args.description) body.description = args.description;
    if (args.location) body.location = args.location;
    if (args.startTime) body.start = { dateTime: args.startTime as string, timeZone };
    if (args.endTime) body.end = { dateTime: args.endTime as string, timeZone };

    if (Array.isArray(args.attendees)) {
      body.attendees = (args.attendees as string[]).map((email) => ({ email }));
    } else if (Array.isArray(args.attendees_add) && (args.attendees_add as string[]).length > 0) {
      const existing = await googleApi<{ attendees?: Array<{ email: string }> }>(
        asUserId,
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      if ('error' in existing) return err(`fetch existing event: ${existing.error}`);
      const current = (existing.attendees ?? []).map((a) => a.email);
      const toAdd = (args.attendees_add as string[]).filter((e) => !current.includes(e));
      body.attendees = [...current, ...toAdd].map((email) => ({ email }));
    }

    const query: Record<string, string | number | undefined> = { sendUpdates: 'all' };
    if (args.add_meet) {
      body.conferenceData = {
        createRequest: {
          requestId: `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
      query.conferenceDataVersion = 1;
    }

    if (Object.keys(body).length === 0) {
      return err('nothing to update — pass at least one of: summary, startTime, endTime, description, location, attendees_add, attendees, add_meet');
    }

    // sendUpdates=all → emails attendees about the change (new invitees get
    // their first invitation, existing ones get the update notification).
    const result = await googleApi<{ id: string; htmlLink: string; summary: string; start: unknown; end: unknown; attendees?: Array<{ email: string }>; hangoutLink?: string; conferenceData?: { entryPoints?: Array<{ entryPointType: string; uri: string }> } }>(
      asUserId,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'PATCH', body, query },
    );
    if ('error' in result) return err(result.error);
    const meetLink = result.hangoutLink ?? result.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
    return ok(JSON.stringify({
      updated: true,
      id: result.id,
      summary: result.summary,
      start: result.start,
      end: result.end,
      attendees: (result.attendees ?? []).map((a) => a.email),
      link: result.htmlLink,
      meet_link: meetLink,
    }, null, 2));
  },
};

const calendarDeleteEvent: McpToolDefinition = {
  tool: {
    name: 'calendar_delete_event',
    description:
      "Delete an event from `as_user_id`'s primary calendar. Irreversible. Confirm with the user before calling unless they explicitly said 'borra/elimina/cancela el evento'.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose calendar holds the event. Required." },
        event_id: { type: 'string', description: "The event id." },
        calendarId: { type: 'string', description: "Calendar id. Default: 'primary'." },
      },
      required: ['as_user_id', 'event_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const eventId = (args.event_id as string | undefined)?.trim();
    if (!eventId) return err('event_id is required');
    const calendarId = (args.calendarId as string) || 'primary';

    // sendUpdates=all → notify attendees that the event was cancelled.
    const result = await googleApi(
      asUserId,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', query: { sendUpdates: 'all' } },
    );
    if (typeof result === 'object' && result !== null && 'error' in result) return err((result as { error: string }).error);
    return ok(JSON.stringify({ deleted: true, event_id: eventId }, null, 2));
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

function decodeBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

function extractGmailBody(payload: GmailPart): { plain: string; html: string } {
  let plain = '';
  let html = '';
  const walk = (p: GmailPart) => {
    if (p.body?.data) {
      const text = decodeBase64Url(p.body.data).toString('utf8');
      if (p.mimeType === 'text/plain' && !plain) plain = text;
      else if (p.mimeType === 'text/html' && !html) html = text;
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  return { plain, html };
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const gmailReadMessage: McpToolDefinition = {
  tool: {
    name: 'gmail_read_message',
    description:
      "Fetch the FULL body of a Gmail message. Use after `gmail_search` when the user wants 'lee el correo de juan', 'qué dice ese mail'. Returns from, to, subject, date, body (plain text preferred, HTML stripped to text as fallback), threadId.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Gmail to read. Required." },
        message_id: { type: 'string', description: 'Gmail message id (from gmail_search results).' },
      },
      required: ['as_user_id', 'message_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const messageId = (args.message_id as string | undefined)?.trim();
    if (!messageId) return err('message_id is required');
    const msg = await googleApi<{
      id: string; threadId: string; snippet: string; labelIds?: string[];
      payload: GmailPart;
    }>(asUserId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`, {
      query: { format: 'full' },
    });
    if ('error' in msg) return err(msg.error);
    const headers = msg.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value;
    const { plain, html } = extractGmailBody(msg.payload);
    const body = plain || (html ? htmlToText(html) : '');
    return ok(JSON.stringify({
      id: msg.id,
      thread_id: msg.threadId,
      from: h('From'),
      to: h('To'),
      cc: h('Cc'),
      subject: h('Subject'),
      date: h('Date'),
      unread: msg.labelIds?.includes('UNREAD') ?? false,
      labels: msg.labelIds ?? [],
      body,
    }, null, 2));
  },
};

const gmailReply: McpToolDefinition = {
  tool: {
    name: 'gmail_reply',
    description:
      "Reply to a Gmail message in its existing thread (preserves threadId, In-Reply-To, References). Subject auto-prefixed with 'Re: ' if needed. With `reply_all=true`, includes original To/Cc minus the user's own address.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Gmail to send from. Required." },
        message_id: { type: 'string', description: 'Message id being replied to.' },
        body: { type: 'string', description: 'Plain-text reply body. Required unless bodyHtml.' },
        bodyHtml: { type: 'string' },
        reply_all: { type: 'boolean', description: 'Default false (just original sender).' },
      },
      required: ['as_user_id', 'message_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const messageId = (args.message_id as string | undefined)?.trim();
    if (!messageId) return err('message_id is required');
    const body = (args.body as string) ?? '';
    const bodyHtml = args.bodyHtml as string | undefined;
    if (!body && !bodyHtml) return err('body or bodyHtml is required');

    const orig = await googleApi<{
      id: string; threadId: string; payload: GmailPart;
    }>(asUserId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`, {
      query: { format: 'metadata', metadataHeaders: 'From,To,Cc,Subject,Message-ID,References' as never },
    });
    if ('error' in orig) return err(orig.error);
    const headers = orig.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value;
    const origFrom = h('From') ?? '';
    const origTo = h('To') ?? '';
    const origCc = h('Cc') ?? '';
    const origSubject = h('Subject') ?? '';
    const origMessageId = h('Message-ID') ?? h('Message-Id') ?? '';
    const origRefs = h('References') ?? '';

    const auth = await getAccessToken(asUserId);
    if ('error' in auth) return err(auth.error);

    const stripEmail = (raw: string): string => {
      const m = raw.match(/<([^>]+)>/);
      return (m ? m[1] : raw).trim().toLowerCase();
    };
    const splitEmails = (s: string): string[] =>
      s.split(',').map((x) => x.trim()).filter(Boolean);
    const myEmail = auth.email.toLowerCase();
    const replyAll = Boolean(args.reply_all);

    const toList = [origFrom];
    let ccList: string[] = [];
    if (replyAll) {
      const extras = [...splitEmails(origTo), ...splitEmails(origCc)].filter(
        (addr) => stripEmail(addr) !== myEmail && stripEmail(addr) !== stripEmail(origFrom),
      );
      ccList = extras;
    }

    const subject = origSubject.toLowerCase().startsWith('re:') ? origSubject : `Re: ${origSubject}`;
    const refs = origRefs ? `${origRefs} ${origMessageId}`.trim() : origMessageId;

    const lines: string[] = [];
    lines.push(`From: ${auth.email}`);
    lines.push(`To: ${toList.join(', ')}`);
    if (ccList.length > 0) lines.push(`Cc: ${ccList.join(', ')}`);
    lines.push(`Subject: ${encodeMimeHeader(subject)}`);
    if (origMessageId) lines.push(`In-Reply-To: ${origMessageId}`);
    if (refs) lines.push(`References: ${refs}`);
    lines.push('MIME-Version: 1.0');
    if (bodyHtml) {
      lines.push('Content-Type: text/html; charset="UTF-8"');
      lines.push('');
      lines.push(bodyHtml);
    } else {
      lines.push('Content-Type: text/plain; charset="UTF-8"');
      lines.push('');
      lines.push(body);
    }
    const mime = lines.join('\r\n');

    const result = await googleApi<{ id: string; threadId: string }>(
      asUserId,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { method: 'POST', body: { raw: b64url(mime), threadId: orig.threadId } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({
      replied: true,
      from: auth.email,
      to: toList,
      cc: ccList,
      subject,
      thread_id: result.threadId,
      gmail_message_id: result.id,
    }, null, 2));
  },
};

const gmailModifyLabels: McpToolDefinition = {
  tool: {
    name: 'gmail_modify_labels',
    description:
      "Add or remove labels on a Gmail message. Common patterns:\n- Mark as read: `removeLabelIds=['UNREAD']`\n- Mark as unread: `addLabelIds=['UNREAD']`\n- Archive (remove from inbox): `removeLabelIds=['INBOX']`\n- Move to trash: `addLabelIds=['TRASH']`\n- Star: `addLabelIds=['STARRED']`\n- Unstar: `removeLabelIds=['STARRED']`\n\nSystem labels: INBOX, UNREAD, STARRED, IMPORTANT, SENT, TRASH, SPAM, DRAFT.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Gmail to modify. Required." },
        message_id: { type: 'string' },
        addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to add.' },
        removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to remove.' },
      },
      required: ['as_user_id', 'message_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const messageId = (args.message_id as string | undefined)?.trim();
    if (!messageId) return err('message_id is required');
    const addLabelIds = Array.isArray(args.addLabelIds) ? (args.addLabelIds as string[]) : [];
    const removeLabelIds = Array.isArray(args.removeLabelIds) ? (args.removeLabelIds as string[]) : [];
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      return err('pass at least one of addLabelIds, removeLabelIds');
    }
    const result = await googleApi<{ id: string; labelIds?: string[] }>(
      asUserId,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      { method: 'POST', body: { addLabelIds, removeLabelIds } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({ modified: true, id: result.id, labels: result.labelIds ?? [] }, null, 2));
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

function extractDriveFileId(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/\/(?:file\/d|folders|document\/d|presentation\/d|spreadsheets\/d)\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : trimmed;
}

const driveDownload: McpToolDefinition = {
  tool: {
    name: 'drive_download',
    description:
      "Download a Drive file into the workspace and return the local path. Use after `drive_search` finds the file. For binary files (PDFs, images, videos, .xlsx, .docx) just pass `file_id`. For native Google types (Docs/Sheets/Slides) you MUST pass `export_mime` — the file isn't a downloadable blob, it has to be exported. Common export MIMEs:\n- Docs → `application/pdf` or `text/plain` or `application/vnd.openxmlformats-officedocument.wordprocessingml.document`\n- Sheets → `text/csv` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`\n- Slides → `application/pdf` or `application/vnd.openxmlformats-officedocument.presentationml.presentation`\n\nAfter downloading, send to the chat via `mcp__nanoclaw__send_file({ path })`.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Drive file to download. Required." },
        file_id: { type: 'string', description: 'Drive file id (from drive_search) or full Drive URL.' },
        export_mime: { type: 'string', description: 'Required for native Google types (Docs/Sheets/Slides). Omit for binary files.' },
        save_as: { type: 'string', description: 'Override filename. Default: original Drive name (with extension matching export_mime if applicable).' },
      },
      required: ['as_user_id', 'file_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const rawId = (args.file_id as string | undefined)?.trim();
    if (!rawId) return err('file_id is required');
    const fileId = extractDriveFileId(rawId);
    const exportMime = (args.export_mime as string | undefined)?.trim();
    const saveAs = (args.save_as as string | undefined)?.trim();

    const meta = await googleApi<{ id: string; name: string; mimeType: string }>(
      asUserId,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      { query: { fields: 'id,name,mimeType' } },
    );
    if ('error' in meta) return err(meta.error);

    const isNative = meta.mimeType.startsWith('application/vnd.google-apps.');
    if (isNative && !exportMime) {
      return err(`File is a native Google type (${meta.mimeType}). Pass export_mime (e.g. 'application/pdf', 'text/plain', 'text/csv').`);
    }

    const auth = await getAccessToken(asUserId);
    if ('error' in auth) return err(auth.error);

    const url = isNative
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime!)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return err(`Drive ${r.status}: ${body.slice(0, 300)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());

    const extFromMime = (mime: string): string => {
      const map: Record<string, string> = {
        'application/pdf': '.pdf',
        'text/plain': '.txt',
        'text/csv': '.csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      };
      return map[mime] ?? '';
    };

    let filename = saveAs || meta.name;
    if (isNative && !saveAs) filename = meta.name + extFromMime(exportMime!);
    const dir = '/workspace/agent';
    fs.mkdirSync(dir, { recursive: true });
    const safeName = filename.replace(/[\/\x00]/g, '_');
    const fullPath = `${dir}/${safeName}`;
    fs.writeFileSync(fullPath, buf);
    return ok(JSON.stringify({
      downloaded: true,
      path: fullPath,
      bytes: buf.length,
      drive_file_id: fileId,
      original_name: meta.name,
      original_mime: meta.mimeType,
      exported_as: exportMime,
    }, null, 2));
  },
};

const driveUpload: McpToolDefinition = {
  tool: {
    name: 'drive_upload',
    description:
      "Upload a local workspace file to Drive. Returns new file id + webViewLink. Optional `parent_folder_id` to drop it inside a specific folder (default: root). After upload, use `drive_share` to give others access.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Drive to upload to. Required." },
        local_path: { type: 'string', description: 'Path of the file inside the container (typically /workspace/agent/...).' },
        name: { type: 'string', description: 'Drive filename. Default: basename of local_path.' },
        parent_folder_id: { type: 'string', description: 'Drive folder id to upload into. Default: My Drive root.' },
        mime_type: { type: 'string', description: 'Override MIME type. Default: auto-detected from extension.' },
      },
      required: ['as_user_id', 'local_path'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const localPath = (args.local_path as string | undefined)?.trim();
    if (!localPath) return err('local_path is required');
    if (!fs.existsSync(localPath)) return err(`local_path does not exist: ${localPath}`);

    const buf = fs.readFileSync(localPath);
    const filename = (args.name as string | undefined)?.trim() || localPath.split('/').pop() || 'upload';
    const parentFolderId = (args.parent_folder_id as string | undefined)?.trim();
    const mimeType = (args.mime_type as string | undefined)?.trim() || mimeFromExt(filename);

    const auth = await getAccessToken(asUserId);
    if ('error' in auth) return err(auth.error);

    const metadata: Record<string, unknown> = { name: filename };
    if (parentFolderId) metadata.parents = [extractDriveFileId(parentFolderId)];

    const boundary = `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buf, tail]);

    const r = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      },
    );
    const text = await r.text();
    if (!r.ok) return err(`Drive upload ${r.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text) as { id: string; name: string; mimeType: string; webViewLink: string; parents?: string[] };
    return ok(JSON.stringify({
      uploaded: true,
      id: data.id,
      name: data.name,
      mimeType: data.mimeType,
      link: data.webViewLink,
      parents: data.parents,
      bytes: buf.length,
    }, null, 2));
  },
};

function mimeFromExt(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    md: 'text/markdown', html: 'text/html', xml: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

const driveShare: McpToolDefinition = {
  tool: {
    name: 'drive_share',
    description:
      "Add a permission on a Drive file/folder, granting an email a role. Roles: 'reader', 'commenter', 'writer'. Default `notify=true` so Google emails the recipient. Use `message` to add a custom note. To share with the public via link, pass `email=''` and `share_with='anyone'`.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose file to share. Required." },
        file_id: { type: 'string', description: 'Drive file or folder id (or URL).' },
        email: { type: 'string', description: 'Recipient email. Required unless share_with=anyone.' },
        role: { type: 'string', enum: ['reader', 'commenter', 'writer'], description: "Role to grant. Default: 'writer'." },
        notify: { type: 'boolean', description: 'Send email notification. Default: true.' },
        message: { type: 'string', description: 'Custom note included in the notification email.' },
        share_with: { type: 'string', enum: ['user', 'anyone'], description: "Default 'user'. Use 'anyone' to make the file accessible by link to anyone." },
      },
      required: ['as_user_id', 'file_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const fileId = extractDriveFileId((args.file_id as string | undefined)?.trim() || '');
    if (!fileId) return err('file_id is required');
    const role = (args.role as string) || 'writer';
    const shareWith = (args.share_with as string) || 'user';
    const notify = args.notify === undefined ? true : Boolean(args.notify);
    const email = (args.email as string | undefined)?.trim();
    if (shareWith === 'user' && !email) return err('email is required when share_with=user');

    const body: Record<string, unknown> = { role, type: shareWith };
    if (shareWith === 'user') body.emailAddress = email;

    const query: Record<string, string | number | undefined> = {
      sendNotificationEmail: notify ? 'true' : 'false',
      fields: 'id,role,type,emailAddress',
    };
    if (notify && args.message) query.emailMessage = args.message as string;

    const result = await googleApi<{ id: string; role: string; type: string; emailAddress?: string }>(
      asUserId,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`,
      { method: 'POST', body, query },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({
      shared: true,
      file_id: fileId,
      permission_id: result.id,
      role: result.role,
      grantee: result.emailAddress ?? result.type,
    }, null, 2));
  },
};

const driveCreateFolder: McpToolDefinition = {
  tool: {
    name: 'drive_create_folder',
    description: "Create a folder in Drive. Returns the new folder's id + webViewLink. Optional `parent_folder_id` to nest. Use the returned id as `parent_folder_id` in `drive_upload` / `drive_move`.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Drive to create folder in. Required." },
        name: { type: 'string', description: 'Folder name.' },
        parent_folder_id: { type: 'string', description: 'Parent folder id. Default: My Drive root.' },
      },
      required: ['as_user_id', 'name'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const name = (args.name as string | undefined)?.trim();
    if (!name) return err('name is required');
    const parentFolderId = (args.parent_folder_id as string | undefined)?.trim();
    const body: Record<string, unknown> = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentFolderId) body.parents = [extractDriveFileId(parentFolderId)];
    const result = await googleApi<{ id: string; name: string; webViewLink: string }>(
      asUserId,
      `https://www.googleapis.com/drive/v3/files`,
      { method: 'POST', body, query: { fields: 'id,name,webViewLink' } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({ created: true, id: result.id, name: result.name, link: result.webViewLink }, null, 2));
  },
};

const driveMove: McpToolDefinition = {
  tool: {
    name: 'drive_move',
    description: "Move a Drive file/folder into a different parent (removes from current parents, adds to new). Use to organize files after upload.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id. Required." },
        file_id: { type: 'string', description: 'File or folder id to move.' },
        new_parent_folder_id: { type: 'string', description: 'Destination folder id.' },
      },
      required: ['as_user_id', 'file_id', 'new_parent_folder_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const fileId = extractDriveFileId((args.file_id as string | undefined)?.trim() || '');
    if (!fileId) return err('file_id is required');
    const newParent = extractDriveFileId((args.new_parent_folder_id as string | undefined)?.trim() || '');
    if (!newParent) return err('new_parent_folder_id is required');

    const meta = await googleApi<{ parents?: string[] }>(
      asUserId,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      { query: { fields: 'parents' } },
    );
    if ('error' in meta) return err(meta.error);
    const oldParents = (meta.parents ?? []).join(',');

    const result = await googleApi<{ id: string; name: string; parents: string[]; webViewLink: string }>(
      asUserId,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      { method: 'PATCH', body: {}, query: { addParents: newParent, removeParents: oldParents, fields: 'id,name,parents,webViewLink' } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({ moved: true, id: result.id, name: result.name, parents: result.parents, link: result.webViewLink }, null, 2));
  },
};

// ── Sheets ──────────────────────────────────────────────────────────────

function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return urlMatch ? urlMatch[1] : trimmed;
}

const sheetsRead: McpToolDefinition = {
  tool: {
    name: 'sheets_read',
    description:
      "Read values from a SPECIFIC user's Google Sheet (spreadsheet). Use for 'lee mi sheet X', 'qué hay en la hoja Y', 'dame los datos del spreadsheet Z'.\n\nPair with `drive_search` to find the spreadsheet's id first (search for `mimeType = 'application/vnd.google-apps.spreadsheet' and name contains '...'`), then pass the id (or full URL) here.\n\nIf `range` is omitted, returns the spreadsheet's title, all tab names with dimensions, AND a preview of the first 50 rows of the first tab — handy for 'qué tiene este sheet'. If `range` is provided (A1 notation, e.g. `Hoja1!A1:E100` or just `A1:E100`), returns just those values.\n\nOnly works on native Google Sheets, not on uploaded .xlsx files. Read-only.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Sheets to read (the from_user_id of the message that asked). Required." },
        spreadsheet: { type: 'string', description: "Spreadsheet id (e.g. '1abc...') OR full Sheets URL ('https://docs.google.com/spreadsheets/d/1abc.../edit')." },
        range: { type: 'string', description: "Optional A1 range. Examples: `Hoja1!A1:E100`, `A1:E100` (defaults to first tab), `Hoja1` (entire tab). If omitted, returns metadata + first 50 rows of first tab." },
      },
      required: ['as_user_id', 'spreadsheet'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const sp = (args.spreadsheet as string | undefined)?.trim();
    if (!sp) return err('spreadsheet is required (id or URL)');
    const id = extractSpreadsheetId(sp);
    const range = (args.range as string | undefined)?.trim();

    if (!range) {
      const meta = await googleApi<{
        properties?: { title: string };
        sheets?: Array<{ properties: { sheetId: number; title: string; gridProperties?: { rowCount: number; columnCount: number } } }>;
      }>(asUserId, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`, {
        query: { fields: 'properties.title,sheets.properties' },
      });
      if ('error' in meta) return err(meta.error);
      const tabs = (meta.sheets ?? []).map((s) => ({
        title: s.properties.title,
        rows: s.properties.gridProperties?.rowCount,
        cols: s.properties.gridProperties?.columnCount,
      }));
      const firstTab = tabs[0]?.title;
      let preview: { range?: string; values?: unknown[][]; error?: string } = {};
      if (firstTab) {
        const p = await googleApi<{ range: string; values?: unknown[][] }>(
          asUserId,
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(`${firstTab}!A1:Z50`)}`,
        );
        preview = 'error' in p ? { error: p.error } : { range: p.range, values: p.values ?? [] };
      }
      return ok(JSON.stringify({
        spreadsheet_id: id,
        title: meta.properties?.title,
        tabs,
        preview,
      }, null, 2));
    }

    const result = await googleApi<{ range: string; values?: unknown[][]; majorDimension?: string }>(
      asUserId,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`,
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({
      spreadsheet_id: id,
      range: result.range,
      rows: (result.values ?? []).length,
      values: result.values ?? [],
    }, null, 2));
  },
};

const sheetsWrite: McpToolDefinition = {
  tool: {
    name: 'sheets_write',
    description:
      "Write values to a Google Sheet. Two modes:\n- `mode='update'` (default): set cells in `range` (A1 notation, e.g. `Hoja1!B2:D5`). Replaces whatever was there.\n- `mode='append'`: add rows AFTER the last non-empty row in `range` (or in the named tab). Use for log rows.\n\n`values` is a 2D array (rows × columns). Strings, numbers, booleans accepted; with `valueInputOption='USER_ENTERED'` (default) Google parses formulas/dates as if you typed them in the UI; `RAW` stores literal strings.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Sheet to write. Required." },
        spreadsheet: { type: 'string', description: "Spreadsheet id or full URL." },
        range: { type: 'string', description: "A1 range. Required. For append, a tab name like 'Hoja1' is fine." },
        values: { type: 'array', description: '2D array (rows × columns) of cell values.', items: { type: 'array', items: {} } },
        mode: { type: 'string', enum: ['update', 'append'], description: "Default: 'update'." },
        valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'], description: "Default: 'USER_ENTERED'." },
      },
      required: ['as_user_id', 'spreadsheet', 'range', 'values'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const sp = (args.spreadsheet as string | undefined)?.trim();
    if (!sp) return err('spreadsheet is required');
    const id = extractSpreadsheetId(sp);
    const range = (args.range as string | undefined)?.trim();
    if (!range) return err('range is required');
    const values = args.values;
    if (!Array.isArray(values)) return err('values must be a 2D array');
    const mode = (args.mode as string) || 'update';
    const valueInputOption = (args.valueInputOption as string) || 'USER_ENTERED';

    if (mode === 'append') {
      const result = await googleApi<{ updates?: { updatedRange?: string; updatedRows?: number; updatedColumns?: number; updatedCells?: number } }>(
        asUserId,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append`,
        { method: 'POST', body: { values, range, majorDimension: 'ROWS' }, query: { valueInputOption, insertDataOption: 'INSERT_ROWS' } },
      );
      if ('error' in result) return err(result.error);
      return ok(JSON.stringify({ appended: true, ...result.updates }, null, 2));
    }
    const result = await googleApi<{ updatedRange?: string; updatedRows?: number; updatedColumns?: number; updatedCells?: number }>(
      asUserId,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`,
      { method: 'PUT', body: { values, range, majorDimension: 'ROWS' }, query: { valueInputOption } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({ updated: true, ...result }, null, 2));
  },
};

// ── Docs ────────────────────────────────────────────────────────────────

function extractDocId(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : trimmed;
}

interface DocsTextRun { content?: string; }
interface DocsParagraphElement { textRun?: DocsTextRun; }
interface DocsParagraph { elements?: DocsParagraphElement[]; }
interface DocsTableCell { content?: DocsStructuralElement[]; }
interface DocsTableRow { tableCells?: DocsTableCell[]; }
interface DocsTable { tableRows?: DocsTableRow[]; }
interface DocsStructuralElement { paragraph?: DocsParagraph; table?: DocsTable; }

function extractDocText(content: DocsStructuralElement[] | undefined): string {
  if (!content) return '';
  let out = '';
  for (const el of content) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements ?? []) {
        if (pe.textRun?.content) out += pe.textRun.content;
      }
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => extractDocText(c.content).trim());
        out += cells.join(' | ') + '\n';
      }
    }
  }
  return out;
}

const docsRead: McpToolDefinition = {
  tool: {
    name: 'docs_read',
    description: "Read the text content of a Google Doc. Returns title + plain-text body (formatting dropped, line breaks preserved, tables flattened to pipe-separated rows). Use after `drive_search` finds a Doc.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Doc to read. Required." },
        document: { type: 'string', description: "Doc id or full URL ('https://docs.google.com/document/d/...')." },
      },
      required: ['as_user_id', 'document'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const id = extractDocId((args.document as string | undefined)?.trim() || '');
    if (!id) return err('document is required');
    const result = await googleApi<{ title: string; body?: { content?: DocsStructuralElement[] } }>(
      asUserId,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`,
    );
    if ('error' in result) return err(result.error);
    const text = extractDocText(result.body?.content).replace(/\n{3,}/g, '\n\n').trim();
    return ok(JSON.stringify({
      document_id: id,
      title: result.title,
      chars: text.length,
      body: text,
    }, null, 2));
  },
};

const docsCreate: McpToolDefinition = {
  tool: {
    name: 'docs_create',
    description: "Create a new Google Doc. Returns id + webViewLink. Optional `body` (plain text) inserted at the top. Use `drive_move` after to organize into a folder; the doc lands in My Drive root.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose Drive to create the doc in. Required." },
        title: { type: 'string', description: 'Doc title.' },
        body: { type: 'string', description: 'Optional initial plain-text body.' },
      },
      required: ['as_user_id', 'title'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const title = (args.title as string | undefined)?.trim();
    if (!title) return err('title is required');
    const body = args.body as string | undefined;

    const created = await googleApi<{ documentId: string; title: string }>(
      asUserId,
      'https://docs.googleapis.com/v1/documents',
      { method: 'POST', body: { title } },
    );
    if ('error' in created) return err(created.error);

    if (body && body.length > 0) {
      const update = await googleApi(
        asUserId,
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(created.documentId)}:batchUpdate`,
        { method: 'POST', body: { requests: [{ insertText: { location: { index: 1 }, text: body } }] } },
      );
      if (typeof update === 'object' && update !== null && 'error' in update) {
        return err(`doc created but body insert failed: ${(update as { error: string }).error}`);
      }
    }

    const link = `https://docs.google.com/document/d/${created.documentId}/edit`;
    return ok(JSON.stringify({ created: true, document_id: created.documentId, title: created.title, link }, null, 2));
  },
};

const docsAppend: McpToolDefinition = {
  tool: {
    name: 'docs_append',
    description: "Append plain-text content to the end of an existing Google Doc. Adds a leading newline if the doc isn't empty.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string' },
        document: { type: 'string', description: 'Doc id or URL.' },
        text: { type: 'string', description: 'Text to append.' },
      },
      required: ['as_user_id', 'document', 'text'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const id = extractDocId((args.document as string | undefined)?.trim() || '');
    if (!id) return err('document is required');
    const text = args.text as string;
    if (!text) return err('text is required');

    const meta = await googleApi<{ body?: { content?: Array<{ endIndex?: number }> } }>(
      asUserId,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`,
      { query: { fields: 'body(content(endIndex))' } },
    );
    if ('error' in meta) return err(meta.error);
    const lastEnd = (meta.body?.content ?? []).reduce((max, c) => (c.endIndex && c.endIndex > max ? c.endIndex : max), 1);
    // Doc's end is at lastEnd; insert at lastEnd-1 (just before the trailing newline).
    const insertIndex = Math.max(1, lastEnd - 1);
    const insertText = (insertIndex > 1 ? '\n' : '') + text;

    const result = await googleApi(
      asUserId,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}:batchUpdate`,
      { method: 'POST', body: { requests: [{ insertText: { location: { index: insertIndex }, text: insertText } }] } },
    );
    if (typeof result === 'object' && result !== null && 'error' in result) return err((result as { error: string }).error);
    return ok(JSON.stringify({ appended: true, document_id: id, chars_added: insertText.length }, null, 2));
  },
};

// ── Calendar (extra) ────────────────────────────────────────────────────

const calendarListCalendars: McpToolDefinition = {
  tool: {
    name: 'calendar_list_calendars',
    description: "List `as_user_id`'s calendars (primary + secondary like work, family, subscribed). Returns id, summary, accessRole, primary flag, timeZone. Use the id as `calendarId` in other Calendar tools to target a specific calendar.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id. Required." },
      },
      required: ['as_user_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const result = await googleApi<{ items?: Array<{ id: string; summary: string; accessRole: string; primary?: boolean; timeZone?: string; backgroundColor?: string }> }>(
      asUserId,
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { query: { fields: 'items(id,summary,accessRole,primary,timeZone,backgroundColor)' } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({ count: (result.items ?? []).length, calendars: result.items ?? [] }, null, 2));
  },
};

const calendarFreebusy: McpToolDefinition = {
  tool: {
    name: 'calendar_freebusy',
    description: "Check free/busy windows for one or more calendars in a time range. Use for 'cuándo coincidimos brenda y yo esta semana'. Returns busy intervals per calendar; YOU compute the gaps. Each `email` is a calendar id (an email address for personal calendars; for shared calendars use the calendar id from `calendar_list_calendars`).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose token authorizes the query. Required." },
        emails: { type: 'array', items: { type: 'string' }, description: 'Calendar ids to query (typically email addresses).' },
        timeMin: { type: 'string', description: 'ISO 8601 start of window.' },
        timeMax: { type: 'string', description: 'ISO 8601 end of window.' },
        timeZone: { type: 'string', description: "IANA timezone for response. Default: 'America/Mexico_City'." },
      },
      required: ['as_user_id', 'emails', 'timeMin', 'timeMax'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const emails = args.emails as string[] | undefined;
    if (!Array.isArray(emails) || emails.length === 0) return err('emails (array) is required');
    const timeMin = args.timeMin as string;
    const timeMax = args.timeMax as string;
    if (!timeMin || !timeMax) return err('timeMin and timeMax are required');
    const timeZone = (args.timeZone as string) || 'America/Mexico_City';

    const result = await googleApi<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }> }>(
      asUserId,
      'https://www.googleapis.com/calendar/v3/freeBusy',
      { method: 'POST', body: { timeMin, timeMax, timeZone, items: emails.map((id) => ({ id })) } },
    );
    if ('error' in result) return err(result.error);
    const out: Record<string, unknown> = {};
    for (const [email, info] of Object.entries(result.calendars ?? {})) {
      out[email] = info.errors ? { error: info.errors.map((e) => e.reason).join(', ') } : { busy: info.busy ?? [] };
    }
    return ok(JSON.stringify({ timeMin, timeMax, timeZone, calendars: out }, null, 2));
  },
};

// ── Meet ────────────────────────────────────────────────────────────────

const meetCreateSpace: McpToolDefinition = {
  tool: {
    name: 'meet_create_space',
    description: "Create a standalone Google Meet space (no calendar event). Returns the meeting URI ('https://meet.google.com/xxx-yyyy-zzz') for instant ad-hoc meetings. For meetings tied to a calendar event, use `calendar_create_event` with `add_meet=true` instead.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id whose account creates the space. Required." },
      },
      required: ['as_user_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const result = await googleApi<{ name: string; meetingUri: string; meetingCode: string }>(
      asUserId,
      'https://meet.googleapis.com/v2/spaces',
      { method: 'POST', body: {} },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({
      created: true,
      space_name: result.name,
      meeting_uri: result.meetingUri,
      meeting_code: result.meetingCode,
    }, null, 2));
  },
};

const meetListRecentConferences: McpToolDefinition = {
  tool: {
    name: 'meet_list_recent_conferences',
    description: "List recent finished Meet conferences for `as_user_id`. Returns each conference's name (id), space name, start/end times. Use the conference name in `meet_get_recording` / `meet_get_transcript` to retrieve recording/transcript.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string', description: "User id. Required." },
        startTime: { type: 'string', description: "ISO 8601 timestamp. Conferences started after this. Default: 7 days ago." },
        maxResults: { type: 'integer', description: 'Max results. Default 10, cap 50.' },
      },
      required: ['as_user_id'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const startTime = (args.startTime as string) || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const maxResults = Math.min(Number(args.maxResults) || 10, 50);
    const result = await googleApi<{ conferenceRecords?: Array<{ name: string; space?: string; startTime?: string; endTime?: string }> }>(
      asUserId,
      'https://meet.googleapis.com/v2/conferenceRecords',
      { query: { filter: `start_time >= "${startTime}"`, pageSize: maxResults } },
    );
    if ('error' in result) return err(result.error);
    return ok(JSON.stringify({ count: (result.conferenceRecords ?? []).length, conferences: result.conferenceRecords ?? [] }, null, 2));
  },
};

const meetGetRecording: McpToolDefinition = {
  tool: {
    name: 'meet_get_recording',
    description: "Get recording links for a past Meet conference. Returns Drive video file ids (use `drive_download` to fetch the actual video). Empty if the meeting wasn't recorded.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string' },
        conference_name: { type: 'string', description: "Conference record name like 'conferenceRecords/abc123' (from meet_list_recent_conferences)." },
      },
      required: ['as_user_id', 'conference_name'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const name = (args.conference_name as string | undefined)?.trim();
    if (!name) return err('conference_name is required');
    const result = await googleApi<{ recordings?: Array<{ name: string; state: string; driveDestination?: { file?: string; exportUri?: string } }> }>(
      asUserId,
      `https://meet.googleapis.com/v2/${name}/recordings`,
    );
    if ('error' in result) return err(result.error);
    const recordings = (result.recordings ?? []).map((r) => ({
      name: r.name,
      state: r.state,
      drive_file_id: r.driveDestination?.file,
      export_uri: r.driveDestination?.exportUri,
    }));
    return ok(JSON.stringify({ conference: name, count: recordings.length, recordings }, null, 2));
  },
};

const meetGetTranscript: McpToolDefinition = {
  tool: {
    name: 'meet_get_transcript',
    description: "Get transcript for a past Meet conference. Returns the transcript Google Doc id (use `docs_read` for the full text) AND a flat list of {speaker, text, startTime} entries. Empty if no transcript was generated.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        as_user_id: { type: 'string' },
        conference_name: { type: 'string', description: "Conference record name (from meet_list_recent_conferences)." },
      },
      required: ['as_user_id', 'conference_name'],
    },
  },
  handler: async (args) => {
    const asUserId = (args.as_user_id as string | undefined)?.trim();
    if (!asUserId) return err('as_user_id is required');
    const name = (args.conference_name as string | undefined)?.trim();
    if (!name) return err('conference_name is required');
    const list = await googleApi<{ transcripts?: Array<{ name: string; state: string; docsDestination?: { document?: string; exportUri?: string } }> }>(
      asUserId,
      `https://meet.googleapis.com/v2/${name}/transcripts`,
    );
    if ('error' in list) return err(list.error);
    const transcripts = list.transcripts ?? [];
    if (transcripts.length === 0) return ok(JSON.stringify({ conference: name, transcripts: [] }, null, 2));

    const enriched = await Promise.all(
      transcripts.map(async (t) => {
        const entries = await googleApi<{ transcriptEntries?: Array<{ participant?: string; text?: string; startTime?: string }> }>(
          asUserId,
          `https://meet.googleapis.com/v2/${t.name}/entries`,
          { query: { pageSize: 1000 } },
        );
        const flat = 'error' in entries ? [] : (entries.transcriptEntries ?? []).map((e) => ({
          speaker: e.participant,
          start: e.startTime,
          text: e.text,
        }));
        return {
          name: t.name,
          state: t.state,
          doc_id: t.docsDestination?.document,
          export_uri: t.docsDestination?.exportUri,
          entries: flat,
        };
      }),
    );
    return ok(JSON.stringify({ conference: name, transcripts: enriched }, null, 2));
  },
};

registerTools([
  googleWorkspaceStatus,
  calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent, calendarListCalendars, calendarFreebusy,
  gmailSend, gmailSearch, gmailReadMessage, gmailReply, gmailModifyLabels,
  driveSearch, driveDownload, driveUpload, driveShare, driveCreateFolder, driveMove,
  sheetsRead, sheetsWrite,
  docsRead, docsCreate, docsAppend,
  meetCreateSpace, meetListRecentConferences, meetGetRecording, meetGetTranscript,
]);
