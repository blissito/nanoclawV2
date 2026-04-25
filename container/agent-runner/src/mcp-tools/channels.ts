/**
 * Channel management MCP tools.
 *
 * `register_channel` lets an agent wire a new chat/group/channel to itself
 * (or to another agent group) directly from within a conversation. The host
 * enforces admin/owner privilege on the caller — the tool is fire-and-forget
 * from the container's perspective, the host validates and applies.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const VALID_ISOLATION = ['shared-session', 'separate-session', 'separate-agent'] as const;
const VALID_ENGAGE = ['pattern', 'mention', 'mention-sticky'] as const;
const VALID_POLICY = ['strict', 'request_approval', 'public'] as const;

export const registerChannel: McpToolDefinition = {
  tool: {
    name: 'register_channel',
    description:
      'Wire a chat/group/channel to an agent group so the agent starts receiving messages from it. The caller must be owner or admin of the target agent group. Host validates synchronously.\n\nIsolation options (see docs/isolation-model.md):\n  • shared-session   — this channel joins the same conversation as the current agent\n  • separate-session — this channel shares the agent (workspace + memory) but has its own conversation thread\n  • separate-agent   — a brand-new agent group is created for this channel (requires folder name)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        platform_id: {
          type: 'string',
          description: 'Channel-native id. WhatsApp group: "<id>@g.us". WhatsApp DM: "<phone>@s.whatsapp.net". Telegram: "<chat_id>". Check the channel adapter\'s SKILL.md for exact format.',
        },
        channel_type: {
          type: 'string',
          description: 'Channel adapter name: "whatsapp" | "telegram" | "discord" | "slack" | …',
        },
        name: {
          type: 'string',
          description: 'Human-readable display name for the chat/group.',
        },
        isolation: {
          type: 'string',
          enum: [...VALID_ISOLATION],
          description: 'How this channel relates to agent groups. See tool description.',
        },
        folder: {
          type: 'string',
          description: 'Folder name under groups/ for isolation="separate-agent" (e.g. "family-chat"). Ignored otherwise.',
        },
        agent_group_id: {
          type: 'string',
          description: 'Target agent group id for isolation="shared-session" or "separate-session". Defaults to the calling agent\'s own group.',
        },
        engage_mode: {
          type: 'string',
          enum: [...VALID_ENGAGE],
          description: 'When does the agent engage? "pattern"=regex on text (default if omitted). "mention"=platform @-mention. "mention-sticky"=threaded platforms only.',
        },
        engage_pattern: {
          type: 'string',
          description: 'Regex for engage_mode="pattern". Use "." for "always engage". For a group piggyback-WhatsApp, usually "\\\\b<assistant-name>\\\\b/i".',
        },
        unknown_sender_policy: {
          type: 'string',
          enum: [...VALID_POLICY],
          description: 'What to do with messages from senders who are not owner/admin/member. "strict"=drop silently. "request_approval"=DM owner for approval (default). "public"=accept any sender.',
        },
        is_group: {
          type: 'boolean',
          description: 'True if this is a group chat, false for a 1:1 DM. If omitted, inferred from platform_id shape where possible.',
        },
        assistant_name: {
          type: 'string',
          description: 'Assistant display name for isolation="separate-agent" (defaults to the current agent name).',
        },
      },
      required: ['platform_id', 'channel_type', 'name', 'isolation'],
    },
  },
  async handler(args) {
    const platform_id = args.platform_id as string;
    const channel_type = args.channel_type as string;
    const name = args.name as string;
    const isolation = args.isolation as (typeof VALID_ISOLATION)[number];

    if (!platform_id || !channel_type || !name) return err('platform_id, channel_type, and name are required');
    if (!VALID_ISOLATION.includes(isolation)) return err(`isolation must be one of: ${VALID_ISOLATION.join(', ')}`);

    const folder = args.folder as string | undefined;
    if (isolation === 'separate-agent' && !folder) return err('folder is required when isolation="separate-agent"');

    const engage_mode = (args.engage_mode as string | undefined) || 'pattern';
    if (!VALID_ENGAGE.includes(engage_mode as (typeof VALID_ENGAGE)[number])) {
      return err(`engage_mode must be one of: ${VALID_ENGAGE.join(', ')}`);
    }
    const engage_pattern = (args.engage_pattern as string | undefined) ?? (engage_mode === 'pattern' ? '.' : null);
    if (engage_mode === 'pattern' && engage_pattern) {
      try {
        new RegExp(engage_pattern);
      } catch {
        return err(`engage_pattern is not a valid regex: ${engage_pattern}`);
      }
    }

    const unknown_sender_policy = (args.unknown_sender_policy as string | undefined) || 'request_approval';
    if (!VALID_POLICY.includes(unknown_sender_policy as (typeof VALID_POLICY)[number])) {
      return err(`unknown_sender_policy must be one of: ${VALID_POLICY.join(', ')}`);
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'register_channel',
        platform_id,
        channel_type,
        name,
        isolation,
        folder,
        agent_group_id: args.agent_group_id,
        engage_mode,
        engage_pattern,
        unknown_sender_policy,
        is_group: args.is_group,
        assistant_name: args.assistant_name,
      }),
    });

    log(`register_channel: ${requestId} → ${channel_type}:${platform_id} (${isolation})`);
    return ok(`Registration request submitted for "${name}". The host will validate your privilege and wire it; I'll notify you when it's live (usually within a few seconds).`);
  },
};

export const listChannels: McpToolDefinition = {
  tool: {
    name: 'list_channels',
    description:
      'List all messaging channels (chats/groups/DMs) currently wired to agent groups in this NanoClaw install. Read-only, no privilege gate. The host writes the list back as a chat message to this session — you will see it in your next turn, not in this tool\'s return value.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_type: {
          type: 'string',
          description: 'Optional filter by adapter name (e.g. "whatsapp"). Omit for all channels.',
        },
      },
    },
  },
  async handler(args) {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'list_channels',
        channel_type: args.channel_type,
      }),
    });
    log(`list_channels: ${requestId}`);
    return ok('Channel list requested. The host will send me the results in my next message — I should wait for them before answering the user.');
  },
};

export const listDiscoveredGroups: McpToolDefinition = {
  tool: {
    name: 'list_discovered_groups',
    description:
      'List chats/groups that the underlying channel adapter has seen but that are not necessarily wired to an agent yet (e.g. every WhatsApp group your number is a member of, or every Telegram chat that has messaged the bot). Use this to resolve a group name to its platform_id before calling `register_channel`. Read-only, fire-and-forget; result arrives as a chat message in your next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_type: {
          type: 'string',
          description: 'Optional adapter filter, e.g. "whatsapp".',
        },
        name_contains: {
          type: 'string',
          description: 'Optional case-insensitive substring match on the chat name.',
        },
      },
    },
  },
  async handler(args) {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'list_discovered_groups',
        channel_type: args.channel_type,
        name_contains: args.name_contains,
      }),
    });
    log(`list_discovered_groups: ${requestId}`);
    return ok('Discovered-groups list requested. The host will send it as my next message — I should wait for it before answering the user.');
  },
};

export const createGroup: McpToolDefinition = {
  tool: {
    name: 'create_group',
    description:
      'Create a BRAND-NEW chat/group on the platform under the bot account, then auto-wire it to an agent group in a single step. Today only WhatsApp supports this. The bot is the only initial member; users join via the invite link returned in the result.\n\nIMPORTANT: only call this when the user wants to create a group that does not yet exist. If the group might already be on the platform (you saw it in `list_discovered_groups`, the user mentioned it casually, etc.), use `register_channel` on the existing one instead.\n\nFire-and-forget: result arrives as a system chat message in your next turn (not in this tool\'s return value). The result will include the platform_id and the invite link to share with the user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Display name / subject for the new group.',
        },
        isolation: {
          type: 'string',
          enum: [...VALID_ISOLATION],
          description: 'How the new group relates to agent groups. Defaults to "separate-session" (same agent as the caller, independent conversation thread).',
        },
        agent_group_id: {
          type: 'string',
          description: 'Target agent group id for shared-session / separate-session. Defaults to the calling agent\'s own group.',
        },
        folder: {
          type: 'string',
          description: 'Folder name under groups/ if isolation="separate-agent" (e.g. "family-chat"). Ignored otherwise.',
        },
        engage_mode: {
          type: 'string',
          enum: [...VALID_ENGAGE],
          description: 'Engage mode for the wiring. Defaults to "pattern" with engage_pattern="\\\\b<assistant-name>\\\\b".',
        },
        engage_pattern: {
          type: 'string',
          description: 'Regex source string for engage_mode="pattern". Use `\\\\b[Gg]hosty\\\\b` style. NEVER use `/pattern/i` literal-flags style — JS new RegExp will treat it as literal characters. Default: bare assistant name in word boundaries.',
        },
        unknown_sender_policy: {
          type: 'string',
          enum: [...VALID_POLICY],
          description: 'Default "request_approval". For a brand-new group where you may invite friends/colleagues this is the right default — first time someone new writes you get a DM to approve.',
        },
        assistant_name: {
          type: 'string',
          description: 'Assistant display name for isolation="separate-agent" (defaults to the current agent name).',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return err('name is required');
    }

    const isolation = (args.isolation as string | undefined) ?? 'separate-session';
    if (!VALID_ISOLATION.includes(isolation as (typeof VALID_ISOLATION)[number])) {
      return err(`isolation must be one of: ${VALID_ISOLATION.join(', ')}`);
    }
    if (isolation === 'separate-agent' && !args.folder) {
      return err('folder is required when isolation="separate-agent"');
    }

    const engage_mode = (args.engage_mode as string | undefined) ?? 'pattern';
    if (!VALID_ENGAGE.includes(engage_mode as (typeof VALID_ENGAGE)[number])) {
      return err(`engage_mode must be one of: ${VALID_ENGAGE.join(', ')}`);
    }
    const engage_pattern = (args.engage_pattern as string | undefined) ?? null;
    if (engage_mode === 'pattern' && engage_pattern) {
      try {
        new RegExp(engage_pattern);
      } catch {
        return err(`engage_pattern is not a valid regex: ${engage_pattern}`);
      }
    }

    const unknown_sender_policy = (args.unknown_sender_policy as string | undefined) ?? 'request_approval';
    if (!VALID_POLICY.includes(unknown_sender_policy as (typeof VALID_POLICY)[number])) {
      return err(`unknown_sender_policy must be one of: ${VALID_POLICY.join(', ')}`);
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_group',
        name: name.trim(),
        isolation,
        agent_group_id: args.agent_group_id,
        folder: args.folder,
        engage_mode,
        engage_pattern,
        unknown_sender_policy,
        assistant_name: args.assistant_name,
      }),
    });

    log(`create_group: ${requestId} → "${name}" (${isolation})`);
    return ok(`Create-group request submitted for "${name}". The host will create the WhatsApp group, wire it to the agent, and send me the result (including the invite link to share with the user) in my next message. I should wait for that before reporting anything concrete.`);
  },
};

export const getInviteLink: McpToolDefinition = {
  tool: {
    name: 'get_invite_link',
    description:
      'Fetch a WhatsApp group invite link the user can share so others can join. Read-ish (regenerates a code on demand). Fire-and-forget; result arrives in the next chat message. The bot must be a group admin in the target group.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        platform_id: {
          type: 'string',
          description: 'WhatsApp group JID (ends in @g.us). Resolve via list_discovered_groups or list_channels first if you only have a name.',
        },
      },
      required: ['platform_id'],
    },
  },
  async handler(args) {
    const platform_id = args.platform_id as string;
    if (!platform_id) return err('platform_id is required');
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'get_invite_link', platform_id }),
    });
    log(`get_invite_link: ${requestId} → ${platform_id}`);
    return ok('Invite-link request submitted. The host will send me the link in my next message — wait for it before answering the user.');
  },
};

export const leaveGroup: McpToolDefinition = {
  tool: {
    name: 'leave_group',
    description:
      'Bot leaves a WhatsApp group AND unwires the corresponding NanoClaw messaging_group + agent wiring. Visible to other group members ("Ghosty left"). Hard to reverse — only undone by re-joining via invite link and re-running register_channel. **Always confirm with the user before calling.** Fire-and-forget; result in next message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        platform_id: {
          type: 'string',
          description: 'WhatsApp group JID (ends in @g.us). Use list_channels to find the JID for a wired group.',
        },
      },
      required: ['platform_id'],
    },
  },
  async handler(args) {
    const platform_id = args.platform_id as string;
    if (!platform_id) return err('platform_id is required');
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'leave_group', platform_id }),
    });
    log(`leave_group: ${requestId} → ${platform_id}`);
    return ok('Leave-group request submitted. The host will leave on WhatsApp and clean up the wiring; result in my next message.');
  },
};

export const renameGroup: McpToolDefinition = {
  tool: {
    name: 'rename_group',
    description:
      'Rename a WhatsApp group (changes the subject visible to all members). Bot must be a group admin. Updates both WhatsApp and the NanoClaw messaging_groups.name column. Fire-and-forget; result in next message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        platform_id: {
          type: 'string',
          description: 'WhatsApp group JID (ends in @g.us).',
        },
        new_name: {
          type: 'string',
          description: 'New display name / subject for the group.',
        },
      },
      required: ['platform_id', 'new_name'],
    },
  },
  async handler(args) {
    const platform_id = args.platform_id as string;
    const new_name = (args.new_name as string)?.trim();
    if (!platform_id) return err('platform_id is required');
    if (!new_name) return err('new_name is required');
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'rename_group', platform_id, new_name }),
    });
    log(`rename_group: ${requestId} → ${platform_id} = "${new_name}"`);
    return ok('Rename-group request submitted. Result in my next message.');
  },
};

export const updateChannelPolicy: McpToolDefinition = {
  tool: {
    name: 'update_channel_policy',
    description:
      "Change `unknown_sender_policy` of an existing wired channel. Use when user asks to make a group public/strict, or to start/stop requesting approval for unknown senders. Caller must be owner/admin of the agent group. Fire-and-forget; result in next message.\n\n  • strict           — drop unknown senders silently\n  • request_approval — DM owner asking to allow (default for new groups)\n  • public           — accept any sender (no gate)",
    inputSchema: {
      type: 'object' as const,
      properties: {
        platform_id: {
          type: 'string',
          description: 'Channel platform_id of the wired channel (e.g., WhatsApp group "<id>@g.us").',
        },
        unknown_sender_policy: {
          type: 'string',
          enum: ['strict', 'request_approval', 'public'],
          description: 'New policy.',
        },
        channel_type: {
          type: 'string',
          description: 'Channel adapter name. Defaults to "whatsapp" if omitted.',
        },
      },
      required: ['platform_id', 'unknown_sender_policy'],
    },
  },
  async handler(args) {
    const platform_id = args.platform_id as string;
    const unknown_sender_policy = args.unknown_sender_policy as string;
    const channel_type = (args.channel_type as string) || 'whatsapp';
    if (!platform_id) return err('platform_id is required');
    if (!unknown_sender_policy) return err('unknown_sender_policy is required');
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'update_channel_policy',
        platform_id,
        unknown_sender_policy,
        channel_type,
      }),
    });
    log(`update_channel_policy: ${requestId} → ${platform_id} = ${unknown_sender_policy}`);
    return ok('Policy update submitted. Result in my next message.');
  },
};

export const migrateToSeparateAgent: McpToolDefinition = {
  tool: {
    name: 'migrate_to_separate_agent',
    description:
      "Split a wired channel away from THIS agent group into a NEW, isolated agent group with its own folder, CLAUDE.local.md, and container. Use to separate clients/tenants that currently share an agent so they cannot leak context via shared memory or conversations. The new agent group starts CLEAN — no copy of memory, settings, or history from this one (that's the point). Caller must be global owner/admin. Fire-and-forget; result in next message.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        platform_id: {
          type: 'string',
          description: 'Channel platform_id of the wired channel to split off (e.g. "<id>@g.us" for a WhatsApp group, "<phone>@s.whatsapp.net" for a DM).',
        },
        new_folder: {
          type: 'string',
          description: 'Folder name for the new agent group under groups/. Alphanumeric, dashes, underscores. Must not already exist.',
        },
        new_agent_name: {
          type: 'string',
          description: 'Display name for the new agent group.',
        },
        channel_type: {
          type: 'string',
          description: 'Channel adapter name. Defaults to "whatsapp" if omitted.',
        },
      },
      required: ['platform_id', 'new_folder', 'new_agent_name'],
    },
  },
  async handler(args) {
    const platform_id = args.platform_id as string;
    const new_folder = args.new_folder as string;
    const new_agent_name = args.new_agent_name as string;
    const channel_type = (args.channel_type as string) || 'whatsapp';
    if (!platform_id) return err('platform_id is required');
    if (!new_folder) return err('new_folder is required');
    if (!new_agent_name) return err('new_agent_name is required');
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'migrate_to_separate_agent',
        platform_id,
        new_folder,
        new_agent_name,
        channel_type,
      }),
    });
    log(`migrate_to_separate_agent: ${requestId} → ${platform_id} → ${new_folder}`);
    return ok('Migration submitted. Result in my next message.');
  },
};

registerTools([
  registerChannel,
  listChannels,
  listDiscoveredGroups,
  createGroup,
  getInviteLink,
  leaveGroup,
  renameGroup,
  updateChannelPolicy,
  migrateToSeparateAgent,
]);
