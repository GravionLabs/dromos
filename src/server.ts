import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function createBusServer(): McpServer {
  const server = new McpServer({ name: 'agent-bus', version: '0.1.0' });

  server.registerTool('ping', { description: 'Health check. Returns "pong".' }, () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));

  return server;
}
