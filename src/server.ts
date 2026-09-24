import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export function createBusServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'agent-bus', version: '0.1.0' });

  server.registerTool('ping', { description: 'Health check. Returns "pong".' }, () => text('pong'));

  server.registerTool(
    'whoami',
    {
      description:
        'Returns the role this connection is bound to (orchestrator, implementer or reviewer).',
    },
    () => text(JSON.stringify({ role: ctx.role })),
  );

  return server;
}
