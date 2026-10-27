import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent } from './event-store.js';
import { startTestBus, type TestBus } from './test-helpers.js';

const progress = (issue: number) => ({
  id: 0,
  at: '2030-01-01T00:00:00.000Z',
  source: 'test',
  type: 'progress',
  agentId: null,
  issue,
  runId: null,
  data: { line: 'built', agent: 'orchestrator' },
});

// Opt-in: wall-clock assertions are flaky on shared CI. Run with DROMOS_PERF=1.
describe.skipIf(process.env.DROMOS_PERF !== '1')('GET /events latency', () => {
  let bus: TestBus;
  let midId = 0;
  beforeAll(async () => {
    bus = await startTestBus();
    bus.db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const row = recordEvent(bus.db, bus.events, 'perf', progress(7));
        if (i === 5000) {
          midId = row.id;
        }
        recordEvent(bus.db, bus.events, 'perf', progress(8 + (i % 20)));
      }
    });
  }, 60_000);
  afterAll(async () => {
    await bus.close();
  });

  const p99 = async (qs: string): Promise<number> => {
    const get = async () => {
      const res = await fetch(`${bus.http.url}/events${qs}`);
      await res.arrayBuffer();
      return res.status;
    };
    for (let i = 0; i < 50; i++) {
      await get();
    }
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      const status = await get();
      samples.push(performance.now() - t0);
      expect(status).toBe(200);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.ceil(samples.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY;
  };

  it('keeps p99 under 50 ms for the first page of a 10k-event issue', async () => {
    const value = await p99('?issue=7&limit=1000');
    process.stdout.write(`events first page p99 = ${value.toFixed(2)} ms\n`);
    expect(value).toBeLessThan(50);
  }, 60_000);

  it('keeps p99 under 50 ms for a mid-table after page', async () => {
    const value = await p99(`?issue=7&limit=1000&after=${midId}`);
    process.stdout.write(`events mid page p99 = ${value.toFixed(2)} ms\n`);
    expect(value).toBeLessThan(50);
  }, 60_000);
});
