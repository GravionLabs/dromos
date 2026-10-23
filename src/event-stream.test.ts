import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from './db.js';
import { recordEvent } from './event-store.js';
import { startTestBus, type TestBus } from './test-helpers.js';

interface Stream {
  status: number;
  headers: Headers;
  /** Parsed `data:` payloads in arrival order. */
  events: BusEvent[];
  /** `id:` field of each event frame, in arrival order. */
  ids: string[];
  comments: string[];
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  abort(): void;
}

async function openStream(url: string, headers: Record<string, string> = {}): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const stream: Stream = {
    status: res.status,
    headers: res.headers,
    events: [],
    ids: [],
    comments: [],
    ended: Promise.resolve(),
    abort: () => controller.abort(),
  };
  const body = res.body;
  if (!body) {
    return stream;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  stream.ended = (async () => {
    let text = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        text += decoder.decode(value, { stream: true });
        let end = text.indexOf('\n\n');
        while (end !== -1) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          if (block.startsWith(':')) {
            stream.comments.push(block);
          } else {
            for (const line of block.split('\n')) {
              if (line.startsWith('id: ')) stream.ids.push(line.slice(4));
              if (line.startsWith('data: ')) {
                stream.events.push(JSON.parse(line.slice(6)) as BusEvent);
              }
            }
          }
          end = text.indexOf('\n\n');
        }
      }
    } catch {
      // aborted by the test or the server closed the socket
    }
  })();
  return stream;
}

const ids = (s: Stream) => s.events.map((e) => e.id);

describe('GET /events/stream', () => {
  let bus: TestBus;
  const streams: Stream[] = [];

  beforeEach(async () => {
    bus = await startTestBus();
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) s.abort();
    await bus.close();
  });

  const open = async (query = '', headers: Record<string, string> = {}) => {
    const s = await openStream(`${bus.http.url}/events/stream${query}`, headers);
    streams.push(s);
    return s;
  };

  /** Posts a hook event through POST /events and returns the stored row id. */
  const post = async (state: 'idle' | 'busy' = 'idle'): Promise<number> => {
    const res = await fetch(`${bus.http.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'implementer', cli: 'claude', state }),
    });
    expect(res.status).toBe(204);
    const latest = bus.db.listEvents(undefined, 1)[0];
    if (!latest) throw new Error('event not stored');
    return latest.id;
  };

  it('answers 200 with SSE headers and streams live events without replay', async () => {
    const before = await post('busy');
    const s = await open();
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toBe('text/event-stream');
    expect(s.headers.get('cache-control')).toBe('no-cache');
    const live = await post();
    await vi.waitFor(() => expect(ids(s)).toEqual([live]));
    expect(ids(s)).not.toContain(before);
    expect(s.ids).toEqual([String(live)]);
    expect(s.events[0]).toMatchObject({
      id: live,
      role: 'implementer',
      kind: 'hook:idle',
      data: { role: 'implementer', cli: 'claude', state: 'idle' },
    });
    expect(typeof s.events[0]?.createdAt).toBe('string');
  });

  it('resumes with Last-Event-ID: exactly the missed events in order, then live ones', async () => {
    const first = await open();
    const a = await post();
    const b = await post();
    await vi.waitFor(() => expect(ids(first)).toEqual([a, b]));
    first.abort();

    const c = await post();
    const d = await post();
    const resumed = await open('', { 'last-event-id': String(b) });
    await vi.waitFor(() => expect(ids(resumed)).toEqual([c, d]));
    const e = await post();
    await vi.waitFor(() => expect(ids(resumed)).toEqual([c, d, e]));
  });

  it('replays from ?since', async () => {
    const a = await post();
    const b = await post();
    const c = await post();
    const s = await open(`?since=${a}`);
    await vi.waitFor(() => expect(ids(s)).toEqual([b, c]));
  });

  it('replays every stored event from ?since=0', async () => {
    const a = await post();
    const b = await post();
    const s = await open('?since=0');
    await vi.waitFor(() => expect(ids(s)).toEqual([a, b]));
  });

  it('prefers Last-Event-ID over ?since', async () => {
    const a = await post();
    const b = await post();
    const c = await post();
    const s = await open(`?since=${a}`, { 'last-event-id': String(b) });
    await vi.waitFor(() => expect(ids(s)).toEqual([c]));
  });

  it('ignores a malformed ?since when Last-Event-ID is valid', async () => {
    const a = await post();
    const b = await post();
    const s = await open('?since=oops', { 'last-event-id': String(a) });
    expect(s.status).toBe(200);
    await vi.waitFor(() => expect(ids(s)).toEqual([b]));
  });

  it('delivers every event to each of 10 concurrent subscribers', async () => {
    const subscribers = await Promise.all(Array.from({ length: 10 }, () => open()));
    expect(bus.events.eventListenerCount()).toBe(10);
    const posted: number[] = [];
    for (let i = 0; i < 5; i++) posted.push(await post());
    await vi.waitFor(() => {
      for (const s of subscribers) expect(ids(s)).toEqual(posted);
    });
  });

  it('delivers an event written after the replay query exactly once (buffered)', async () => {
    const a = await post();
    const original = bus.db.listEventsSince.bind(bus.db);
    let late: BusEvent | undefined;
    bus.db.listEventsSince = (afterId, limit) => {
      const page = original(afterId, limit);
      late ??= recordEvent(bus.db, bus.events, 'implementer', 'hook:busy', { during: 'replay' });
      return page;
    };
    const s = await open('?since=0');
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late?.id]));
    const b = await post();
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late?.id, b]));
  });

  it('delivers an event seen by both the replay query and the live buffer exactly once', async () => {
    const a = await post();
    const original = bus.db.listEventsSince.bind(bus.db);
    let late: BusEvent | undefined;
    bus.db.listEventsSince = (afterId, limit) => {
      late ??= recordEvent(bus.db, bus.events, 'implementer', 'hook:busy', { during: 'replay' });
      return original(afterId, limit);
    };
    const s = await open('?since=0');
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late?.id]));
    const b = await post();
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late?.id, b]));
  });

  it('pages through more than one replay page in order', async () => {
    const stored: number[] = [];
    for (let i = 0; i < 1203; i++) {
      stored.push(recordEvent(bus.db, bus.events, 'implementer', 'hook:idle', { i }).id);
    }
    const s = await open('?since=0');
    await vi.waitFor(() => expect(ids(s)).toEqual(stored));
  });

  it.each([
    ['?since=abc', {}],
    ['?since=-1', {}],
    ['?since=1.5', {}],
    ['?since=', {}],
    ['', { 'last-event-id': 'abc' }],
    ['?since=1', { 'last-event-id': '-3' }],
  ])('rejects an invalid resume id (%s %j) with 400', async (query, headers) => {
    const res = await fetch(`${bus.http.url}/events/stream${query}`, { headers });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/non-negative integer/);
    expect(bus.events.eventListenerCount()).toBe(0);
  });

  it('rejects other methods with 405', async () => {
    const res = await fetch(`${bus.http.url}/events/stream`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method not allowed' });
  });

  it('keeps POST /events working next to the stream route', async () => {
    const id = await post();
    expect(bus.db.listEvents()).toMatchObject([{ id, kind: 'hook:idle' }]);
  });

  it('removes its listener when the client disconnects', async () => {
    const s = await open();
    expect(bus.events.eventListenerCount()).toBe(1);
    s.abort();
    await vi.waitFor(() => expect(bus.events.eventListenerCount()).toBe(0));
  });
});

describe('GET /events/stream heartbeat and shutdown', () => {
  it('sends a heartbeat comment at the configured interval', async () => {
    const bus = await startTestBus({}, { heartbeatMs: 20 });
    try {
      const s = await openStream(`${bus.http.url}/events/stream`);
      await vi.waitFor(() => expect(s.comments.length).toBeGreaterThanOrEqual(2));
      expect(s.comments[0]).toBe(': heartbeat');
      expect(s.events).toEqual([]);
      s.abort();
    } finally {
      await bus.close();
    }
  });

  it('sends no heartbeat before the interval elapses', async () => {
    const bus = await startTestBus({}, { heartbeatMs: 60_000 });
    try {
      const s = await openStream(`${bus.http.url}/events/stream`);
      const id = recordEvent(bus.db, bus.events, 'implementer', 'hook:idle', {}).id;
      await vi.waitFor(() => expect(ids(s)).toEqual([id]));
      expect(s.comments).toEqual([]);
      s.abort();
    } finally {
      await bus.close();
    }
  });

  it('does not hang bus close() with open streams and removes the listeners', async () => {
    const bus = await startTestBus({}, { heartbeatMs: 20 });
    const streams = await Promise.all(
      [1, 2, 3].map(() => openStream(`${bus.http.url}/events/stream`)),
    );
    expect(bus.events.eventListenerCount()).toBe(3);
    await bus.close();
    await Promise.all(streams.map((s) => s.ended));
    expect(bus.events.eventListenerCount()).toBe(0);
  });
});
