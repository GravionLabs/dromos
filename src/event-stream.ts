import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BusEvents } from './bus-events.js';
import type { BusEvent, Db } from './db.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;
/** Rows fetched per replay query. */
const REPLAY_PAGE = 500;
const EVENT_ID = /^\d+$/;

export interface EventStreamOptions {
  db: Db;
  events: BusEvents;
  /** Interval of the `: heartbeat` comment; defaults to 15 s. */
  heartbeatMs?: number;
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

/**
 * `GET /events/stream`: replays stored events after the resume point (`Last-Event-ID` header,
 * else `?since=<id>`) in id order, then streams live events. Without a resume point only live
 * events are sent. Writes ignore backpressure; acceptable for a local bus.
 */
export function handleEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  { db, events, heartbeatMs = DEFAULT_HEARTBEAT_MS }: EventStreamOptions,
): void {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method not allowed');
    return;
  }
  const header = req.headers['last-event-id'];
  const lastEventId = Array.isArray(header) ? header[0] : header;
  const since = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since') ?? undefined;
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
  const resumeFrom = fromHeader ?? fromQuery ?? undefined;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();

  // Subscribe before replaying so nothing written in between is lost; ids at or below the
  // cursor were already sent by the replay and are skipped, so each event arrives once.
  let cursor = resumeFrom ?? Number.NEGATIVE_INFINITY;
  let buffer: BusEvent[] | undefined = [];
  const send = (event: BusEvent): void => {
    if (event.id <= cursor) {
      return;
    }
    cursor = event.id;
    res.write(frame(event));
  };
  const unsubscribe = events.onEvent((event) => {
    if (buffer) {
      buffer.push(event);
    } else {
      send(event);
    }
  });
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
  let closed = false;
  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  try {
    if (resumeFrom !== undefined) {
      for (;;) {
        const page = db.listEventsSince(cursor, REPLAY_PAGE);
        for (const event of page) {
          send(event);
        }
        if (page.length < REPLAY_PAGE) {
          break;
        }
      }
    }
    const pending = buffer;
    buffer = undefined;
    for (const event of pending) {
      send(event);
    }
  } catch (error) {
    cleanup();
    res.destroy(error instanceof Error ? error : undefined);
  }
}
