import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BusEvents } from './bus-events.js';
import type { BusLog } from './bus-log.js';
import type { BusEvent, Db } from './db.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_MAX_STREAMS = 64;
/** Unsent bytes a live client may lag behind before it is disconnected (it can resume). */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
/** Rows fetched per replay query. */
const REPLAY_PAGE = 500;
/** Live events held while replaying; on overflow they are dropped and re-read from the db. */
const MAX_LIVE_BUFFER = 1000;
const EVENT_ID = /^\d+$/;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export interface EventStreamOptions {
  db: Db;
  events: BusEvents;
  log?: BusLog;
  /** Interval of the `: heartbeat` comment; defaults to 15 s. */
  heartbeatMs?: number;
  /** Concurrent streams; further requests get 503. Defaults to 64. */
  maxStreams?: number;
  /** Live write backlog in bytes above which a slow client is disconnected. Defaults to 1 MiB. */
  maxBufferedBytes?: number;
  /** Extra accepted Host/Origin host names besides the loopback names (e.g. the bind host). */
  allowedHosts?: string[];
}

export interface EventStream {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Number of open streams. */
  size(): number;
}

/** Parses a resume id; undefined when absent, null when malformed. */
function parseEventId(value: string | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!EVENT_ID.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function sendError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

/** One SSE frame; no `event:` field, so clients read every kind via `onmessage`. */
function frame(event: BusEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Host name of a Host header value or an Origin URL; undefined when unparsable. */
function hostnameOf(value: string, isOrigin: boolean): string | undefined {
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * `GET /events/stream`: replays stored events after the resume point (`Last-Event-ID` header,
 * else `?since=<id>`) in id order, then streams live events. Without a resume point only live
 * events are sent. Host and Origin must name a loopback host (DNS-rebinding guard).
 */
export function createEventStream({
  db,
  events,
  log,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxStreams = DEFAULT_MAX_STREAMS,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  allowedHosts = [],
}: EventStreamOptions): EventStream {
  const hosts = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map((h) => hostnameOf(h, false))]);
  let open = 0;

  function allowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (host === undefined || !hosts.has(hostnameOf(host, false))) {
      return false;
    }
    const origin = req.headers.origin;
    return origin === undefined || hosts.has(hostnameOf(origin, true));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (!allowed(req)) {
      sendError(res, 403, 'forbidden host or origin');
      return;
    }
    const header = req.headers['last-event-id'];
    const lastEventId = Array.isArray(header) ? header[0] : header;
    const since =
      new URL(req.url ?? '/', 'http://localhost').searchParams.get('since') ?? undefined;
    const fromHeader = parseEventId(lastEventId);
    const fromQuery = parseEventId(since);
    if (fromHeader === null) {
      sendError(res, 400, 'Last-Event-ID must be a non-negative integer');
      return;
    }
    if (fromHeader === undefined && fromQuery === null) {
      sendError(res, 400, 'since must be a non-negative integer');
      return;
    }
    if (open >= maxStreams) {
      sendError(res, 503, 'too many event streams');
      return;
    }
    const resumeFrom = fromHeader ?? fromQuery ?? undefined;
    // An id beyond the newest row (e.g. after a database reset) is clamped, so later live
    // events are not mistaken for already-seen ones.
    const newest = db.listEvents(undefined, 1)[0]?.id ?? 0;
    let cursor = resumeFrom === undefined ? Number.NEGATIVE_INFINITY : Math.min(resumeFrom, newest);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    open++;

    let closed = false;
    let replaying = true;
    let buffer: BusEvent[] = [];
    let overflowed = false;

    /** Writes unless the client lags too far behind live events; then drops it (it resumes). */
    const write = (chunk: string): boolean => {
      const ok = res.write(chunk);
      if (!replaying && res.writableLength > maxBufferedBytes) {
        log?.logLine('ERROR', 'event stream client too slow, disconnected');
        res.destroy();
      }
      return ok;
    };
    // Ids at or below the cursor were already sent, so each event arrives exactly once.
    const send = (event: BusEvent): boolean => {
      if (event.id <= cursor) {
        return true;
      }
      cursor = event.id;
      return write(frame(event));
    };
    // Subscribe before replaying so nothing written in between is lost.
    const unsubscribe = events.onEvent((event) => {
      if (!replaying) {
        send(event);
      } else if (buffer.length < MAX_LIVE_BUFFER) {
        buffer.push(event);
      } else {
        // Every broadcast row is already stored, so the next replay page re-reads it.
        overflowed = true;
        buffer = [];
      }
    });
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      open--;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);

    try {
      if (resumeFrom !== undefined) {
        await replay();
      }
      if (closed) {
        return;
      }
      const pending = buffer;
      buffer = [];
      replaying = false;
      for (const event of pending) {
        send(event);
      }
    } catch (error) {
      log?.logLine('ERROR', `event stream replay: ${String(error)}`);
      cleanup();
      res.destroy();
    }

    async function replay(): Promise<void> {
      for (;;) {
        overflowed = false;
        const page = db.listEventsSince(cursor, REPLAY_PAGE);
        let drained = true;
        for (const event of page) {
          drained = send(event) && drained;
        }
        if (page.length < REPLAY_PAGE && !overflowed) {
          return;
        }
        // Yield between pages so other requests run, and let a slow client catch up.
        if (drained) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        } else {
          const done = new AbortController();
          await Promise.race([
            once(res, 'drain', { signal: done.signal }),
            once(res, 'close', { signal: done.signal }),
          ]).finally(() => done.abort());
        }
        if (closed) {
          return;
        }
      }
    }
  }

  return { handle, size: () => open };
}
