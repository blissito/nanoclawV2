/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
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

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string | undefined,
):
  | { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string }
  | { error: string } {
  if (!to) {
    // Default: reply to whatever thread/channel this session is bound to.
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId
        ? session.thread_id
        : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description:
      'Send a message to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

/**
 * Map common emoji shortcodes to raw unicode. Channel adapters (WhatsApp/
 * Baileys) need the unicode character, not the shortcode string. Without
 * this, the agent calls add_reaction with "eyes" and the user sees the
 * literal text "eyes" as the reaction.
 */
const EMOJI_SHORTCODES: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  check: '✅',
  done: '✅',
  x: '❌',
  red_x: '❌',
  failed: '❌',
  thumbs_up: '👍',
  thumbsup: '👍',
  '+1': '👍',
  thumbs_down: '👎',
  thumbsdown: '👎',
  '-1': '👎',
  heart: '❤️',
  red_heart: '❤️',
  fire: '🔥',
  rocket: '🚀',
  warning: '⚠️',
  bulb: '💡',
  pray: '🙏',
  clap: '👏',
  ok_hand: '👌',
  laughing: '😂',
  joy: '😂',
  sob: '😭',
  thinking: '🤔',
  hourglass: '⏳',
  zap: '⚡',
  sparkles: '✨',
  tada: '🎉',
};

function resolveEmoji(input: string): string {
  // Already unicode? (heuristic: short string containing emoji property)
  if (/\p{Extended_Pictographic}/u.test(input)) return input;
  return EMOJI_SHORTCODES[input.toLowerCase()] ?? input;
}

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji: resolveEmoji(emoji) }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

/**
 * WhatsApp-flavored group management tools. The host adapter routes these
 * by `content.operation`. Bot must be admin of the target group; non-admin
 * calls fail silently host-side (logged, no error to user).
 */
export const updateGroupSubject: McpToolDefinition = {
  tool: {
    name: 'update_group_subject',
    description:
      'Change the title/subject of the WhatsApp group this conversation is in. Bot must be admin.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'New group title (max 100 chars)' },
        to: { type: 'string', description: 'Destination name (optional if single group)' },
      },
      required: ['subject'],
    },
  },
  async handler(args) {
    const subject = (args.subject as string)?.trim();
    if (!subject) return err('subject is required');
    if (subject.length > 100) return err('subject must be 100 chars or less');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'group_subject', subject }),
    });
    log(`update_group_subject: → ${routing.resolvedName}: "${subject}"`);
    return ok(`Group title change queued for ${routing.resolvedName}`);
  },
};

export const updateGroupPhoto: McpToolDefinition = {
  tool: {
    name: 'update_group_photo',
    description:
      "Change the photo/avatar of the WhatsApp group this conversation is in. Bot must be admin. Pass an image file path (relative to /workspace/agent/ or absolute).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to image file (jpg/png)' },
        to: { type: 'string', description: 'Destination name (optional if single group)' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = path.basename(resolvedPath);
    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'group_photo', files: [filename] }),
    });
    log(`update_group_photo: → ${routing.resolvedName} (${filename})`);
    return ok(`Group photo change queued for ${routing.resolvedName}`);
  },
};

export const shareGroupInviteLink: McpToolDefinition = {
  tool: {
    name: 'share_group_invite_link',
    description:
      "Generate the WhatsApp group invite link and send it as a chat message. Bot must be admin. Optional `text` is prepended to the link.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Optional text to prepend (e.g., "Join our group:")' },
        to: { type: 'string', description: 'Destination name (optional if single group)' },
      },
    },
  },
  async handler(args) {
    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        operation: 'group_invite_link',
        text: (args.text as string) || '',
      }),
    });
    log(`share_group_invite_link: → ${routing.resolvedName}`);
    return ok(`Invite link send queued for ${routing.resolvedName}`);
  },
};

registerTools([
  sendMessage,
  sendFile,
  editMessage,
  addReaction,
  updateGroupSubject,
  updateGroupPhoto,
  shareGroupInviteLink,
]);
