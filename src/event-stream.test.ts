import { type IncomingMessage, request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRecord } from './db.js';
import { recordEvent } from './event-store.js';
import { startTestBus, type TestBus } from './test-helpers.js';

/** A valid hook BusEvent; `id` is ignored by recordEvent. */
const hookEvent = (state: 'idle' | 'busy', extra: Record<string, unknown> = {}) => ({
  id: 0,
  type: `hook:${state}`,
  at: '2026-01-01T00:00:00.000Z',
  source: 'hook/claude',
  agentId: 'implementer',
  issue: null,
  runId: null,
  data: { role: 'implementer', cli: 'claude', state, ...extra },
});

interface Stream {
  status: number;
  headers: Headers;
  /** Parsed `data:` payloads in arrival order. */
  events: EventRecord[];
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
                stream.events.push(JSON.parse(line.slice(6)) as EventRecord);
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
    vi.restoreAllMocks();
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
    expect(s.events[0]).toEqual(bus.db.listEventsSince(live - 1)[0]);
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

  /** Writes one event from inside the first replay query, before or after it reads. */
  const writeDuringReplay = (when: 'before' | 'after') => {
    const original = bus.db.listEventsSince.bind(bus.db);
    const late: EventRecord[] = [];
    const write = () => {
      if (late.length === 0) {
        late.push(recordEvent(bus.db, bus.events, 'implementer', hookEvent('busy')));
      }
    };
    vi.spyOn(bus.db, 'listEventsSince').mockImplementation((afterId, limit) => {
      if (when === 'before') write();
      const page = original(afterId, limit);
      if (when === 'after') write();
      return page;
    });
    return late;
  };

  it('delivers an event written after the replay query exactly once (buffered)', async () => {
    const a = await post();
    const late = writeDuringReplay('after');
    const s = await open('?since=0');
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late[0]?.id]));
    const b = await post();
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late[0]?.id, b]));
  });

  it('delivers an event seen by both the replay query and the live buffer exactly once', async () => {
    const a = await post();
    const late = writeDuringReplay('before');
    const s = await open('?since=0');
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late[0]?.id]));
    const b = await post();
    await vi.waitFor(() => expect(ids(s)).toEqual([a, late[0]?.id, b]));
  });

  it.each([1203, 500, 1000])('replays %i stored events in order across pages', async (count) => {
    const stored: number[] = [];
    for (let i = 0; i < count; i++) {
      stored.push(recordEvent(bus.db, bus.events, 'implementer', hookEvent('idle')).id);
    }
    const s = await open('?since=0');
    await vi.waitFor(() => expect(ids(s)).toEqual(stored));
  });

  it('delivers events written while a multi-page replay yields exactly once, in order', async () => {
    const stored: number[] = [];
    for (let i = 0; i < 1500; i++) {
      stored.push(recordEvent(bus.db, bus.events, 'implementer', hookEvent('idle')).id);
    }
    const s = await open('?since=0');
    for (let i = 0; i < 20; i++) {
      stored.push(recordEvent(bus.db, bus.events, 'implementer', hookEvent('busy')).id);
    }
    await vi.waitFor(() => expect(ids(s)).toEqual(stored));
  });

  it('clamps a resume id beyond the newest event so later live events arrive', async () => {
    const a = await post();
    const s = await open('', { 'last-event-id': String(a + 1000) });
    expect(s.status).toBe(200);
    const b = await post();
    const c = await post();
    await vi.waitFor(() => expect(ids(s)).toEqual([b, c]));
  });

  it('clamps a resume id on an empty database to zero', async () => {
    const s = await open('?since=99');
    const a = await post();
    await vi.waitFor(() => expect(ids(s)).toEqual([a]));
  });

  it('ends the stream, logs and removes the listener when replay fails', async () => {
    await post();
    vi.spyOn(bus.db, 'listEventsSince').mockImplementation(() => {
      throw new Error('disk gone');
    });
    const s = await open('?since=0');
    expect(s.status).toBe(200);
    await s.ended;
    expect(s.events).toEqual([]);
    expect(bus.events.eventListenerCount()).toBe(0);
    expect(bus.readLog()).toContain('event stream replay: Error: disk gone');
  });

  it('answers 500 when the stream fails before the headers are sent', async () => {
    vi.spyOn(bus.db, 'listEvents').mockImplementation(() => {
      throw new Error('db closed');
    });
    const res = await fetch(`${bus.http.url}/events/stream?since=0`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'db closed' });
    expect(bus.events.eventListenerCount()).toBe(0);
  });

  it('streams agent.registered and agent.state events', async () => {
    const s = await open();
    await bus.connect('implementer', 'impl-1');
    await vi.waitFor(() => expect(s.events.map((e) => e.kind)).toContain('agent.registered'));
    await post('busy');
    await vi.waitFor(() =>
      expect(s.events.map((e) => [e.kind, e.data])).toEqual(
        expect.arrayContaining([
          ['agent.registered', expect.objectContaining({ role: 'implementer' })],
          ['agent.state', { state: 'busy' }],
        ]),
      ),
    );
    expect(ids(s)).toEqual(bus.db.listEventsSince(0).map((e) => e.id));
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

  it('removes its listener when the client disconnects', async () => {
    const s = await open();
    expect(bus.events.eventListenerCount()).toBe(1);
    s.abort();
    await vi.waitFor(() => expect(bus.events.eventListenerCount()).toBe(0));
  });
});

/** Raw request so Host and Origin can be set (fetch forbids both). */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      if (res.statusCode === 200) {
        resolve({ status: 200, body: '', res });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, res }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /events/stream host, limits and backpressure', () => {
  let bus: TestBus | undefined;

  afterEach(async () => {
    await bus?.close();
    bus = undefined;
  });

  it.each([
    [{ host: 'evil.example' }, 403],
    [{ host: 'evil.example:8080' }, 403],
    [{ host: 'localhost', origin: 'http://evil.example' }, 403],
    [{ host: 'localhost', origin: 'null' }, 403],
    [{ host: 'localhost' }, 200],
    [{ host: '[::1]:1234' }, 200],
    [{ host: '127.0.0.1', origin: 'http://localhost:3000' }, 200],
  ])('Host/Origin %j answers %i', async (headers, status) => {
    bus = await startTestBus();
    const r = await rawGet(`${bus.http.url}/events/stream`, headers);
    expect(r.status).toBe(status);
    if (status === 403) {
      expect(JSON.parse(r.body)).toEqual({ error: 'forbidden host or origin' });
      expect(bus.events.eventListenerCount()).toBe(0);
    } else {
      r.res.destroy();
    }
  });

  it('answers 503 beyond the stream cap and accepts again after a disconnect', async () => {
    bus = await startTestBus({}, { maxEventStreams: 2 });
    const url = `${bus.http.url}/events/stream`;
    const first = await openStream(url);
    const second = await openStream(url);
    const third = await fetch(url);
    expect(third.status).toBe(503);
    expect(await third.json()).toEqual({ error: 'too many event streams' });
    first.abort();
    const local = bus;
    await vi.waitFor(() => expect(local.events.eventListenerCount()).toBe(1));
    const again = await openStream(url);
    expect(again.status).toBe(200);
    second.abort();
    again.abort();
  });

  it('disconnects a live client that stops reading once its backlog exceeds the limit', async () => {
    bus = await startTestBus({}, { maxStreamBufferedBytes: 64 * 1024 });
    const r = await rawGet(`${bus.http.url}/events/stream`, { host: '127.0.0.1' });
    r.res.pause();
    expect(bus.events.eventListenerCount()).toBe(1);
    const big = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 200 && bus.events.eventListenerCount() > 0; i++) {
      recordEvent(bus.db, bus.events, 'implementer', hookEvent('idle', { sessionId: big }));
    }
    const local = bus;
    await vi.waitFor(() => expect(local.events.eventListenerCount()).toBe(0));
    expect(bus.readLog()).toContain('event stream client too slow');
    r.res.destroy();
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
      const id = recordEvent(bus.db, bus.events, 'implementer', hookEvent('idle')).id;
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
