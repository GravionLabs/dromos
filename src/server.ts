import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { registerInboxTool } from './tools/inbox.js';
import { registerMessagingTools } from './tools/messaging.js';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export function createBusServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'dromos', version: '0.1.0' });

  server.registerTool('ping', { description: 'Health check. Returns "pong".' }, () => text('pong'));

  server.registerTool(
    'whoami',
    {
      description:
        'Returns the role (orchestrator, implementer or reviewer) and the agent id this connection is bound to.',
    },
    () => text(JSON.stringify({ role: ctx.role, agentId: ctx.agentId })),
  );

  registerMessagingTools(server, ctx);
  registerInboxTool(server, ctx);

  return server;
}
