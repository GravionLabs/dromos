import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { type Role, RoleSchema } from './schemas.js';
import { createBusServer } from './server.js';

export interface HttpOptions {
  config: Config;
  db: Db;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  role: Role;
}

export interface RunningHttp {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const MCP_PATH = /^\/mcp\/([^/]+)\/?$/;

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

export async function startHttp({ config, db }: HttpOptions): Promise<RunningHttp> {
  const { host, port } = config;
  const sessions = new Map<string, Session>();

  async function handleMcp(req: IncomingMessage, res: ServerResponse, role: Role): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (session && session.role !== role) {
      sendJson(res, 403, { error: `session belongs to role ${session.role}, not ${role}` });
      return;
    }
    const existing = session?.transport;

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
            sessions.set(id, { transport, role });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        await createBusServer({ role, db, config }).connect(transport);
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
    const match = MCP_PATH.exec(path);
    if (match) {
      const role = RoleSchema.safeParse(decodeURIComponent(match[1] ?? ''));
      if (!role.success) {
        sendJson(res, 404, { error: 'unknown role' });
        return;
      }
      handleMcp(req, res, role.data).catch((error: unknown) => {
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
      await Promise.all([...sessions.values()].map((s) => s.transport.close()));
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
