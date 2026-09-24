import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createBusServer } from './server.js';

export interface HttpOptions {
  host: string;
  port: number;
}

export interface RunningHttp {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const MCP_PATH = /^\/mcp\/([^/?]+)\/?$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

export async function startHttp({ host, port }: HttpOptions): Promise<RunningHttp> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (sessionId === undefined && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };
        await createBusServer().connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      sendJson(res, 400, { error: 'missing or unknown mcp-session-id' });
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        sendJson(res, 400, { error: 'missing or unknown mcp-session-id' });
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (MCP_PATH.test(path)) {
      handleMcp(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
        }
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    server,
    url: `http://${host}:${address.port}`,
    async close() {
      await Promise.all([...transports.values()].map((t) => t.close()));
      transports.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
