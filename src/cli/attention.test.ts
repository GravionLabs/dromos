import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestBus, type TestBus } from '../test-helpers.js';
import { runAttentionCli } from './attention.js';

let bus: TestBus;
beforeEach(async () => {
  bus = await startTestBus();
});
afterEach(async () => {
  await bus.close();
});

async function ingest(issue: number | null, summary: string): Promise<number> {
  const res = await fetch(`${bus.http.url}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'attention',
      source: 'apm-hub/queue',
      agentId: null,
      issue,
      runId: null,
      data: { kind: 'QUESTION', summary, pr: null },
    }),
  });
  return ((await res.json()) as { id: number }).id;
}

async function cli(argv: string[], env: NodeJS.ProcessEnv = { USER: 'alice' }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAttentionCli(argv, {
    baseUrl: bus.http.url,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
}

describe('dromos attention list', () => {
  it('prints only open rows with --state open', async () => {
    const a = await ingest(7, 'first');
    const b = await ingest(8, 'second');
    await cli(['answer', String(a), 'yes']);
    const r = await cli(['list', '--state', 'open']);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`${b} open QUESTION 8 second`]);
  });

  it('lists all rows without filters and filters by --issue', async () => {
    const a = await ingest(7, 'first');
    await ingest(null, 'second');
    expect((await cli(['list'])).out).toHaveLength(2);
    expect((await cli(['list', '--issue', '7'])).out).toEqual([`${a} open QUESTION 7 first`]);
  });

  it('prints nothing for an empty bus', async () => {
    expect(await cli(['list'])).toEqual({ code: 0, out: [], err: [] });
  });

  it('rejects a bad state or issue with exit 2', async () => {
    expect((await cli(['list', '--state', 'nope'])).code).toBe(2);
    expect((await cli(['list', '--issue', 'x'])).code).toBe(2);
    expect((await cli(['list', '--bogus', '1'])).code).toBe(2);
    expect((await cli(['list', '--state'])).code).toBe(2);
  });
});

describe('dromos attention answer / ack', () => {
  it('answers, then a second answer exits 1 with a 409 message, then ack succeeds', async () => {
    const id = await ingest(7, 'q');
    const first = await cli(['answer', String(id), 'go ahead']);
    expect(first.code).toBe(0);
    expect(first.out).toEqual([`${id} answered QUESTION 7 q`]);

    const second = await cli(['answer', String(id), 'again']);
    expect(second.code).toBe(1);
    expect(second.out).toEqual([]);
    expect(second.err[0]).toMatch(/^dromos: conflict: .*cannot answer/);

    const ack = await cli(['ack', String(id)]);
    expect(ack.code).toBe(0);
    expect(ack.out).toEqual([`${id} acked QUESTION 7 q`]);
  });

  it('records --by, defaulting to $USER', async () => {
    const a = await ingest(7, 'q');
    const b = await ingest(7, 'q2');
    await cli(['answer', String(a), 'x', '--by', 'bob']);
    await cli(['answer', String(b), 'x'], { USER: 'carol' });
    expect(bus.db.getAttention(a)?.answeredBy).toBe('bob');
    expect(bus.db.getAttention(b)?.answeredBy).toBe('carol');
  });

  it('ack on an open attention exits 1 with a conflict message', async () => {
    const id = await ingest(7, 'q');
    const r = await cli(['ack', String(id)]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain('conflict');
  });

  it('unknown id exits 1 with a not found message', async () => {
    const r = await cli(['answer', '999', 'x']);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain('not found');
  });

  it('passes answer text starting with -- after the -- separator', async () => {
    const id = await ingest(7, 'q');
    const r = await cli(['answer', '--by', 'bob', String(id), '--', '--force it']);
    expect(r.code).toBe(0);
    expect(bus.db.getAttention(id)?.answerText).toBe('--force it');
  });

  it('answer without --by and without $USER exits 2 with a clear message', async () => {
    const id = await ingest(7, 'q');
    const r = await cli(['answer', String(id), 'x'], {});
    expect(r.code).toBe(2);
    expect(r.err[0]).toContain('--by');
    expect(bus.db.getAttention(id)?.state).toBe('open');
  });

  it('ack works without a user name', async () => {
    const id = await ingest(7, 'q');
    await cli(['answer', String(id), 'x']);
    expect((await cli(['ack', String(id)], {})).code).toBe(0);
  });

  it('rejects missing arguments and bad ids with exit 2', async () => {
    expect((await cli(['answer', '1'])).code).toBe(2);
    expect((await cli(['answer', 'abc', 'x'])).code).toBe(2);
    expect((await cli(['ack'])).code).toBe(2);
    expect((await cli(['ack', '1', '2'])).code).toBe(2);
  });
});

describe('dromos attention misc', () => {
  it('missing or unknown subcommand prints usage, exit 2', async () => {
    const none = await cli([]);
    expect(none.code).toBe(2);
    expect(none.err[0]).toContain('usage:');
    expect((await cli(['frobnicate'])).code).toBe(2);
  });

  it('reports a bus that is not running', async () => {
    const err: string[] = [];
    const code = await runAttentionCli(['list'], {
      baseUrl: 'http://127.0.0.1:1',
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err).toEqual(['dromos: bus not running at http://127.0.0.1:1']);
  });

  it('src/index.ts dispatches `attention` to the CLI instead of starting the server', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'attention'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing subcommand');
    expect(r.stderr).not.toContain('listening');
  });
});
