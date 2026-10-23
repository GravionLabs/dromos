import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BusEvents } from './bus-events.js';
import { type BusLog, createBusLog } from './bus-log.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HookEventSchema, type Role, RoleSchema } from './schemas.js';
import { createBusServer } from './server.js';

export interface HttpOptions {
  config: Config;
  db: Db;
  /** Shared wake-up channel for `inbox`; created when omitted. */
  events?: BusEvents;
  /** Human-readable log; defaults to `<dataDir>/bus.log`. */
  log?: BusLog;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  role: Role;
  agentId: string;
}

export interface RunningHttp {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const MCP_PATH = /^\/mcp\/([^/]+)\/?$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_CLI = 'unknown';

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

export async function startHttp({
  config,
  db,
  events = new BusEvents(),
  log = createBusLog(config.dataDir),
}: HttpOptions): Promise<RunningHttp> {
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

    const header = req.headers['x-agent-id'];
    const requested = Array.isArray(header) ? header[0] : header;
    if (requested !== undefined && !AGENT_ID.test(requested)) {
      sendJson(res, 400, { error: 'invalid X-Agent-Id' });
      return;
    }
    if (session && requested !== undefined && session.agentId !== requested) {
      sendJson(res, 403, { error: `session belongs to agent ${session.agentId}` });
      return;
    }
    if (session) {
      res.setHeader('x-agent-id', session.agentId);
    }

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
        const agentId = requested ?? `${role}-${randomUUID().slice(0, 8)}`;
        const known = db.getAgent(agentId);
        if (known && known.role !== role) {
          sendJson(res, 409, { error: `agent ${agentId} is registered as ${known.role}` });
          return;
        }
        if (!known) {
          db.insertAgent({ id: agentId, role, cli: DEFAULT_CLI });
          db.insertEvent(role, 'agent.registered', { role, cli: DEFAULT_CLI, model: null });
          log.logLine('STATE', `${agentId} registered as ${role}`);
        }
        res.setHeader('x-agent-id', agentId);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, role, agentId });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        await createBusServer({ role, agentId, db, config, events, log }).connect(transport);
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

  async function handleEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const parsed = HookEventSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: z.prettifyError(parsed.error) });
      return;
    }
    const { role, cli, state, model } = parsed.data;
    db.insertEvent(role, `hook:${state}`, parsed.data);
    log.logLine('HOOK', `${role} ${state} (${cli}${model ? `, ${model}` : ''})`);
    res.writeHead(204).end();
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/events') {
      handleEvent(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
        }
      });
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
