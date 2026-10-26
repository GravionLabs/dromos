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
import { parseEventQuery } from './event-query.js';
import { EventValidationError, recordEvent } from './event-store.js';
import { createEventStream, createHostGuard } from './event-stream.js';
import { type BusEvent, BusEventSchema, INGEST_TYPES, isIngestType } from './events/schema.js';
import { startLeaseRenewal } from './run-lease.js';
import { type AgentState, HookEventSchema, type Role, RoleSchema } from './schemas.js';
import { createBusServer } from './server.js';

export interface HttpOptions {
  config: Config;
  db: Db;
  /** Shared wake-up channel for `inbox`; created when omitted. */
  events?: BusEvents;
  /** Human-readable log; defaults to `<dataDir>/bus.log`. */
  log?: BusLog;
  /** Heartbeat interval of `GET /events/stream` in ms; defaults to 15 s. */
  heartbeatMs?: number;
  /** Concurrent `GET /events/stream` connections; defaults to 64. */
  maxEventStreams?: number;
  /** Live backlog in bytes after which a slow stream client is disconnected; defaults to 1 MiB. */
  maxStreamBufferedBytes?: number;
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
/** Printable ASCII token for X-Agent-Cli / X-Agent-Model. */
const CLI_VALUE = /^[\x21-\x7e]{1,64}$/;
const MODEL_VALUE = /^[\x21-\x7e]{1,128}$/;
/**
 * Upper bound on registered agents; stops unauthenticated initialize calls from growing the table.
 * Known limit: within the current trust model (no authentication, loopback only) a local caller can
 * still fill the cap and lock out new agents. Exited rows are not reclaimed; a real fix needs auth.
 */
export const MAX_AGENTS = 1000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Request body over the cap given to `readJson`. */
class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body over ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

/** Largest `POST /ingest` body in bytes; bigger bodies get 413. */
export const MAX_INGEST_BODY_BYTES = 1024 * 1024;
/** Most events in one `POST /ingest` array; longer arrays get 413. */
export const MAX_INGEST_BATCH = 100;

async function readJson(
  req: IncomingMessage,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<unknown> {
  // Event listeners rather than `for await`: leaving an async iterator early destroys the request
  // and with it the socket, so an over-cap client would never see its 413.
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off('data', onData);
        req.off('end', onEnd);
        req.pause();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => resolve(Buffer.concat(chunks).toString('utf8'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', reject);
  });
  return raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

/** Body bytes discarded after a 413 before the connection is closed instead. */
const MAX_DRAIN_BYTES = 8 * MAX_INGEST_BODY_BYTES;

/**
 * 413 for an oversized body. The rest of the body is drained unparsed and the reply written once
 * it ends, so the client reads the 413 instead of a reset and a keep-alive connection stays
 * usable. A body still going after `MAX_DRAIN_BYTES` gets the 413 with `Connection: close`.
 */
function sendTooLarge(req: IncomingMessage, res: ServerResponse): void {
  const body = JSON.stringify({ error: `body over ${MAX_INGEST_BODY_BYTES} bytes` });
  const reply = (close: boolean): void => {
    if (res.headersSent) {
      return;
    }
    res.writeHead(413, {
      'content-type': 'application/json',
      ...(close ? { connection: 'close' } : {}),
    });
    res.end(body);
  };
  if (req.complete) {
    reply(false);
    return;
  }
  let drained = 0;
  const onData = (chunk: Buffer): void => {
    drained += chunk.length;
    if (drained > MAX_DRAIN_BYTES) {
      req.off('data', onData);
      reply(true);
    }
  };
  req.on('data', onData);
  req.once('end', () => reply(false));
  req.resume();
}

export async function startHttp({
  config,
  db,
  events = new BusEvents(),
  log = createBusLog(config.dataDir),
  heartbeatMs,
  maxEventStreams,
  maxStreamBufferedBytes,
}: HttpOptions): Promise<RunningHttp> {
  const { host, port } = config;
  const eventStream = createEventStream({
    db,
    events,
    log,
    heartbeatMs,
    maxStreams: maxEventStreams,
    maxBufferedBytes: maxStreamBufferedBytes,
    allowedHosts: [host],
  });
  const hostAllowed = createHostGuard([host]);
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
    const single = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

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
        // Ids never equal a role name, so a message recipient resolves unambiguously.
        if (requested !== undefined && RoleSchema.safeParse(requested).success) {
          sendJson(res, 400, { error: 'X-Agent-Id must not be a role name' });
          return;
        }
        const cliHeader = single('x-agent-cli');
        const modelHeader = single('x-agent-model');
        if (
          (cliHeader !== undefined && !CLI_VALUE.test(cliHeader)) ||
          (modelHeader !== undefined && !MODEL_VALUE.test(modelHeader))
        ) {
          sendJson(res, 400, { error: 'invalid X-Agent-Cli or X-Agent-Model' });
          return;
        }
        const agentId = requested ?? `${role}-${randomUUID().slice(0, 8)}`;
        const precheck = checkRegistration(agentId, role);
        if (precheck) {
          sendJson(res, precheck.status, { error: precheck.error });
          return;
        }
        res.setHeader('x-agent-id', agentId);
        let registered = false;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            // Register only once the session exists, so a failed connect leaves no orphan row.
            // This callback is synchronous end to end, so the re-check and the insert are atomic.
            sessions.set(id, { transport, role, agentId });
            let failure: { status: number; error: string } | undefined;
            try {
              failure = checkRegistration(agentId, role);
              if (!failure) {
                // One transaction: a failure after the insert rolls the row and its event back.
                db.transaction(() =>
                  registerOrWake(agentId, role, cliHeader ?? DEFAULT_CLI, modelHeader ?? null),
                );
                registered = true;
              }
            } catch (error) {
              failure = { status: 500, error: 'agent registration failed' };
              log.logLine('ERROR', `register ${agentId}: ${String(error)}`);
            }
            if (failure) {
              sessions.delete(id);
              // close() runs synchronously: it marks the transport closed and fires onclose,
              // which skips the exited transition because nothing was registered.
              void transport.close();
              // The SDK turns a throw here into HTTP 400 with a JSON-RPC error (code -32700)
              // whose data carries this message; it offers no hook to choose the status.
              throw new Error(failure.error);
            }
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
          if (!registered) {
            return;
          }
          const stillConnected = [...sessions.values()].some((s) => s.agentId === agentId);
          if (!stillConnected) {
            try {
              setAgentState(agentId, 'exited');
            } catch (error) {
              // the database may already be closed during shutdown; logLine never throws
              log.logLine('ERROR', `mark ${agentId} exited: ${String(error)}`);
            }
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

  /** Why an agent id cannot be registered for this role right now, or undefined when it can. */
  function checkRegistration(
    agentId: string,
    role: Role,
  ): { status: number; error: string } | undefined {
    const known = db.getAgent(agentId);
    if (known && known.role !== role) {
      return { status: 409, error: `agent ${agentId} is registered as ${known.role}` };
    }
    if (!known && db.listAgents().length >= MAX_AGENTS) {
      return { status: 503, error: 'agent limit reached' };
    }
    return undefined;
  }

  /** Inserts a new agent and emits agent.registered, or marks a returning exited agent idle. */
  function registerOrWake(agentId: string, role: Role, cli: string, model: string | null): void {
    const current = db.getAgent(agentId);
    if (!current) {
      const agent = db.insertAgent({ id: agentId, role, cli, model });
      emitAgentEvent(agent, 'agent.registered', { role, cli, model });
      log.logLine('STATE', `${agentId} registered as ${role}`);
    } else if (current.state === 'exited') {
      setAgentState(agentId, 'idle');
    }
  }

  /** Validates an agent event against the bus envelope, then stores its payload. */
  function emitAgentEvent(
    agent: { id: string; role: Role; runId: string | null },
    type: 'agent.registered' | 'agent.state',
    data: Record<string, unknown>,
  ): void {
    const envelope = {
      id: 0,
      type,
      at: new Date().toISOString(),
      source: agent.role,
      agentId: agent.id,
      issue: null,
      runId: agent.runId,
      data,
    };
    try {
      recordEvent(db, events, agent.role, envelope);
    } catch (error) {
      if (!(error instanceof EventValidationError)) {
        throw error;
      }
      log.logLine(
        'ERROR',
        `dropped invalid ${type} event for agent ${agent.id} (${agent.role}): ${error.detail}`,
      );
    }
  }

  /** Update agents.state and emit agent.state, but only when the state actually changes. */
  function setAgentState(agentId: string, state: AgentState): void {
    const agent = db.getAgent(agentId);
    if (!agent || agent.state === state) {
      return;
    }
    const updated = db.updateAgentState(agentId, state) ?? agent;
    emitAgentEvent(updated, 'agent.state', { state });
    log.logLine('STATE', `${agentId} ${state}`);
  }

  /** The agent a hook belongs to: the X-Agent-Id header, else the role's only live agent. */
  function hookAgentId(req: IncomingMessage, role: Role): string | undefined {
    const header = req.headers['x-agent-id'];
    if (typeof header === 'string' && header !== '') {
      return db.getAgent(header)?.role === role ? header : undefined;
    }
    const live = db.listAgents({ role }).filter((a) => a.state !== 'exited');
    return live.length === 1 ? live[0]?.id : undefined;
  }

  function handleEventQuery(req: IncomingMessage, res: ServerResponse): void {
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }
    const parsed = parseEventQuery(new URL(req.url ?? '/', 'http://localhost').searchParams);
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    sendJson(res, 200, db.queryEvents(parsed.query));
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
    // The instance a hook belongs to is resolved first; null when ambiguous or unknown.
    const agentId = hookAgentId(req, role) ?? null;
    const envelope = {
      id: 0,
      type: `hook:${state}`,
      at: new Date().toISOString(),
      source: `hook/${cli}`,
      agentId,
      issue: null,
      runId: null,
      data: parsed.data,
    };
    // Validate before any side effect, so a later failure never leaves a stored row to retry.
    const checked = BusEventSchema.safeParse(envelope);
    if (!checked.success) {
      const detail = briefIssue(checked.error);
      log.logLine('ERROR', `rejected hook ${role} ${state}: ${detail}`);
      sendJson(res, 400, { error: detail });
      return;
    }
    // Order is deliberate: agent.state first, hook row last. The two writes are not atomic, but a
    // failure in the state step stores no hook row, and after a failure the retry finds the state
    // already changed (setAgentState is then a no-op) so it stores the hook row exactly once.
    // Only a subscriber throwing on the hook row itself leaves it stored with a 500.
    try {
      if (agentId) {
        setAgentState(agentId, state);
      }
      recordEvent(db, events, role, envelope);
      log.logLine('HOOK', `${role} ${state} (${cli}${model ? `, ${model}` : ''})`);
    } catch (error) {
      log.logLine(
        'ERROR',
        `hook ${role} ${state}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      sendJson(res, 500, { error: 'internal error' });
      return;
    }
    res.writeHead(204).end();
  }

  /** First schema issue as a short message; never echoes the whole error or the input. */
  function briefIssue(error: z.ZodError): string {
    const issue = error.issues[0];
    const where = issue?.path.join('.') || '(root)';
    return `${where}: ${issue?.message ?? 'invalid'}`.slice(0, 200);
  }

  /**
   * `POST /ingest`: one event or a non-empty array from an external producer, all-or-nothing.
   * Rows are committed first and published synchronously right after the commit, in id order,
   * before the 202 is written; publishing only queues frames, so a slow subscriber never blocks
   * the reply. A stream deduplicates by event id, so a replay and a live publish never deliver
   * the same event twice.
   */
  async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }
    // The Host/Origin guard above is the cross-origin defence. Callers without an Origin (curl,
    // hooks, scripts) may send any or no Content-Type; the body is parsed as JSON regardless.
    // A browser request (it always sends Origin) must still be application/json, which a page
    // cannot send cross-origin without a CORS preflight.
    if (req.headers.origin !== undefined) {
      const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        sendJson(res, 415, { error: 'content-type must be application/json' });
        return;
      }
    }
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_INGEST_BODY_BYTES) {
      sendTooLarge(req, res);
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req, MAX_INGEST_BODY_BYTES);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendTooLarge(req, res);
      } else {
        sendJson(res, 400, { error: 'invalid JSON body' });
      }
      return;
    }
    const items: unknown[] = Array.isArray(body) ? body : [body];
    if (items.length === 0) {
      sendJson(res, 400, { error: 'empty batch' });
      return;
    }
    if (items.length > MAX_INGEST_BATCH) {
      sendJson(res, 413, { error: `batch over ${MAX_INGEST_BATCH} events` });
      return;
    }
    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    // Type allowlist over the whole batch first, so a well-formed but disallowed type is 403
    // rather than 400, whatever the position of the items.
    const denied = items.find(
      (item) => isObject(item) && 'type' in item && !isIngestType(item.type),
    );
    if (denied !== undefined) {
      sendJson(res, 403, {
        error: `type not allowed; allowed: ${INGEST_TYPES.join(', ')}`,
      });
      return;
    }
    // id and at are server-owned: client values are discarded and replaced before validation.
    const at = new Date().toISOString();
    const accepted: BusEvent[] = [];
    for (const [i, item] of items.entries()) {
      if (!isObject(item)) {
        sendJson(res, 400, { error: `item ${i}: expected an object` });
        return;
      }
      const checked = BusEventSchema.safeParse({ ...item, id: 0, at });
      if (!checked.success) {
        sendJson(res, 400, { error: `item ${i}: ${briefIssue(checked.error)}` });
        return;
      }
      accepted.push(checked.data);
    }
    // Persist first; subscribers are notified only after the commit.
    const rows = db.transaction(() =>
      accepted.map((e) =>
        db.insertEvent(e.source, e.type, e.data, {
          agentId: e.agentId,
          issue: e.issue,
          runId: e.runId,
        }),
      ),
    );
    // Synchronously, in id order: a deferred publish could arrive after a higher id another
    // write published meanwhile, and a stream (cursor already past it) would drop it.
    for (const row of rows) {
      try {
        events.publishEvent(row);
      } catch (error) {
        log.logLine('ERROR', `ingest broadcast of event ${row.id} failed: ${String(error)}`);
      }
    }
    const shown = accepted.slice(0, 5).map((e) => `${e.source} ${e.type}`);
    log.logLine(
      'INGEST',
      `${accepted.length} event(s): ${shown.join(', ')}${accepted.length > shown.length ? ', ...' : ''}`,
    );
    sendJson(res, 202, { ids: rows.map((r) => r.id) });
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/events/stream') {
      eventStream.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
        }
      });
      return;
    }
    if (path === '/ingest') {
      handleIngest(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
        }
      });
      return;
    }
    if (path === '/events') {
      (req.method === 'GET'
        ? Promise.resolve().then(() => handleEventQuery(req, res))
        : handleEvent(req, res)
      ).catch((error: unknown) => {
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
  const stopLeaseRenewal = await startLeaseRenewal(db, log);

  return {
    server,
    url: `http://${host}:${address.port}`,
    async close() {
      stopLeaseRenewal();
      await Promise.all([...sessions.values()].map((s) => s.transport.close()));
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
