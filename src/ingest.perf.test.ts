import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestBus, type TestBus } from './test-helpers.js';

const event = {
  type: 'progress',
  source: 'apm-hub/hook',
  agentId: null,
  issue: 43,
  runId: null,
  data: { line: 'built', agent: 'orchestrator' },
};

// Opt-in: wall-clock assertions are flaky on shared CI. Run with DROMOS_PERF=1.
describe.skipIf(process.env.DROMOS_PERF !== '1')('POST /ingest latency', () => {
  let bus: TestBus;
  beforeAll(async () => {
    bus = await startTestBus();
  });
  afterAll(async () => {
    await bus.close();
  });

  const post = () =>
    fetch(`${bus.http.url}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });

  it('keeps p99 under 50 ms over 1000 sequential posts', async () => {
    for (let i = 0; i < 50; i++) {
      await (await post()).arrayBuffer();
    }
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      const res = await post();
      await res.arrayBuffer();
      samples.push(performance.now() - t0);
      expect(res.status).toBe(202);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.ceil(samples.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(`ingest p99 = ${p99.toFixed(2)} ms\n`);
    expect(p99).toBeLessThan(50);
  }, 60_000);
});
