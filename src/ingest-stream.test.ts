import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusEvent } from './db.js';
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
): Promise<{ id: string; event: BusEvent } | undefined> {
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

  it('answers 202 promptly while a subscriber never reads its stream', async () => {
    await open(); // body is never read
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      const res = await ingest(bus, event);
      expect(res.status).toBe(202);
    }
    expect(performance.now() - started).toBeLessThan(2000);
    expect(bus.db.listEvents()).toHaveLength(20);
  });
});
