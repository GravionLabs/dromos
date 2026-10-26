import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionRecord, EventRecord } from './db.js';
import { BusEventSchema } from './events/schema.js';
import { MAX_INGEST_BODY_BYTES } from './http.js';
import { startTestBus, type TestBus } from './test-helpers.js';

let bus: TestBus;
const controllers: AbortController[] = [];
beforeEach(async () => {
  bus = await startTestBus();
});
afterEach(async () => {
  for (const c of controllers.splice(0)) c.abort();
  await bus.close();
});

const attention = (issue: number | null = 43, runId: string | null = 'run-43-1') => ({
  type: 'attention',
  source: 'apm-hub/queue',
  agentId: null,
  issue,
  runId,
  data: { kind: 'QUESTION', summary: 'which option?', pr: null },
});

async function ingest(body: unknown): Promise<number> {
  const res = await fetch(`${bus.http.url}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: number }).id;
}

function act(
  id: number | string,
  action: 'answer' | 'ack',
  body?: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Promise<Response> {
  return fetch(`${bus.http.url}/attention/${id}/${action}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function list(query = ''): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${bus.http.url}/attention${query}`);
  return { status: res.status, body: await res.json() };
}

async function eventsOfType(type: string): Promise<EventRecord[]> {
  const res = await fetch(`${bus.http.url}/events?type=${type}`);
  return ((await res.json()) as { events: EventRecord[] }).events;
}

/** Reads SSE frames until one of `kind` arrives or `timeoutMs` passes. */
async function frameOfKind(
  res: Response,
  kind: string,
  timeoutMs: number,
): Promise<EventRecord | undefined> {
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
    for (const m of text.matchAll(/^data: (.+)$/gm)) {
      const event = JSON.parse(m[1] as string) as EventRecord;
      if (event.kind === kind) return event;
    }
  }
  return undefined;
}

describe('attention HTTP API', () => {
  it('runs the acceptance sequence: answer once, 409 on repeat, ack', async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const stream = await fetch(`${bus.http.url}/events/stream`, { signal: controller.signal });
    expect(stream.status).toBe(200);

    const id = await ingest(attention());

    const answered = await act(id, 'answer', { text: 'option B', by: 'jerome' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      id,
      state: 'answered',
      answerText: 'option B',
      answeredBy: 'jerome',
    });

    const rows = await eventsOfType('attention.answered');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'dromos',
      issue: 43,
      runId: 'run-43-1',
      data: { id, text: 'option B', by: 'jerome' },
    });
    const live = await frameOfKind(stream, 'attention.answered', 2000);
    expect(live).toMatchObject({ id: rows[0]?.id, data: { id, text: 'option B', by: 'jerome' } });

    const again = await act(id, 'answer', { text: 'option C', by: 'jerome' });
    expect(again.status).toBe(409);
    expect(await eventsOfType('attention.answered')).toHaveLength(1);

    const open = await list('?state=open');
    expect(open.status).toBe(200);
    expect((open.body as { attention: AttentionRecord[] }).attention).toEqual([]);

    const acked = await act(id, 'ack', { by: 'jerome' });
    expect(acked.status).toBe(200);
    expect(await acked.json()).toMatchObject({ id, state: 'acked', ackedBy: 'jerome' });
    const ackRows = await eventsOfType('attention.acked');
    expect(ackRows).toHaveLength(1);
    expect(ackRows[0]).toMatchObject({ issue: 43, data: { id, by: 'jerome' } });
  });

  it('stores lifecycle events that satisfy the bus event schema', async () => {
    const id = await ingest(attention());
    await act(id, 'answer', { text: 'yes', by: 'jerome' });
    await act(id, 'ack');
    for (const type of ['attention.answered', 'attention.acked']) {
      const [row] = await eventsOfType(type);
      const parsed = BusEventSchema.safeParse({
        id: row?.id,
        at: row?.createdAt,
        source: row?.role,
        agentId: row?.agentId,
        issue: row?.issue,
        runId: row?.runId,
        type: row?.kind,
        data: row?.data,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('acks with an empty body and records by as null', async () => {
    const id = await ingest(attention());
    await act(id, 'answer', { text: 'yes', by: 'jerome' });
    const res = await act(id, 'ack', undefined, {});
    expect(res.status).toBe(200);
    const [row] = await eventsOfType('attention.acked');
    expect(row?.data).toEqual({ id, by: null });
  });

  it('returns 409 for an ack on an open attention and emits nothing', async () => {
    const id = await ingest(attention());
    const res = await act(id, 'ack', { by: 'jerome' });
    expect(res.status).toBe(409);
    expect(bus.db.getAttention(id)?.state).toBe('open');
    expect(await eventsOfType('attention.acked')).toEqual([]);
  });

  it('returns 404 for an unknown or malformed id', async () => {
    expect((await act(9999, 'answer', { text: 'x', by: 'y' })).status).toBe(404);
    expect((await act(9999, 'ack', {})).status).toBe(404);
    expect((await act('abc', 'answer', { text: 'x', by: 'y' })).status).toBe(404);
    expect((await act(0, 'answer', { text: 'x', by: 'y' })).status).toBe(404);
  });

  it('returns 405 for a wrong method', async () => {
    const id = await ingest(attention());
    const get = await fetch(`${bus.http.url}/attention/${id}/answer`);
    expect(get.status).toBe(405);
    const post = await fetch(`${bus.http.url}/attention`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it.each([
    ['missing text', { by: 'jerome' }],
    ['empty text', { text: '', by: 'jerome' }],
    ['text over 4000 chars', { text: 'x'.repeat(4001), by: 'jerome' }],
    ['by over 128 chars', { text: 'ok', by: 'x'.repeat(129) }],
    ['unknown key', { text: 'ok', by: 'jerome', extra: 1 }],
  ])('rejects an answer with %s as 400 and leaves it open', async (_name, body) => {
    const id = await ingest(attention());
    const res = await act(id, 'answer', body);
    expect(res.status).toBe(400);
    expect(bus.db.getAttention(id)?.state).toBe('open');
  });

  it('returns 409 for a second ack and emits one attention.acked', async () => {
    const id = await ingest(attention());
    await act(id, 'answer', { text: 'yes', by: 'jerome' });
    expect((await act(id, 'ack', { by: 'jerome' })).status).toBe(200);
    const again = await act(id, 'ack', { by: 'other' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('acked');
    expect(bus.db.getAttention(id)?.ackedBy).toBe('jerome');
    expect(await eventsOfType('attention.acked')).toHaveLength(1);
  });

  it('returns 404 for an ack on a malformed id', async () => {
    expect((await act('abc', 'ack', {})).status).toBe(404);
    expect((await act(0, 'ack', {})).status).toBe(404);
  });

  it.each([
    ['empty by', { by: '' }],
    ['by over 128 chars', { by: 'x'.repeat(129) }],
    ['non-string by', { by: 42 }],
    ['unknown key', { by: 'jerome', extra: 1 }],
    ['an array body', []],
  ])('rejects an ack with %s as 400 and leaves it answered', async (_name, body) => {
    const id = await ingest(attention());
    await act(id, 'answer', { text: 'yes', by: 'jerome' });
    const res = await act(id, 'ack', body);
    expect(res.status).toBe(400);
    expect(bus.db.getAttention(id)?.state).toBe('answered');
    expect(await eventsOfType('attention.acked')).toEqual([]);
  });

  it.each(['answer', 'ack'] as const)(
    'rejects a %s body over the size cap with 413',
    async (action) => {
      const id = await ingest(attention());
      if (action === 'ack') await act(id, 'answer', { text: 'yes', by: 'jerome' });
      const before = bus.db.getAttention(id)?.state;
      const res = await act(id, action, { text: 'x'.repeat(MAX_INGEST_BODY_BYTES), by: 'y' });
      expect(res.status).toBe(413);
      expect(bus.db.getAttention(id)?.state).toBe(before);
    },
  );

  it('accepts text of exactly 4000 chars', async () => {
    const id = await ingest(attention());
    const res = await act(id, 'answer', { text: 'x'.repeat(4000), by: 'x'.repeat(128) });
    expect(res.status).toBe(200);
  });

  it('rejects invalid JSON with 400', async () => {
    const id = await ingest(attention());
    const res = await fetch(`${bus.http.url}/attention/${id}/answer`, {
      method: 'POST',
      body: '{nope',
    });
    expect(res.status).toBe(400);
  });

  it('applies the ingest host and content-type rules', async () => {
    const id = await ingest(attention());
    const foreign = await act(
      id,
      'answer',
      { text: 'x', by: 'y' },
      {
        'content-type': 'application/json',
        origin: 'http://evil.example',
      },
    );
    expect(foreign.status).toBe(403);
    const browserText = await act(
      id,
      'answer',
      { text: 'x', by: 'y' },
      {
        'content-type': 'text/plain',
        origin: bus.http.url,
      },
    );
    expect(browserText.status).toBe(415);
    expect(bus.db.getAttention(id)?.state).toBe('open');
  });

  it('yields one 200, one 409 and one event for parallel answers', async () => {
    const id = await ingest(attention());
    const results = await Promise.all([
      act(id, 'answer', { text: 'first', by: 'a' }),
      act(id, 'answer', { text: 'second', by: 'b' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await eventsOfType('attention.answered')).toHaveLength(1);
  });

  it('leaves the attention open when the event insert fails', async () => {
    const id = await ingest(attention());
    const spy = vi.spyOn(bus.db, 'insertEvent').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await act(id, 'answer', { text: 'x', by: 'y' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(bus.db.getAttention(id)).toMatchObject({ state: 'open', answerText: null });
    expect(await eventsOfType('attention.answered')).toEqual([]);
  });

  it('leaves the attention answered when the ack event insert fails', async () => {
    const id = await ingest(attention());
    await act(id, 'answer', { text: 'x', by: 'y' });
    const spy = vi.spyOn(bus.db, 'insertEvent').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await act(id, 'ack', {});
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(bus.db.getAttention(id)?.state).toBe('answered');
  });

  it('logs a publish failure and still replies 200 with the persisted state', async () => {
    const id = await ingest(attention());
    const spy = vi.spyOn(bus.events, 'publishEvent').mockImplementation(() => {
      throw new Error('subscriber broke');
    });
    const res = await act(id, 'answer', { text: 'x', by: 'y' });
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(bus.db.getAttention(id)?.state).toBe('answered');
    expect(await eventsOfType('attention.answered')).toHaveLength(1);
    expect(bus.readLog()).toMatch(/ERROR.*attention answer broadcast .*subscriber broke/);
  });

  describe('GET /attention', () => {
    it('filters by state, issue and since', async () => {
      const a = await ingest(attention(1));
      const b = await ingest(attention(2));
      const c = await ingest(attention(1));
      await act(b, 'answer', { text: 'x', by: 'y' });
      const ids = async (q: string) =>
        ((await list(q)).body as { attention: AttentionRecord[] }).attention.map((r) => r.id);

      expect(await ids('')).toEqual([a, b, c]);
      expect(await ids('?state=open')).toEqual([a, c]);
      expect(await ids('?state=answered')).toEqual([b]);
      expect(await ids('?state=acked')).toEqual([]);
      expect(await ids('?issue=1')).toEqual([a, c]);
      expect(await ids('?issue=2&state=open')).toEqual([]);
      expect(await ids('?since=2999-01-01T00:00:00Z')).toEqual([]);
      expect(await ids('?since=2000-01-01T00:00:00Z&limit=2')).toEqual([a, b]);
    });

    it.each([
      ['?state=closed', 'state'],
      ['?issue=-1', 'issue'],
      ['?issue=abc', 'issue'],
      ['?since=yesterday', 'since'],
      ['?limit=0', 'limit'],
      ['?limit=1001', 'limit'],
      ['?foo=1', 'foo'],
      ['?state=open&state=acked', 'state'],
    ])('rejects %s with 400 naming %s', async (query, name) => {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain(name);
    });

    it('rejects a foreign origin with 403', async () => {
      const res = await fetch(`${bus.http.url}/attention`, {
        headers: { origin: 'http://evil.example' },
      });
      expect(res.status).toBe(403);
    });
  });
});
