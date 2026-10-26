import { once } from 'node:events';
import { Agent, type IncomingMessage, request, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INGEST_TYPES } from './events/schema.js';
import { MAX_INGEST_BATCH, MAX_INGEST_BODY_BYTES } from './http.js';
import { startTestBus, type TestBus } from './test-helpers.js';

let bus: TestBus;
beforeEach(async () => {
  bus = await startTestBus();
});
afterEach(async () => {
  await bus.close();
});

const progress = (extra: Record<string, unknown> = {}) => ({
  type: 'progress',
  source: 'apm-hub/hook',
  agentId: null,
  issue: 43,
  runId: null,
  data: { line: 'built', agent: 'orchestrator' },
  ...extra,
});

function post(body: unknown, raw = false): Promise<Response> {
  return fetch(`${bus.http.url}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe('POST /ingest', () => {
  it('broadcasts nothing when a batch fails mid-transaction', async () => {
    const seen: string[] = [];
    bus.events.onEvent((e) => seen.push(e.kind));
    const real = bus.db.insertEvent.bind(bus.db);
    let calls = 0;
    const spy = vi.spyOn(bus.db, 'insertEvent').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('disk full');
      }
      return real(...args);
    });
    const res = await post([progress(), progress()]);
    spy.mockRestore();
    await new Promise((r) => setImmediate(r));
    expect(res.status).toBe(500);
    expect(bus.db.listEvents()).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it('accepts one event with 202 and stores it', async () => {
    const res = await post(progress());
    expect(res.status).toBe(202);
    const { ids } = (await res.json()) as { ids: number[] };
    const rows = bus.db.listEvents();
    expect(rows).toHaveLength(1);
    expect(ids).toEqual([rows[0]?.id]);
    expect(rows[0]?.kind).toBe('progress');
    expect(rows[0]?.role).toBe('apm-hub/hook');
  });

  it('accepts an array in order', async () => {
    const res = await post([
      progress(),
      { ...progress(), type: 'agent.state', data: { state: 'busy' } },
      { ...progress(), type: 'progress', data: { line: 'last', agent: 'orchestrator' } },
    ]);
    expect(res.status).toBe(202);
    const { ids } = (await res.json()) as { ids: number[] };
    const rows = bus.db.listEvents().reverse();
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.map((r) => r.kind)).toEqual(['progress', 'agent.state', 'progress']);
    expect(rows[2]?.data).toEqual({ line: 'last', agent: 'orchestrator' });
  });

  it('accepts agent.run and rejects depth 0 with 400', async () => {
    const data = {
      state: 'started',
      runAgentId: 'a1',
      parentAgentId: null,
      toolUseId: null,
      agentType: 'implementer',
      description: null,
      depth: 1,
      model: null,
      durationMs: null,
      summary: null,
    };
    const run = { ...progress(), type: 'agent.run', data };
    expect((await post(run)).status).toBe(202);
    expect(bus.db.listEvents().map((r) => r.kind)).toEqual(['agent.run']);
    const bad = await post({ ...run, data: { ...data, depth: 0 } });
    expect(bad.status).toBe(400);
    expect(bus.db.listEvents()).toHaveLength(1);
  });

  it('broadcasts to subscribers before the 202 reaches the client', async () => {
    const seen: string[] = [];
    bus.events.onEvent((e) => seen.push(e.kind));
    await post(progress());
    expect(seen).toEqual(['progress']);
  });

  it('stores a progress event with kind and fields', async () => {
    const data = { line: 'wave 2', agent: 'orchestrator', kind: 'wave', fields: { n: 2, x: null } };
    const res = await post(progress({ data }));
    expect(res.status).toBeLessThan(300);
    expect(bus.db.listEvents()).toHaveLength(1);
  });

  it('rejects a progress event with an unknown kind with 400 and stores nothing', async () => {
    const data = { line: 'x', agent: 'orchestrator', kind: 'bogus' };
    const res = await post(progress({ data }));
    expect(res.status).toBe(400);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('rejects a disallowed type with 403 and stores nothing', async () => {
    const res = await post({ ...progress(), type: 'run.state' });
    expect(res.status).toBe(403);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('rejects a mixed batch as a whole with 403', async () => {
    const res = await post([progress(), { ...progress(), type: 'hook:idle' }]);
    expect(res.status).toBe(403);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('rejects a batch with one invalid item with 400 and stores nothing', async () => {
    const { source: _s, ...noSource } = progress();
    const res = await post([progress(), noSource]);
    expect(res.status).toBe(400);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('requires source', async () => {
    const { source: _s, ...noSource } = progress();
    expect((await post(noSource)).status).toBe(400);
  });

  it('rejects invalid JSON, empty batch and non-objects with 400', async () => {
    expect((await post('{nope', true)).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post(['x'])).status).toBe(400);
  });

  it('answers non-POST with 405', async () => {
    const res = await fetch(`${bus.http.url}/ingest`);
    expect(res.status).toBe(405);
  });

  it('overrides client-supplied id and at', async () => {
    const published: unknown[] = [];
    bus.events.onEvent((e) => published.push(e));
    const before = Date.now();
    const res = await post(progress({ id: 999999, at: '2999-12-31T23:59:59.000Z' }));
    const after = Date.now();
    expect(res.status).toBe(202);
    const { ids } = (await res.json()) as { ids: number[] };
    const row = bus.db.listEvents()[0];
    expect(row?.id).toBe(ids[0]);
    expect(ids[0]).not.toBe(999999);
    // A future `at` would win any "latest" comparison; the server clock must be used instead.
    const stored = new Date(row?.createdAt ?? '').getTime();
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(after);
    expect(published).toEqual([row]);
    expect(JSON.stringify(published)).not.toContain('2999');
    expect(JSON.stringify(published)).not.toContain('999999');
  });

  it('exposes the allowlist', () => {
    expect([...INGEST_TYPES]).toEqual([
      'progress',
      'attention',
      'usage',
      'queue.item',
      'agent.state',
      'agent.run',
    ]);
  });
});

/** Raw request, so tests can set Host, Origin and Content-Type freely. */
function raw(
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${bus.http.url}/ingest`,
      {
        method: 'POST',
        headers: { 'content-length': String(Buffer.byteLength(body)), ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => {
          text += c.toString('utf8');
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const tick = () => new Promise((r) => setImmediate(r));

describe('POST /ingest guards', () => {
  const json = { 'content-type': 'application/json' };

  it('rejects a foreign Origin with 403 and stores nothing', async () => {
    const res = await raw({ ...json, origin: 'http://evil.example' }, JSON.stringify(progress()));
    expect(res.status).toBe(403);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('rejects a foreign Host with 403', async () => {
    const res = await raw({ ...json, host: 'evil.example' }, JSON.stringify(progress()));
    expect(res.status).toBe(403);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('accepts a loopback Origin', async () => {
    const res = await raw({ ...json, origin: 'http://localhost:3000' }, JSON.stringify(progress()));
    expect(res.status).toBe(202);
  });

  it('parses the body as JSON without an Origin, whatever the content type (curl -d)', async () => {
    const body = JSON.stringify(progress());
    expect((await raw({}, body)).status).toBe(202);
    expect((await raw({ 'content-type': 'application/x-www-form-urlencoded' }, body)).status).toBe(
      202,
    );
    expect((await raw({ 'content-type': 'text/plain' }, body)).status).toBe(202);
    expect(bus.db.listEvents()).toHaveLength(3);
  });

  it('still answers 400 for a non-JSON body without a content type', async () => {
    const res = await raw({}, 'line=built');
    expect(res.status).toBe(400);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('answers 415 for a loopback Origin without application/json', async () => {
    const body = JSON.stringify(progress());
    const origin = 'http://localhost:3000';
    expect((await raw({ origin, 'content-type': 'text/plain' }, body)).status).toBe(415);
    expect((await raw({ origin }, body)).status).toBe(415);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('rejects a foreign Origin with 403 before looking at the body', async () => {
    const origin = 'http://evil.example';
    expect((await raw({ origin, 'content-type': 'text/plain' }, '{nope')).status).toBe(403);
    expect((await raw({ origin }, JSON.stringify(progress()))).status).toBe(403);
    const huge = await raw({ origin, ...json }, ' '.repeat(MAX_INGEST_BODY_BYTES + 1));
    expect(huge.status).toBe(403);
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('accepts application/json with a charset parameter', async () => {
    const res = await raw(
      { 'content-type': 'application/json; charset=utf-8' },
      JSON.stringify(progress()),
    );
    expect(res.status).toBe(202);
  });

  it('answers 413 for a body over the cap', async () => {
    const res = await raw(json, ' '.repeat(MAX_INGEST_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual({ error: `body over ${MAX_INGEST_BODY_BYTES} bytes` });
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('drains an over-cap body, answers 413 and reuses the keep-alive connection', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const send = (body: string) =>
        new Promise<{ status: number; connection: string | undefined; reused: boolean }>(
          (resolve, reject) => {
            const req = request(
              `${bus.http.url}/ingest`,
              {
                agent,
                method: 'POST',
                headers: { ...json, 'content-length': String(Buffer.byteLength(body)) },
              },
              (res) => {
                res.resume();
                res.on('end', () =>
                  resolve({
                    status: res.statusCode ?? 0,
                    connection: res.headers.connection,
                    reused: req.reusedSocket,
                  }),
                );
              },
            );
            req.on('error', reject);
            req.end(body);
          },
        );
      const tooLarge = await send(' '.repeat(MAX_INGEST_BODY_BYTES + 1));
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.connection).toBe('keep-alive');
      const next = await send(JSON.stringify(progress()));
      expect(next.status).toBe(202);
      expect(next.reused).toBe(true);
      expect(bus.db.listEvents()).toHaveLength(1);
    } finally {
      agent.destroy();
    }
  });

  it('closes the connection when an over-cap body keeps going past the drain limit', async () => {
    const socket = connect(Number(new URL(bus.http.url).port), '127.0.0.1');
    await once(socket, 'connect');
    let received = '';
    socket.on('data', (c: Buffer) => {
      received += c.toString('latin1');
    });
    socket.on('error', () => {
      // The server stops reading; the client's pending writes may fail with EPIPE/ECONNRESET.
    });
    // Not `once`: it would reject on the expected socket error.
    const closed = new Promise((resolve) => socket.on('close', resolve));
    socket.write(
      'POST /ingest HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n',
    );
    // Never terminated: without the drain limit the server would wait for the end forever.
    const chunk = ' '.repeat(MAX_INGEST_BODY_BYTES);
    for (let i = 0; i < 12 && !socket.destroyed; i++) {
      socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    }
    await closed;
    // The 413 may be lost to the reset when the client is still writing; if it arrived, it is a 413.
    if (received !== '') {
      expect(received.startsWith('HTTP/1.1 413')).toBe(true);
    }
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('answers 413 for a body over the cap without content-length', async () => {
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(`${bus.http.url}/ingest`, { method: 'POST', headers: json }, (r) => {
        let text = '';
        r.on('data', (c: Buffer) => {
          text += c.toString('utf8');
        });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      // Chunked: the cap is only hit while reading, after the first megabyte.
      req.write(' '.repeat(MAX_INGEST_BODY_BYTES));
      req.write(' '.repeat(MAX_INGEST_BODY_BYTES));
      req.end();
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual({ error: `body over ${MAX_INGEST_BODY_BYTES} bytes` });
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('answers 413 for a batch over the cap and accepts exactly the cap', async () => {
    const over = await post(Array.from({ length: MAX_INGEST_BATCH + 1 }, () => progress()));
    expect(over.status).toBe(413);
    expect(bus.db.listEvents()).toHaveLength(0);
    const exact = await post(Array.from({ length: MAX_INGEST_BATCH }, () => progress()));
    expect(exact.status).toBe(202);
    expect(bus.db.listEvents(undefined, 500)).toHaveLength(MAX_INGEST_BATCH);
  });
});

describe('POST /ingest validation', () => {
  const attention = {
    type: 'attention',
    source: 'apm-hub/queue',
    agentId: null,
    issue: 43,
    runId: null,
    data: { kind: 'GATE', summary: 'needs a human', pr: null },
  };
  const usage = {
    ...attention,
    type: 'usage',
    data: { contextTokens: 1200, costUsd: 0.5, model: null },
  };
  const queueItem = {
    ...attention,
    type: 'queue.item',
    data: { state: 'started', exitCode: null, durationMs: null, mode: null },
  };

  it('accepts attention, usage and queue.item', async () => {
    const res = await post([attention, usage, queueItem]);
    expect(res.status).toBe(202);
    expect(
      bus.db
        .listEvents()
        .reverse()
        .map((r) => r.kind),
    ).toEqual(['attention', 'usage', 'queue.item']);
  });

  it('answers 403 for a disallowed type wherever it sits in the batch', async () => {
    const bad = { ...progress(), type: 'hook:idle' };
    const invalid = { type: 'progress', source: 'apm-hub/hook' };
    for (const batch of [
      [bad, invalid],
      [invalid, bad],
      [progress(), invalid, bad],
    ]) {
      expect((await post(batch)).status).toBe(403);
    }
    expect(bus.db.listEvents()).toHaveLength(0);
  });

  it('answers 400 for an allowed type with a bad payload', async () => {
    const res = await post({ ...progress(), data: { line: '' } });
    expect(res.status).toBe(400);
  });

  it('keeps the 400 message short however large the batch', async () => {
    const bad = { ...progress(), data: { nope: 1 } };
    const res = await post(Array.from({ length: MAX_INGEST_BATCH }, () => bad));
    const { error } = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(error.startsWith('item 0: ')).toBe(true);
    expect(error.length).toBeLessThanOrEqual(220);
  });

  it('assigns id and at itself, whatever the client sends', async () => {
    const before = Date.now();
    const res = await post([
      progress({ id: 999999, at: '2000-01-01T00:00:00.000Z' }),
      progress({ id: -5, at: 'garbage' }),
    ]);
    expect(res.status).toBe(202);
    const rows = bus.db.listEvents().reverse();
    const { ids } = (await res.json()) as { ids: number[] };
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(ids.every((id) => id !== 999999 && id > 0)).toBe(true);
    for (const row of rows) {
      expect(new Date(row.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
  });
});

describe('POST /ingest broadcast', () => {
  it('stays 202 and logs when a subscriber throws', async () => {
    bus.events.onEvent(() => {
      throw new Error('subscriber boom');
    });
    const res = await post(progress());
    expect(res.status).toBe(202);
    await tick();
    expect(bus.db.listEvents()).toHaveLength(1);
    expect(bus.readLog()).toContain('subscriber boom');
  });

  it('publishes rows in id order after the commit, before replying', async () => {
    const order: string[] = [];
    bus.events.onEvent((e) => {
      const stored = bus.db.listEvents(undefined, 500).some((r) => r.id === e.id);
      order.push(`publish ${e.id}${stored ? '' : ' (not stored)'}`);
    });
    bus.http.server.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
      const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
      res.writeHead = ((...args: unknown[]) => {
        order.push(`reply ${String(args[0])}`);
        return writeHead(...args);
      }) as ServerResponse['writeHead'];
    });
    const res = await post([progress(), progress(), progress()]);
    const { ids } = (await res.json()) as { ids: number[] };
    expect(order).toEqual([...ids.map((id) => `publish ${id}`), 'reply 202']);
  });
});
