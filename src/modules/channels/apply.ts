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

export async function applyCreateGroup(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const name = (content.name as string | undefined)?.trim();
  if (!name) {
    notifyAgent(session, 'create_group rejected: name is required.');
    return;
  }

  const isolation = (content.isolation as Isolation | undefined) ?? 'separate-session';
  const folder = content.folder as string | undefined;
  if (isolation === 'separate-agent' && !folder) {
    notifyAgent(session, 'create_group rejected: isolation="separate-agent" requires a folder name.');
    return;
  }

  const explicitAgentGroupId = content.agent_group_id as string | undefined;
  const engage_mode = (content.engage_mode as EngageMode | undefined) ?? 'pattern';
  const rawPattern =
    (content.engage_pattern as string | null | undefined) ??
    (engage_mode === 'pattern' ? `\\b${ASSISTANT_NAME}\\b` : null);
  const engage_pattern = sanitizeEnginePattern(rawPattern);
  const unknown_sender_policy =
    (content.unknown_sender_policy as UnknownSenderPolicy | undefined) ?? 'request_approval';
  const assistant_name = (content.assistant_name as string | undefined) || ASSISTANT_NAME;

  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(session, 'create_group rejected: could not resolve the calling user from the current session.');
    return;
  }

  // Resolve target agent group BEFORE creating the WhatsApp group, so we
  // don't end up with an orphan WA group if privilege fails. Mirror the
  // logic in applyRegisterChannel to keep behavior consistent.
  let targetAgentGroupId: string;
  if (isolation === 'separate-agent') {
    const existing = getAgentGroupByFolder(folder!);
    if (existing) {
      targetAgentGroupId = existing.id;
    } else {
      const selfAccess = canAccessAgentGroup(userId, session.agent_group_id);
      if (!selfAccess.allowed || !['owner', 'global_admin'].includes(selfAccess.reason)) {
        notifyAgent(
          session,
          `create_group rejected: creating a new agent group requires global owner or admin. Your role (${selfAccess.allowed ? selfAccess.reason : 'none'}) is insufficient.`,
        );
        return;
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
      log.info('Agent group created via create_group', { agentGroupId: newId, folder });
    }
  } else {
    targetAgentGroupId = explicitAgentGroupId ?? session.agent_group_id;
    if (!getAgentGroup(targetAgentGroupId)) {
      notifyAgent(session, `create_group rejected: agent_group_id "${targetAgentGroupId}" does not exist.`);
      return;
    }
  }

  const access = canAccessAgentGroup(userId, targetAgentGroupId);
  const privileged = access.allowed && ['owner', 'global_admin', 'admin_of_group'].includes(access.reason);
  if (!privileged) {
    notifyAgent(
      session,
      `create_group rejected: you must be owner or admin of the target agent group. Current role for ${userId}: ${access.allowed ? access.reason : access.reason ?? 'unknown'}.`,
    );
    return;
  }

  // Find the WhatsApp adapter (only WA implements createGroup today).
  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.createGroup) {
    notifyAgent(
      session,
      'create_group failed: no WhatsApp adapter is loaded that supports createGroup. Tell the user this install does not have group creation wired in yet.',
    );
    return;
  }
  if (!adapter.isConnected()) {
    notifyAgent(
      session,
      'create_group failed: the WhatsApp adapter is not connected right now. The bot needs an active WhatsApp session before it can create groups. Ask the user to wait a moment and retry.',
    );
    return;
  }

  // 1) Create the group on the platform. If this throws we don't write anything to the DB.
  let platformId: string;
  let inviteLink: string | null = null;
  try {
    const result = await adapter.createGroup(name);
    platformId = result.platformId;
    inviteLink = result.inviteLink;
  } catch (err) {
    log.error('createGroup failed at adapter', { name, err });
    notifyAgent(
      session,
      `create_group failed: WhatsApp rejected the group creation (${err instanceof Error ? err.message : String(err)}). Nothing was wired. Tell the user the platform refused — usually a transient connection issue, sometimes an account restriction.`,
    );
    return;
  }

  // 2) Persist the messaging_group + wiring. If THIS fails after the WA
  //    group exists, we surface the partial state honestly so the agent
  //    doesn't claim success or try to recreate.
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
    log.info('Messaging group created via create_group', { id: mg.id, platform_id: platformId });

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
    log.info('Channel wired via create_group', {
      messagingGroupId: mg.id,
      agentGroupId: targetAgentGroupId,
      isolation,
      engage_mode,
    });

    // 3) Pre-populate discovered_channels so list_discovered_groups sees the
    //    new group on the very next call (without waiting for Baileys' next
    //    metadata sync tick).
    upsertDiscoveredChannel('whatsapp', platformId, name, true);

    notifyAgent(
      session,
      `WhatsApp group "${name}" created and wired.\nplatform_id=${platformId}\nagent_group_id=${targetAgentGroupId}\nisolation=${isolation}, engage=${engage_mode}${engage_pattern ? `:${engage_pattern}` : ''}, sender_policy=${unknown_sender_policy}\ninvite_link=${inviteLink ?? '(WhatsApp did not return an invite link this time — you can ask the user to share it manually from inside the group)'}\n\nReport to the user in Spanish:\n  • The group is created and you are listening in it.\n  • Share the invite link so they (and others) can join.\n  • Note that there can be a 1-2 second lag for WhatsApp to fully sync the group state — first message in the group might take a moment to engage.`,
    );
  } catch (err) {
    log.error('create_group post-create wiring failed', { platformId, err });
    notifyAgent(
      session,
      `Partial failure on create_group: the WhatsApp group "${name}" was created on the platform (platform_id=${platformId}, invite_link=${inviteLink ?? 'unknown'}), BUT writing the wiring to the central DB failed (${err instanceof Error ? err.message : String(err)}).\n\nReport this to the user honestly: the group exists in WhatsApp (share the invite link if available), but I am NOT yet listening in it. Offer to retry registration with: register_channel platform_id="${platformId}" channel_type="whatsapp" name="${name}" isolation="${isolation}".`,
    );
  }
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
