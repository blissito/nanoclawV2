/**
 * Host-side handler for the `register_channel` system action emitted by the
 * container MCP tool. Validates the caller's privilege, then applies the
 * wiring in a single transaction:
 *
 *   1. Resolve the calling user from the session's most recent inbound
 *      message (messages_in ordered by seq DESC).
 *   2. For `isolation="separate-agent"`: create a fresh agent_group +
 *      filesystem. Otherwise: target is the caller's own agent group (or
 *      an explicit `agent_group_id` passed in).
 *   3. canAccessAgentGroup(userId, targetAgentGroupId) must return owner /
 *      global_admin / admin_of_group. Plain members cannot register.
 *   4. Upsert the messaging_group row.
 *   5. Create the messaging_group_agents wiring.
 *   6. Notify the calling agent with a chat message so it can relay status
 *      to the user.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/index.js';
import { listDiscoveredChannels, upsertDiscoveredChannel } from '../../db/discovered-channels.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { initGroupFilesystem } from '../../group-init.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { canAccessAgentGroup } from '../permissions/access.js';
import { ASSISTANT_NAME } from '../../config.js';

type Isolation = 'shared-session' | 'separate-session' | 'separate-agent';
type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isolationToSessionMode(iso: Isolation): 'agent-shared' | 'shared' {
  if (iso === 'shared-session') return 'agent-shared';
  return 'shared';
}

/**
 * Sanitize a regex source the LLM may have written in JS regex-literal form.
 *
 * The router compiles the pattern via `new RegExp(pat)` with no flags
 * argument, so a raw literal-style string like `\bghosty\b/i` ends up
 * matching the LITERAL characters `/i` — i.e. never matches. Accept both
 * styles and normalize to a plain source string.
 *
 * Strategy: if the input matches `/<source>/<flags>`, strip the flags.
 * Flags are dropped silently (router has no way to apply them today); we
 * rely on users who need case-insensitive to lowercase the literal, or
 * write `[Gg][Hh]...` explicitly. A future improvement is to extend the
 * router to honor a separate `engage_flags` column.
 */
function sanitizeEnginePattern(raw: string | null): string | null {
  if (!raw) return raw;
  const literalMatch = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (literalMatch) return literalMatch[1];
  // Bare patterns sometimes still end with a stray "/i" or "/gi" when the LLM
  // forgets the leading slash. Strip a trailing `/<flags>` if the remainder
  // is still a valid regex source.
  const trailingFlags = raw.match(/^(.+)\/([gimsuy]+)$/);
  if (trailingFlags) {
    try {
      new RegExp(trailingFlags[1]);
      return trailingFlags[1];
    } catch {
      // fall through — leave as-is and let the router's try/catch fail open
    }
  }
  return raw;
}

function inferIsGroup(platformId: string, channelType: string, fallback?: boolean): 0 | 1 {
  if (typeof fallback === 'boolean') return fallback ? 1 : 0;
  if (channelType === 'whatsapp') {
    if (platformId.endsWith('@g.us')) return 1;
    if (platformId.endsWith('@s.whatsapp.net')) return 0;
  }
  return 0;
}

function getLastInboundUserId(inDb: Database.Database): string | null {
  try {
    // Exclude agent/system messages — those are notifyAgent writes that the
    // host itself injected (sender='system', channel_type='agent'). We need
    // the most recent *user* message that woke this container, i.e. one that
    // came in through a real channel adapter.
    const rows = inDb
      .prepare(
        `SELECT content, channel_type FROM messages_in
         WHERE kind = 'chat' AND trigger = 1
           AND channel_type IS NOT NULL AND channel_type != 'agent'
         ORDER BY seq DESC
         LIMIT 5`,
      )
      .all() as Array<{ content: string; channel_type: string }>;

    for (const row of rows) {
      let parsed: { sender?: string; senderId?: string };
      try {
        parsed = JSON.parse(row.content);
      } catch {
        continue;
      }
      const raw = parsed.senderId ?? parsed.sender;
      if (!raw || raw === 'system') continue;
      // Same normalization as src/modules/permissions/index.ts:extractAndUpsertUser —
      // if the sender already has a channel prefix (contains ':') use it as-is, else
      // namespace with the channel_type from the inbound row.
      return raw.includes(':') ? raw : `${row.channel_type}:${raw}`;
    }
    return null;
  } catch {
    return null;
  }
}

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-regch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text,
      sender: 'system',
      senderId: 'system',
    }),
    processAfter: new Date(Date.now() + 1500)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ''),
  });
}

export async function applyRegisterChannel(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const platform_id = content.platform_id as string;
  const channel_type = content.channel_type as string;
  const name = content.name as string;
  const isolation = content.isolation as Isolation;
  const folder = content.folder as string | undefined;
  const explicitAgentGroupId = content.agent_group_id as string | undefined;
  const engage_mode = (content.engage_mode as EngageMode) || 'pattern';
  const rawPattern = (content.engage_pattern as string | null | undefined) ?? (engage_mode === 'pattern' ? '.' : null);
  const engage_pattern = sanitizeEnginePattern(rawPattern);
  const unknown_sender_policy = (content.unknown_sender_policy as UnknownSenderPolicy) || 'request_approval';
  const is_group = inferIsGroup(platform_id, channel_type, content.is_group as boolean | undefined);
  const assistant_name = (content.assistant_name as string | undefined) || ASSISTANT_NAME;

  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(session, 'register_channel rejected: could not resolve the calling user from the current session.');
    return;
  }

  // Resolve / create target agent group
  let targetAgentGroupId: string;
  if (isolation === 'separate-agent') {
    if (!folder) {
      notifyAgent(session, 'register_channel rejected: isolation="separate-agent" requires a folder name.');
      return;
    }
    const existing = getAgentGroupByFolder(folder);
    if (existing) {
      targetAgentGroupId = existing.id;
    } else {
      // Privilege for creating a new agent group: global owner/admin only.
      // Scoped admin of another group isn't automatically allowed to spin up
      // a fresh one. Gate via a probe on the caller's own group first.
      const selfAccess = canAccessAgentGroup(userId, session.agent_group_id);
      if (!selfAccess.allowed || !['owner', 'global_admin'].includes(selfAccess.reason)) {
        notifyAgent(
          session,
          `register_channel rejected: creating a new agent group requires global owner or admin. Your role (${selfAccess.allowed ? selfAccess.reason : 'none'}) is insufficient.`,
        );
        return;
      }
      const newId = generateId('ag');
      const agentGroup = {
        id: newId,
        name: assistant_name,
        folder,
        agent_provider: 'claude',
        created_at: new Date().toISOString(),
      };
      createAgentGroup(agentGroup);
      initGroupFilesystem(agentGroup);
      targetAgentGroupId = newId;
      log.info('Agent group created via register_channel', { agentGroupId: newId, folder });
    }
  } else {
    targetAgentGroupId = explicitAgentGroupId ?? session.agent_group_id;
    if (!getAgentGroup(targetAgentGroupId)) {
      notifyAgent(session, `register_channel rejected: agent_group_id "${targetAgentGroupId}" does not exist.`);
      return;
    }
  }

  // Privilege check on the target agent group.
  const access = canAccessAgentGroup(userId, targetAgentGroupId);
  const privileged = access.allowed && ['owner', 'global_admin', 'admin_of_group'].includes(access.reason);
  if (!privileged) {
    notifyAgent(
      session,
      `register_channel rejected: you must be owner or admin of the target agent group. Current role for ${userId}: ${access.allowed ? access.reason : access.reason ?? 'unknown'}.`,
    );
    return;
  }

  // Messaging group (upsert-ish: reuse if it exists, else create).
  let mg = getMessagingGroupByPlatform(channel_type, platform_id);
  if (!mg) {
    mg = {
      id: generateId('mg'),
      channel_type,
      platform_id,
      name,
      is_group,
      unknown_sender_policy,
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Messaging group created via register_channel', { id: mg.id, channel_type, platform_id });
  }

  // Wiring — idempotent: if a (messaging_group_id, agent_group_id) row already
  // exists, treat this call as an UPDATE of engage/session config. Without
  // this, re-registering an already-wired channel throws UNIQUE constraint
  // and the user's "change my engage to X" intent silently fails.
  const session_mode = isolationToSessionMode(isolation);
  const existingWiring = getMessagingGroupAgents(mg.id).find(
    (m) => m.agent_group_id === targetAgentGroupId,
  );
  let action: 'created' | 'updated';
  if (existingWiring) {
    updateMessagingGroupAgent(existingWiring.id, {
      engage_mode,
      engage_pattern,
      session_mode,
    });
    action = 'updated';
    log.info('Channel wiring updated via register_channel', {
      mgaId: existingWiring.id,
      messagingGroupId: mg.id,
      agentGroupId: targetAgentGroupId,
      isolation,
      engage_mode,
    });
  } else {
    const mgaId = generateId('mga');
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: mg.id,
      agent_group_id: targetAgentGroupId,
      engage_mode,
      engage_pattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode,
      priority: 0,
      created_at: new Date().toISOString(),
    });
    action = 'created';
    log.info('Channel wired via register_channel', {
      messagingGroupId: mg.id,
      agentGroupId: targetAgentGroupId,
      isolation,
      engage_mode,
    });
  }

  notifyAgent(
    session,
    `Channel "${name}" wiring ${action}. messaging_group_id=${mg.id}, agent_group_id=${targetAgentGroupId}, isolation=${isolation}, engage_mode=${engage_mode}${engage_pattern ? ` pattern=${engage_pattern}` : ''}, policy=${unknown_sender_policy}. Tell the user it's live.`,
  );
}

export async function applyListChannels(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const channelTypeFilter = content.channel_type as string | undefined;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT mg.platform_id,
              mg.name           AS chat_name,
              mg.channel_type,
              mg.is_group,
              mg.unknown_sender_policy,
              ag.id             AS agent_id,
              ag.name           AS agent_name,
              mga.engage_mode,
              mga.engage_pattern,
              mga.session_mode
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
         JOIN agent_groups ag            ON ag.id = mga.agent_group_id
        ${channelTypeFilter ? 'WHERE mg.channel_type = ?' : ''}
        ORDER BY mg.channel_type, mg.name`,
    )
    .all(...(channelTypeFilter ? [channelTypeFilter] : [])) as Array<{
    platform_id: string;
    chat_name: string | null;
    channel_type: string;
    is_group: number;
    unknown_sender_policy: string;
    agent_id: string;
    agent_name: string;
    engage_mode: string;
    engage_pattern: string | null;
    session_mode: string;
  }>;

  if (rows.length === 0) {
    notifyAgent(session, 'Channel list: no channels are wired yet.');
    return;
  }

  const lines = rows.map((r) => {
    const kind = r.is_group ? 'group' : 'DM';
    const label = r.chat_name && r.chat_name !== r.platform_id ? r.chat_name : r.platform_id;
    const pattern = r.engage_pattern ? `:${r.engage_pattern}` : '';
    return `• ${label} (${r.channel_type}, ${kind}, ${r.platform_id}) → agent "${r.agent_name}" [engage=${r.engage_mode}${pattern}, session=${r.session_mode}, sender_policy=${r.unknown_sender_policy}]`;
  });
  notifyAgent(
    session,
    `Channels currently wired (${rows.length}):\n${lines.join('\n')}\n\nPresent this to the user in Spanish, summarize don't dump the raw log.`,
  );
}

export async function applyListDiscoveredGroups(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const channelTypeFilter = content.channel_type as string | undefined;
  const nameContains = content.name_contains as string | undefined;

  let rows = listDiscoveredChannels(channelTypeFilter);
  if (nameContains) {
    const needle = nameContains.toLowerCase();
    rows = rows.filter((r) => (r.name ?? '').toLowerCase().includes(needle));
  }

  // Flag which ones are already wired so the agent doesn't try to re-register.
  const wiredSet = new Set(
    (getDb()
      .prepare(
        `SELECT mg.channel_type || '|' || mg.platform_id AS key
           FROM messaging_groups mg
           JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id`,
      )
      .all() as Array<{ key: string }>).map((r) => r.key),
  );

  if (rows.length === 0) {
    notifyAgent(
      session,
      'Discovered channels: none yet. The adapter needs to see traffic / sync metadata first.',
    );
    return;
  }

  const lines = rows.map((r) => {
    const wired = wiredSet.has(`${r.channel_type}|${r.platform_id}`) ? ' [WIRED]' : '';
    const kind = r.is_group ? 'group' : 'DM';
    const label = r.name ?? r.platform_id;
    return `• ${label} — ${r.channel_type} ${kind}, platform_id=${r.platform_id}${wired}`;
  });

  notifyAgent(
    session,
    `Discovered channels (${rows.length}):\n${lines.join('\n')}\n\nUse this list to resolve user-provided group names to a platform_id before calling register_channel. Items tagged [WIRED] are already connected — do not re-register them.`,
  );
}

export type CreateGroupCoreInput = {
  name: string;
  isolation?: Isolation;
  folder?: string;
  agent_group_id?: string;
  engage_mode?: EngageMode;
  engage_pattern?: string | null;
  unknown_sender_policy?: UnknownSenderPolicy;
  assistant_name?: string;
};

export type CreateGroupCoreResult =
  | {
      ok: true;
      platformId: string;
      agentGroupId: string;
      folder: string;
      inviteLink: string | null;
      isolation: Isolation;
      engageMode: EngageMode;
      engagePattern: string | null;
      unknownSenderPolicy: UnknownSenderPolicy;
    }
  | {
      ok: false;
      error: string;
      partial?: { platformId: string; inviteLink: string | null };
    };

/**
 * Pure-side-effects core for create_group, callable from any context (system
 * action, HTTP admin endpoint, future MCP server). Does NOT depend on Session.
 * The caller is responsible for translating the result into a user-facing
 * response (notifyAgent for chat, JSON body for HTTP).
 */
export async function createGroupCore(
  input: CreateGroupCoreInput,
  requestingUserId: string,
): Promise<CreateGroupCoreResult> {
  const name = input.name?.trim();
  if (!name) return { ok: false, error: 'name is required' };

  const isolation: Isolation = input.isolation ?? 'separate-session';
  const folder = input.folder;
  if (isolation === 'separate-agent' && !folder) {
    return { ok: false, error: 'isolation="separate-agent" requires a folder name' };
  }
  if (isolation !== 'separate-agent' && !input.agent_group_id) {
    return {
      ok: false,
      error: 'agent_group_id is required when isolation is not "separate-agent"',
    };
  }

  const engage_mode: EngageMode = input.engage_mode ?? 'pattern';
  const rawPattern =
    input.engage_pattern ??
    (engage_mode === 'pattern' ? `\\b${ASSISTANT_NAME}\\b` : null);
  const engage_pattern = sanitizeEnginePattern(rawPattern);
  const unknown_sender_policy: UnknownSenderPolicy =
    input.unknown_sender_policy ?? 'request_approval';
  const assistant_name = input.assistant_name || ASSISTANT_NAME;

  // Resolve target agent group before touching the platform.
  let targetAgentGroupId: string;
  if (isolation === 'separate-agent') {
    const existing = getAgentGroupByFolder(folder!);
    if (existing) {
      targetAgentGroupId = existing.id;
    } else {
      // Need owner/global_admin to create a new agent group. Use the
      // explicit agent_group_id (if provided) as the privilege-check anchor;
      // otherwise we can't validate against any specific group, so fall back
      // to checking the requesting user has *some* global role.
      const anchor = input.agent_group_id;
      if (anchor) {
        const selfAccess = canAccessAgentGroup(requestingUserId, anchor);
        if (!selfAccess.allowed || !['owner', 'global_admin'].includes(selfAccess.reason)) {
          return {
            ok: false,
            error: `creating a new agent group requires global owner or admin. Your role (${selfAccess.allowed ? selfAccess.reason : 'none'}) is insufficient.`,
          };
        }
      }
      const newId = generateId('ag');
      const agentGroup = {
        id: newId,
        name: assistant_name,
        folder: folder!,
        agent_provider: 'claude',
        created_at: new Date().toISOString(),
      };
      createAgentGroup(agentGroup);
      initGroupFilesystem(agentGroup);
      targetAgentGroupId = newId;
      log.info('Agent group created via createGroupCore', { agentGroupId: newId, folder });
    }
  } else {
    targetAgentGroupId = input.agent_group_id!;
    if (!getAgentGroup(targetAgentGroupId)) {
      return { ok: false, error: `agent_group_id "${targetAgentGroupId}" does not exist` };
    }
  }

  const access = canAccessAgentGroup(requestingUserId, targetAgentGroupId);
  const privileged = access.allowed && ['owner', 'global_admin', 'admin_of_group'].includes(access.reason);
  if (!privileged) {
    return {
      ok: false,
      error: `you must be owner or admin of the target agent group. Current role for ${requestingUserId}: ${access.allowed ? access.reason : access.reason ?? 'unknown'}.`,
    };
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.createGroup) {
    return {
      ok: false,
      error: 'no WhatsApp adapter is loaded that supports createGroup',
    };
  }
  if (!adapter.isConnected()) {
    return { ok: false, error: 'WhatsApp adapter is not connected' };
  }

  // 1) Create the group on the platform.
  let platformId: string;
  let inviteLink: string | null = null;
  try {
    const result = await adapter.createGroup(name);
    platformId = result.platformId;
    inviteLink = result.inviteLink;
  } catch (err) {
    log.error('createGroup failed at adapter', { name, err });
    return {
      ok: false,
      error: `WhatsApp rejected the group creation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2) Persist messaging_group + wiring.
  try {
    const mg = {
      id: generateId('mg'),
      channel_type: 'whatsapp',
      platform_id: platformId,
      name,
      is_group: 1 as 0 | 1,
      unknown_sender_policy,
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Messaging group created via createGroupCore', { id: mg.id, platform_id: platformId });

    const mgaId = generateId('mga');
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: mg.id,
      agent_group_id: targetAgentGroupId,
      engage_mode,
      engage_pattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: isolationToSessionMode(isolation),
      priority: 0,
      created_at: new Date().toISOString(),
    });
    log.info('Channel wired via createGroupCore', {
      messagingGroupId: mg.id,
      agentGroupId: targetAgentGroupId,
      isolation,
      engage_mode,
    });

    upsertDiscoveredChannel('whatsapp', platformId, name, true);

    // Resolve folder from agent group (may differ from input.folder if existing was reused).
    const finalAg = getAgentGroup(targetAgentGroupId);
    const finalFolder = finalAg?.folder ?? folder ?? '';

    return {
      ok: true,
      platformId,
      agentGroupId: targetAgentGroupId,
      folder: finalFolder,
      inviteLink,
      isolation,
      engageMode: engage_mode,
      engagePattern: engage_pattern,
      unknownSenderPolicy: unknown_sender_policy,
    };
  } catch (err) {
    log.error('create_group post-create wiring failed', { platformId, err });
    return {
      ok: false,
      error: `wiring to DB failed after WA group creation: ${err instanceof Error ? err.message : String(err)}`,
      partial: { platformId, inviteLink },
    };
  }
}

export async function applyCreateGroup(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(
      session,
      'create_group rejected: could not resolve the calling user from the current session.',
    );
    return;
  }

  const name = (content.name as string | undefined) ?? '';
  const isolation = (content.isolation as Isolation | undefined) ?? 'separate-session';
  // Default agent_group_id to caller's session.agent_group_id for non-separate-agent.
  const explicitAgentGroupId = content.agent_group_id as string | undefined;
  const effectiveAgentGroupId =
    isolation === 'separate-agent'
      ? explicitAgentGroupId ?? session.agent_group_id
      : explicitAgentGroupId ?? session.agent_group_id;

  const result = await createGroupCore(
    {
      name,
      isolation,
      folder: content.folder as string | undefined,
      agent_group_id: effectiveAgentGroupId,
      engage_mode: content.engage_mode as EngageMode | undefined,
      engage_pattern: content.engage_pattern as string | null | undefined,
      unknown_sender_policy: content.unknown_sender_policy as UnknownSenderPolicy | undefined,
      assistant_name: content.assistant_name as string | undefined,
    },
    userId,
  );

  if (!result.ok) {
    if (result.partial) {
      notifyAgent(
        session,
        `Partial failure on create_group: the WhatsApp group "${name}" was created on the platform (platform_id=${result.partial.platformId}, invite_link=${result.partial.inviteLink ?? 'unknown'}), BUT ${result.error}.\n\nReport this to the user honestly: the group exists in WhatsApp (share the invite link if available), but I am NOT yet listening in it. Offer to retry registration with: register_channel platform_id="${result.partial.platformId}" channel_type="whatsapp" name="${name}" isolation="${isolation}".`,
      );
    } else {
      notifyAgent(session, `create_group rejected: ${result.error}.`);
    }
    return;
  }

  notifyAgent(
    session,
    `WhatsApp group "${name}" created and wired.\nplatform_id=${result.platformId}\nagent_group_id=${result.agentGroupId}\nisolation=${result.isolation}, engage=${result.engageMode}${result.engagePattern ? `:${result.engagePattern}` : ''}, sender_policy=${result.unknownSenderPolicy}\ninvite_link=${result.inviteLink ?? '(WhatsApp did not return an invite link this time — you can ask the user to share it manually from inside the group)'}\n\nReport to the user in Spanish:\n  • The group is created and you are listening in it.\n  • Share the invite link so they (and others) can join.\n  • Note that there can be a 1-2 second lag for WhatsApp to fully sync the group state — first message in the group might take a moment to engage.`,
  );
}

export async function applyGetInviteLink(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const platformId = content.platform_id as string | undefined;
  if (!platformId) {
    notifyAgent(session, 'get_invite_link rejected: platform_id is required.');
    return;
  }
  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.getInviteLink) {
    notifyAgent(session, 'get_invite_link failed: WhatsApp adapter is not loaded or does not support invite links.');
    return;
  }
  if (!adapter.isConnected()) {
    notifyAgent(session, 'get_invite_link failed: WhatsApp adapter is not connected. Ask the user to retry in a moment.');
    return;
  }
  let link: string | null = null;
  try {
    link = await adapter.getInviteLink(platformId);
  } catch (err) {
    log.warn('getInviteLink threw', { platformId, err });
    notifyAgent(
      session,
      `get_invite_link failed: ${err instanceof Error ? err.message : String(err)}. Common cause: the bot is not an admin in that group.`,
    );
    return;
  }
  if (!link) {
    notifyAgent(
      session,
      `WhatsApp returned no invite link for ${platformId}. Most likely the bot is not a group admin (only admins can fetch the invite code).`,
    );
    return;
  }
  notifyAgent(
    session,
    `Invite link for ${platformId}:\n${link}\n\nShare it with the user in Spanish so they can pass it to others.`,
  );
}

export async function applyLeaveGroup(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const platformId = content.platform_id as string | undefined;
  if (!platformId) {
    notifyAgent(session, 'leave_group rejected: platform_id is required.');
    return;
  }

  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(session, 'leave_group rejected: could not resolve the calling user from the current session.');
    return;
  }

  const mg = getMessagingGroupByPlatform('whatsapp', platformId);
  // Privilege: must be owner/admin of the agent group(s) wired to this mg, OR
  // global owner/admin. If the mg has no wirings, fall back to gating against
  // the caller's own agent group.
  const targetAgentGroupId = mg
    ? (getMessagingGroupAgents(mg.id)[0]?.agent_group_id ?? session.agent_group_id)
    : session.agent_group_id;
  const access = canAccessAgentGroup(userId, targetAgentGroupId);
  const privileged = access.allowed && ['owner', 'global_admin', 'admin_of_group'].includes(access.reason);
  if (!privileged) {
    notifyAgent(
      session,
      `leave_group rejected: requires owner or admin privileges. Current role for ${userId}: ${access.allowed ? access.reason : access.reason ?? 'unknown'}.`,
    );
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.leaveGroup) {
    notifyAgent(session, 'leave_group failed: WhatsApp adapter is not loaded or does not support leaving groups.');
    return;
  }
  if (!adapter.isConnected()) {
    notifyAgent(session, 'leave_group failed: WhatsApp adapter is not connected. Ask the user to retry in a moment.');
    return;
  }

  try {
    await adapter.leaveGroup(platformId);
  } catch (err) {
    log.warn('leaveGroup threw', { platformId, err });
    notifyAgent(
      session,
      `leave_group failed at WhatsApp: ${err instanceof Error ? err.message : String(err)}. The bot may not be a group member, or the platform refused. NanoClaw DB was not modified.`,
    );
    return;
  }

  // Best-effort DB cleanup. Failures here are logged but don't block the
  // success notification — the WA leave already happened.
  let removedWirings = 0;
  let removedMg = false;
  if (mg) {
    try {
      for (const mga of getMessagingGroupAgents(mg.id)) {
        deleteMessagingGroupAgent(mga.id);
        removedWirings++;
      }
      deleteMessagingGroup(mg.id);
      removedMg = true;
      log.info('leave_group: removed messaging_group + wirings', { mgId: mg.id, removedWirings });
    } catch (err) {
      log.warn('leave_group: DB cleanup failed', { mgId: mg.id, err });
    }
  }

  notifyAgent(
    session,
    `Left WhatsApp group ${platformId}.\n• On WhatsApp: bot has exited; other members will see "left".\n• In NanoClaw: ${removedMg ? `removed ${removedWirings} wiring row(s) and the messaging_group entry` : 'no messaging_group row existed (was never wired)'}.\n\nReport to the user in Spanish: confirm exit, mention it is hard to undo (would need a fresh invite + register_channel).`,
  );
}

/**
 * Update `unknown_sender_policy` of an existing messaging_group. Filed as
 * a separate action (not a flag on register_channel) so the intent is
 * explicit — register_channel deliberately does not touch policy on
 * existing rows to avoid surprising side-effects when an agent re-wires.
 */
export async function applyUpdateChannelPolicy(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const platformId = content.platform_id as string | undefined;
  const policy = content.unknown_sender_policy as string | undefined;
  if (!platformId || !policy) {
    notifyAgent(session, 'update_channel_policy rejected: platform_id and unknown_sender_policy are required.');
    return;
  }
  if (!['strict', 'request_approval', 'public'].includes(policy)) {
    notifyAgent(session, `update_channel_policy rejected: unknown_sender_policy must be one of "strict" | "request_approval" | "public" (got "${policy}").`);
    return;
  }

  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(session, 'update_channel_policy rejected: could not resolve the calling user from the current session.');
    return;
  }

  const channelType = (content.channel_type as string | undefined) || 'whatsapp';
  const mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) {
    notifyAgent(session, `update_channel_policy rejected: no messaging_group found for ${channelType}:${platformId}. Use register_channel first.`);
    return;
  }

  const targetAgentGroupId =
    getMessagingGroupAgents(mg.id)[0]?.agent_group_id ?? session.agent_group_id;
  const access = canAccessAgentGroup(userId, targetAgentGroupId);
  const privileged = access.allowed && ['owner', 'global_admin', 'admin_of_group'].includes(access.reason);
  if (!privileged) {
    notifyAgent(
      session,
      `update_channel_policy rejected: requires owner or admin privileges. Current role for ${userId}: ${access.allowed ? access.reason : access.reason ?? 'unknown'}.`,
    );
    return;
  }

  try {
    updateMessagingGroup(mg.id, { unknown_sender_policy: policy as 'strict' | 'request_approval' | 'public' });
    log.info('update_channel_policy applied', { mgId: mg.id, platformId, policy });
  } catch (err) {
    notifyAgent(
      session,
      `update_channel_policy failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return;
  }

  notifyAgent(
    session,
    `Channel policy updated for ${platformId}: unknown_sender_policy="${policy}".\n\nReport to the user in Spanish:\n  • "strict" → mensajes de senders desconocidos se ignoran silenciosamente.\n  • "request_approval" → te llega un DM pidiendo aprobación antes de procesar.\n  • "public" → cualquier sender del grupo es atendido sin gate.`,
  );
}

export async function applyRenameGroup(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const platformId = content.platform_id as string | undefined;
  const newName = (content.new_name as string | undefined)?.trim();
  if (!platformId || !newName) {
    notifyAgent(session, 'rename_group rejected: platform_id and new_name are required.');
    return;
  }

  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(session, 'rename_group rejected: could not resolve the calling user from the current session.');
    return;
  }

  const mg = getMessagingGroupByPlatform('whatsapp', platformId);
  const targetAgentGroupId = mg
    ? (getMessagingGroupAgents(mg.id)[0]?.agent_group_id ?? session.agent_group_id)
    : session.agent_group_id;
  const access = canAccessAgentGroup(userId, targetAgentGroupId);
  const privileged = access.allowed && ['owner', 'global_admin', 'admin_of_group'].includes(access.reason);
  if (!privileged) {
    notifyAgent(
      session,
      `rename_group rejected: requires owner or admin privileges. Current role for ${userId}: ${access.allowed ? access.reason : access.reason ?? 'unknown'}.`,
    );
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.renameGroup) {
    notifyAgent(session, 'rename_group failed: WhatsApp adapter is not loaded or does not support rename.');
    return;
  }
  if (!adapter.isConnected()) {
    notifyAgent(session, 'rename_group failed: WhatsApp adapter is not connected. Ask the user to retry in a moment.');
    return;
  }

  try {
    await adapter.renameGroup(platformId, newName);
  } catch (err) {
    log.warn('renameGroup threw', { platformId, newName, err });
    notifyAgent(
      session,
      `rename_group failed at WhatsApp: ${err instanceof Error ? err.message : String(err)}. The bot may not be a group admin, or the new name was rejected. NanoClaw DB was not modified.`,
    );
    return;
  }

  if (mg) {
    try {
      updateMessagingGroup(mg.id, { name: newName });
      log.info('rename_group: updated messaging_groups.name', { mgId: mg.id, newName });
    } catch (err) {
      log.warn('rename_group: DB update failed (WA already renamed)', { mgId: mg.id, err });
    }
  } else {
    log.info('rename_group: no messaging_group row to update (group not wired)', { platformId });
  }

  notifyAgent(
    session,
    `Renamed WhatsApp group ${platformId} to "${newName}".\nReport to the user in Spanish: confirm the new name and mention all current members will see the change.`,
  );
}

/**
 * Split a single (messaging_group ↔ this agent_group) wiring off into a
 * brand-new agent group. The new group has its own folder, CLAUDE.local.md,
 * and container — nothing is copied from the source. Used to isolate
 * tenants/clients that currently share an agent so they can no longer
 * leak context via shared memory.
 *
 * Wiring config (engage_mode, session_mode, sender_scope, etc.) is preserved
 * — only the agent_group target changes. The agent_group_members access list
 * does NOT carry over (that's the security point); the operator has to grant
 * access on the new group separately.
 *
 * Privilege: global owner/admin only. Mirrors register_channel's stance —
 * scoped admins should not be able to spin up new agent groups.
 */
export async function applyMigrateToSeparateAgent(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const platformId = content.platform_id as string | undefined;
  const newFolder = (content.new_folder as string | undefined)?.trim();
  const newAgentName = (content.new_agent_name as string | undefined)?.trim();
  const channelType = (content.channel_type as string | undefined) || 'whatsapp';

  if (!platformId || !newFolder || !newAgentName) {
    notifyAgent(
      session,
      'migrate_to_separate_agent rejected: platform_id, new_folder, and new_agent_name are required.',
    );
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(newFolder)) {
    notifyAgent(
      session,
      'migrate_to_separate_agent rejected: new_folder must be alphanumeric, dashes, or underscores only.',
    );
    return;
  }

  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(
      session,
      'migrate_to_separate_agent rejected: could not resolve the calling user from the current session.',
    );
    return;
  }

  // Privilege: global owner/admin only — same gate as register_channel for
  // creating a new agent group. A scoped admin of just one group can't spin
  // up new ones; that's a deliberate access boundary.
  const access = canAccessAgentGroup(userId, session.agent_group_id);
  const allowed = access.allowed && ['owner', 'global_admin'].includes(access.reason);
  if (!allowed) {
    notifyAgent(
      session,
      `migrate_to_separate_agent rejected: requires global owner or admin. Your role for this agent group: ${access.allowed ? access.reason : access.reason ?? 'none'}.`,
    );
    return;
  }

  const mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) {
    notifyAgent(
      session,
      `migrate_to_separate_agent rejected: no messaging_group found for ${channelType}:${platformId}. Use list_channels to see what's wired.`,
    );
    return;
  }

  const wirings = getMessagingGroupAgents(mg.id);
  const currentWiring = wirings.find((w) => w.agent_group_id === session.agent_group_id);
  if (!currentWiring) {
    notifyAgent(
      session,
      `migrate_to_separate_agent rejected: ${platformId} is not wired to this agent group. Migration only works on a channel currently linked to the calling agent group.`,
    );
    return;
  }

  if (getAgentGroupByFolder(newFolder)) {
    notifyAgent(
      session,
      `migrate_to_separate_agent rejected: folder "${newFolder}" already exists. Pick a different folder name.`,
    );
    return;
  }

  // Create new agent group + scaffold filesystem
  const newId = generateId('ag');
  const newAgentGroup = {
    id: newId,
    name: newAgentName,
    folder: newFolder,
    agent_provider: 'claude',
    created_at: new Date().toISOString(),
  };
  try {
    createAgentGroup(newAgentGroup);
    initGroupFilesystem(newAgentGroup);
    log.info('migrate_to_separate_agent: new agent group created', {
      agentGroupId: newId,
      folder: newFolder,
    });
  } catch (err) {
    notifyAgent(
      session,
      `migrate_to_separate_agent failed creating new agent group: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return;
  }

  // Rewire: drop the old (mg, this-agent-group) row, create a fresh one
  // pointing to the new agent group with the same engage/session config.
  // updateMessagingGroupAgent doesn't allow agent_group_id changes by design,
  // so we delete + recreate. New mga id so the old wiring's history is
  // distinct from the new one in any audit logs.
  try {
    const newMgaId = generateId('mga');
    deleteMessagingGroupAgent(currentWiring.id);
    createMessagingGroupAgent({
      id: newMgaId,
      messaging_group_id: mg.id,
      agent_group_id: newId,
      engage_mode: currentWiring.engage_mode,
      engage_pattern: currentWiring.engage_pattern,
      sender_scope: currentWiring.sender_scope,
      ignored_message_policy: currentWiring.ignored_message_policy,
      session_mode: currentWiring.session_mode,
      priority: currentWiring.priority,
      created_at: new Date().toISOString(),
    });
    log.info('migrate_to_separate_agent: rewired', {
      mgId: mg.id,
      from: session.agent_group_id,
      to: newId,
      platformId,
    });
  } catch (err) {
    notifyAgent(
      session,
      `migrate_to_separate_agent: new agent group "${newFolder}" was created but rewiring failed — channel still points to the old group. Error: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return;
  }

  notifyAgent(
    session,
    [
      `Channel ${platformId} migrated to a NEW isolated agent group:`,
      `  • id: ${newId}`,
      `  • folder: groups/${newFolder}/`,
      `  • name: ${newAgentName}`,
      ``,
      `Memory, conversations, and settings from this group were NOT copied — that's the point.`,
      `Subsequent messages from ${platformId} spawn a fresh container in the new group; this group no longer receives traffic from that channel.`,
      `Access list (agent_group_members) does NOT carry over — owner remains global, but admins/members of this group must be granted on the new one separately.`,
      ``,
      `Report to the user in Spanish: confirm the migration, recordar que el agente nuevo arranca sin memoria del actual (eso es el punto, evita leak), y que el siguiente mensaje desde ${platformId} ya cae al nuevo agente.`,
    ].join('\n'),
  );
}
