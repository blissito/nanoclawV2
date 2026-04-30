/**
 * Agent management MCP tools: create_agent, restart_container.
 *
 * send_to_agent was removed — sending to another agent is now just
 * send_message(to="agent-name") since agents and channels share the
 * unified destinations namespace.
 *
 * create_agent is admin-only. Non-admin containers never see this tool
 * (see mcp-tools/index.ts). The host re-checks permission on receive.
 *
 * restart_container kills a session's container; the host sweep respawns
 * it on the next inbound message. Host re-checks permission on receive
 * (admin_of_group or higher for the target agent group).
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

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a long-lived companion sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. Admin-only. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name (also becomes your destination name for this agent)' },
        instructions: { type: 'string', description: 'CLAUDE.md content for the new agent (personality, role, instructions)' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
      }),
    });

    log(`create_agent: ${requestId} → "${name}"`);
    return ok(`Creating agent "${name}". You will be notified when it is ready.`);
  },
};

export const restartContainer: McpToolDefinition = {
  tool: {
    name: 'restart_container',
    description:
      "Kill the container for an agent group. The host respawns it on the next inbound message. Use to recover a stuck agent or to apply config changes after editing groups/<folder>/CLAUDE.md or container.json. Requires admin_of_group or higher for the target agent group. Defaults to the caller's own agent group if agent_group_id is omitted. Fire-and-forget; result in next message.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_group_id: {
          type: 'string',
          description: "Target agent_group_id. Omit to restart the caller's own agent group.",
        },
        reason: {
          type: 'string',
          description: 'Short human-readable reason for the restart (logged + reported back). Optional.',
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
        action: 'restart_container',
        agent_group_id: (args.agent_group_id as string | undefined) || null,
        reason: (args.reason as string | undefined) || null,
      }),
    });
    log(`restart_container: ${requestId} → ${args.agent_group_id || '<self>'}`);
    return ok('Restart requested. Result in my next message.');
  },
};

registerTools([createAgent, restartContainer]);
