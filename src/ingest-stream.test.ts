import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRecord } from './db.js';
import { recordEvent } from './event-store.js';
import { startTestBus, type TestBus } from './test-helpers.js';

const event = {
  type: 'progress',
  source: 'apm-hub/hook',
  agentId: null,
  issue: 43,
  runId: null,
  data: { line: 'built', agent: 'orchestrator' },
};

function ingest(bus: TestBus, body: unknown): Promise<Response> {
  return fetch(`${bus.http.url}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Reads SSE frames from `res` until one with an `id:` line arrives or `timeoutMs` passes. */
async function firstFrame(
  res: Response,
  timeoutMs: number,
): Promise<{ id: string; event: EventRecord } | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    const timeout = new Promise<{ done: true; value?: undefined }>((r) =>
      setTimeout(() => r({ done: true }), Math.max(1, deadline - Date.now())),
    );
    const { value, done } = await Promise.race([reader.read(), timeout]);
    if (done) return undefined;
    text += decoder.decode(value, { stream: true });
    const id = /^id: (.+)$/m.exec(text);
    const data = /^data: (.+)$/m.exec(text);
    if (id?.[1] && data?.[1]) {
      return { id: id[1], event: JSON.parse(data[1]) as BusEvent };
    }
  }
  return undefined;
}

describe('POST /ingest reaches GET /events/stream', () => {
  let bus: TestBus;
  const controllers: AbortController[] = [];
  beforeEach(async () => {
    bus = await startTestBus();
  });
  afterEach(async () => {
    for (const c of controllers.splice(0)) c.abort();
    await bus.close();
  });

  async function open(): Promise<Response> {
    const controller = new AbortController();
    controllers.push(controller);
    const res = await fetch(`${bus.http.url}/events/stream`, { signal: controller.signal });
    expect(res.status).toBe(200);
    return res;
  }

  it('delivers a posted progress event as a frame with the returned id', async () => {
    const stream = await open();
    const res = await ingest(bus, event);
    expect(res.status).toBe(202);
    const { ids } = (await res.json()) as { ids: number[] };

    const frame = await firstFrame(stream, 2000);

    expect(frame?.id).toBe(String(ids[0]));
    expect(frame?.event.id).toBe(ids[0]);
    expect(frame?.event.kind).toBe('progress');
    expect(frame?.event.role).toBe('apm-hub/hook');
  });

  it('carries agentId, issue and runId through the live frame and the replay', async () => {
    const stream = await open();
    const withCtx = { ...event, agentId: 'a1b2', issue: 43, runId: 'run-43-1' };
    const bare = { ...event, agentId: null, issue: null, runId: null };
    const res1 = await ingest(bus, withCtx);
    const res2 = await ingest(bus, bare);
    const [first] = ((await res1.json()) as { ids: number[] }).ids;
    expect(res2.status).toBe(202);

    const live = await firstFrame(stream, 2000);
    expect(live?.event).toMatchObject({ id: first, agentId: 'a1b2', issue: 43, runId: 'run-43-1' });
    expect(live?.event.role).toBe('apm-hub/hook');

    const replay = await fetch(`${bus.http.url}/events/stream`, {
      headers: { 'last-event-id': String((first as number) - 1) },
      signal: (() => {
        const c = new AbortController();
        controllers.push(c);
        return c.signal;
      })(),
    });
    const frames: EventRecord[] = [];
    const reader = replay.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (frames.length < 2 && reader) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      frames.length = 0;
      for (const m of text.matchAll(/^data: (.+)$/gm)) {
        frames.push(JSON.parse(m[1] as string) as BusEvent);
      }
    }
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ agentId: 'a1b2', issue: 43, runId: 'run-43-1' });
    expect(frames[1]).toMatchObject({ agentId: null, issue: null, runId: null });
  });

  it('delivers a posted agent.run event with its data', async () => {
    const stream = await open();
    const agentRun = {
      type: 'agent.run',
      source: 'apm-hub/subagent-stop',
      agentId: null,
      issue: 43,
      runId: null,
      data: {
        state: 'stopped',
        runAgentId: 'a1',
        parentAgentId: 'p1',
        toolUseId: 'toolu_1',
        agentType: 'implementer',
        description: null,
        depth: 2,
        model: null,
        durationMs: 10,
        summary: null,
      },
    };
    const res = await ingest(bus, agentRun);
    expect(res.status).toBe(202);

    const frame = await firstFrame(stream, 2000);

    expect(frame?.event.kind).toBe('agent.run');
    expect(frame?.event.data).toEqual(agentRun.data);
  });

  it('answers 202 while a stalled subscriber is attached, then cuts that subscriber off', async () => {
    await bus.close();
    // One post queues ~120 KiB of frames, under the limit, so the first 202 always arrives while
    // the stalled subscriber is still attached; the following posts push it over.
    bus = await startTestBus({}, { maxStreamBufferedBytes: 256 * 1024 });
    // A raw socket that requests the stream and then never reads, so the server-side buffer fills.
    const socket = connect(Number(new URL(bus.http.url).port), '127.0.0.1');
    await once(socket, 'connect');
    socket.pause();
    const subscribed = new Promise<void>((resolve) => {
      const check = (): void => {
        if (bus.events.eventListenerCount() === 1) resolve();
        else setImmediate(check);
      };
      check();
    });
    socket.write('GET /events/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await subscribed;

    // Each post is a full batch of max-length lines (~100 KiB of frames). Posting stops as soon as
    // the server drops the subscriber, so the run ends on that event, not on a clock; the bound
    // (~50 MiB of frames) is far beyond any socket buffer.
    const line = 'x'.repeat(1000);
    const batch = Array.from({ length: 100 }, () => ({ ...event, data: { line, agent: 'o' } }));
    let attachedReplies = 0;
    let posts = 0;
    while (bus.events.eventListenerCount() === 1 && posts < 500) {
      const res = await ingest(bus, batch);
      posts++;
      expect(res.status).toBe(202);
      await res.arrayBuffer();
      if (bus.events.eventListenerCount() === 1) attachedReplies++;
    }
    socket.destroy();

    expect(attachedReplies).toBeGreaterThan(0);
    expect(bus.events.eventListenerCount()).toBe(0);
    expect(bus.db.listEvents(undefined, 100_000)).toHaveLength(posts * 100);
  });
});

/** Collects the ids of every SSE frame of a stream opened with `Last-Event-ID`. */
async function collectIds(
  bus: TestBus,
  lastEventId: number,
  signal: AbortSignal,
): Promise<{ ids: number[]; done: Promise<void> }> {
  const res = await fetch(`${bus.http.url}/events/stream`, {
    headers: { 'last-event-id': String(lastEventId) },
    signal,
  });
  expect(res.status).toBe(200);
  const ids: number[] = [];
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let text = '';
    try {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) return;
        text += decoder.decode(chunk.value, { stream: true });
        let end = text.indexOf('\n\n');
        while (end !== -1) {
          const id = /^id: (\d+)$/m.exec(text.slice(0, end))?.[1];
          if (id) ids.push(Number(id));
          text = text.slice(end + 2);
          end = text.indexOf('\n\n');
        }
      }
    } catch {
      // aborted by the test
    }
  })();
  return { ids, done };
}

describe('replay and live publish deliver each ingested id once, in order', () => {
  let bus: TestBus;
  let controller: AbortController;
  beforeEach(async () => {
    bus = await startTestBus();
    controller = new AbortController();
  });
  afterEach(async () => {
    controller.abort();
    await bus.close();
  });

  const hook = (): Promise<Response> =>
    fetch(`${bus.http.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'implementer', cli: 'claude', state: 'busy' }),
    });

  const allIds = (): number[] =>
    bus.db
      .listEvents(undefined, 100_000)
      .map((e) => e.id)
      .sort((a, b) => a - b);

  it('resuming after an ingest replays the rest of the batch, then live ids', async () => {
    const res = await ingest(bus, [event, event, event]);
    const [first, second, third] = ((await res.json()) as { ids: number[] }).ids;
    const stream = await collectIds(bus, first as number, controller.signal);
    const later = ((await (await ingest(bus, event)).json()) as { ids: number[] }).ids[0];

    await vi.waitFor(() => expect(stream.ids).toEqual([second, third, later]));
  });

  it('a subscriber connecting during concurrent ingests sees every id once, ascending', async () => {
    // More rows than one replay page, so the replay yields while new ingests commit.
    for (let i = 0; i < 1200; i++) {
      bus.db.insertEvent('seed', 'progress', { line: `seed ${i}`, agent: 'o' });
    }
    const writes: Promise<Response>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(ingest(bus, [event, event]), hook());
    }
    const stream = await collectIds(bus, 0, controller.signal);
    for (let i = 0; i < 20; i++) {
      writes.push(ingest(bus, event), hook());
    }
    for (const res of await Promise.all(writes)) {
      expect([202, 204]).toContain(res.status);
      await res.arrayBuffer();
    }
    const expected = allIds();
    expect(expected).toHaveLength(1200 + 20 * 2 + 20 + 40);

    await vi.waitFor(() => expect(stream.ids).toHaveLength(expected.length));
    expect(stream.ids).toEqual(expected);
  });

  it('a live subscriber never loses an ingested id to a higher id published meanwhile', async () => {
    const stream = await collectIds(bus, 0, controller.signal);
    // Another write lands right when the ingest reply is written: after the commit, before any
    // later tick. A publish deferred past that point would arrive below the stream's cursor.
    let raced: number | undefined;
    bus.http.server.prependListener('request', (req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== '/ingest') return;
      const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
      res.writeHead = ((...args: unknown[]) => {
        raced = recordEvent(bus.db, bus.events, 'implementer', {
          id: 0,
          type: 'hook:busy',
          at: new Date().toISOString(),
          source: 'hook/claude',
          agentId: 'implementer',
          issue: null,
          runId: null,
          data: { role: 'implementer', cli: 'claude', state: 'busy' },
        }).id;
        return writeHead(...args);
      }) as ServerResponse['writeHead'];
    });
    const res = await ingest(bus, [event, event]);
    const ids = ((await res.json()) as { ids: number[] }).ids;

    await vi.waitFor(() => expect(stream.ids).toHaveLength(3));
    expect(stream.ids).toEqual([...ids, raced]);
  });
});
