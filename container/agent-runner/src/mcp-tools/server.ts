/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    // Per-handler timeout: most internal MCP tools just write to outbound.db
    // and return immediately (fire-and-forget). If a handler hangs (network
    // call, DB lock, runaway loop), the SDK's whole turn blocks — the agent
    // can't even receive a tool_result, and the host watchdog has to kill
    // the container. Cap individual handlers at 60s so a slow tool returns
    // an error to the SDK and the turn keeps moving.
    const HANDLER_TIMEOUT_MS = 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ content: { type: 'text'; text: string }[]; isError: true }>(
      (resolve) => {
        timer = setTimeout(() => {
          log(`tool "${name}" timed out after ${HANDLER_TIMEOUT_MS}ms`);
          resolve({
            content: [{ type: 'text', text: `Error: tool "${name}" timed out after ${HANDLER_TIMEOUT_MS / 1000}s` }],
            isError: true,
          });
        }, HANDLER_TIMEOUT_MS);
      },
    );
    try {
      return await Promise.race([tool.handler(args ?? {}), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
