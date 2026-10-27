import { describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from './config.js';
import type { Harness, PhaseInput } from './harness.js';
import {
  type ImplementerDeps,
  type ImplementerEvent,
  type PbiSpec,
  planWaves,
  runImplementerPhase,
  tail,
} from './implementer.js';

const IMPLEMENTING = { kind: 'implementing', round: 0 } as const;

const task = (number: number, blockedBy: number[] = []) => ({
  number,
  title: `task ${String(number)}`,
  body: `body of ${String(number)}`,
  blockedBy,
});

const pbi = (tasks: PbiSpec['tasks']): PbiSpec => ({
  number: 10,
  title: 'the pbi',
  acceptanceCriteria: '- [ ] criterion A',
  body: 'pbi body',
  tasks,
});

interface Fake {
  harness: Harness;
  inputs: PhaseInput[];
  peak: () => number;
}

/** A fake harness: counts concurrent sessions and answers per prompt via `answer`. */
function fakeHarness(
  answer: (prompt: string) => unknown = () => ({ status: 'done', summary: 'ok' }),
): Fake {
  const inputs: PhaseInput[] = [];
  let active = 0;
  let peak = 0;
  return {
    inputs,
    peak: () => peak,
    harness: {
      async runPhase(input) {
        inputs.push(input);
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        const result = answer(input.prompt);
        if (result instanceof Error) throw result;
        return { result, events: [], usage: { inputTokens: 1, outputTokens: 2, costUsd: null } };
      },
    },
  };
}

function setup(
  fake: Fake,
  config: Record<string, unknown> = {},
  runTests: ImplementerDeps['runTests'] = async () => ({ passed: true, output: '' }),
) {
  const events: ImplementerEvent[] = [];
  const commands: string[] = [];
  const deps: ImplementerDeps = {
    harness: fake.harness,
    harnessInfo: { id: 'claude', name: 'claude', version: null, sdk: null },
    config: RunnerConfigSchema.parse(config),
    cwd: '/wt',
    skillDirs: ['/skills/implementation'],
    allow: () => ({ allow: true }),
    timeoutMs: 1000,
    runTests: async (command, cwd) => {
      commands.push(command);
      return (runTests ?? (async () => ({ passed: true, output: '' })))(command, cwd);
    },
    emit: (e) => events.push(e),
  };
  return { deps, events, commands };
}

describe('planWaves', () => {
  it('puts unlinked Tasks in one wave', () => {
    expect(planWaves([task(1), task(2)]).map((w) => w.map((t) => t.number))).toEqual([[1, 2]]);
  });

  it('orders blocked Tasks after their blockers', () => {
    const waves = planWaves([task(3, [1, 2]), task(1), task(2, [1])]);
    expect(waves.map((w) => w.map((t) => t.number))).toEqual([[1], [2], [3]]);
  });

  it('ignores blockers that are not Tasks of the PBI', () => {
    expect(planWaves([task(1, [99])])).toHaveLength(1);
  });

  it('throws on a cycle', () => {
    expect(() => planWaves([task(1, [2]), task(2, [1])])).toThrow(/block each other/);
  });
});

describe('tail', () => {
  it('keeps the last 50 lines', () => {
    const out = Array.from({ length: 80 }, (_, i) => `line ${String(i)}`).join('\n');
    const kept = tail(out).split('\n');
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe('line 30');
    expect(kept.at(-1)).toBe('line 79');
  });
});

describe('runImplementerPhase', () => {
  it('runs Tasks without a link in parallel sessions', async () => {
    const fake = fakeHarness();
    const { deps } = setup(fake);
    await runImplementerPhase(deps, pbi([task(1), task(2), task(3)]), IMPLEMENTING);
    expect(fake.inputs).toHaveLength(3);
    expect(fake.peak()).toBe(3);
  });

  it('caps parallel sessions at config.parallel', async () => {
    const fake = fakeHarness();
    const { deps } = setup(fake, { parallel: 2 });
    await runImplementerPhase(deps, pbi([task(1), task(2), task(3), task(4)]), IMPLEMENTING);
    expect(fake.inputs).toHaveLength(4);
    expect(fake.peak()).toBe(2);
  });

  it('runs a blocked Task only after its blocker', async () => {
    const fake = fakeHarness();
    const { deps } = setup(fake);
    await runImplementerPhase(deps, pbi([task(2, [1]), task(1)]), IMPLEMENTING);
    expect(fake.inputs.map((i) => /Implement #(\d+)/.exec(i.prompt)?.[1])).toEqual(['1', '2']);
    expect(fake.peak()).toBe(1);
  });

  it('gives each Task a fresh session with Task body, PBI criteria and the skill', async () => {
    const fake = fakeHarness();
    const { deps } = setup(fake);
    await runImplementerPhase(deps, pbi([task(1), task(2)]), IMPLEMENTING);
    for (const input of fake.inputs) {
      expect(input.prompt).toContain('criterion A');
      expect(input.prompt).toMatch(/body of [12]/);
      expect(input.skills).toEqual(['/skills/implementation']);
      expect(input.cwd).toBe('/wt');
      expect(input.model).toBe('sonnet');
    }
    expect(fake.inputs[0]?.prompt).not.toContain('body of 2');
  });

  it('runs a PBI without Tasks as one implementer phase', async () => {
    const fake = fakeHarness();
    const { deps } = setup(fake);
    await runImplementerPhase(deps, pbi([]), IMPLEMENTING);
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]?.prompt).toContain('pbi body');
  });

  it('runs test.related once after all Tasks, never the full suite', async () => {
    const fake = fakeHarness();
    const { deps, commands } = setup(fake, {
      test: { related: 'npm run test:related', full: 'npm test' },
    });
    await runImplementerPhase(deps, pbi([task(1), task(2)]), IMPLEMENTING);
    expect(commands).toEqual(['npm run test:related']);
  });

  it('falls back to test.full without test.related', async () => {
    const { deps, commands } = setup(fakeHarness(), { test: { full: 'pnpm test' } });
    await runImplementerPhase(deps, pbi([]), IMPLEMENTING);
    expect(commands).toEqual(['pnpm test']);
  });

  it('feeds green tests into the state machine and emits events', async () => {
    const { deps, events } = setup(fakeHarness());
    const out = await runImplementerPhase(deps, pbi([task(1)]), IMPLEMENTING);
    expect(out.state).toEqual({ kind: 'reviewing', round: 0 });
    expect(out.failureTail).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual([
      'phase.started',
      'phase.finished',
      'implement.finished',
      'outcome.tests',
      'tests.passed',
    ]);
    expect(out.usage).toEqual([{ inputTokens: 1, outputTokens: 2, costUsd: null }]);
  });

  it('blocks on red tests and keeps the last 50 lines', async () => {
    const output = Array.from({ length: 80 }, (_, i) => `out ${String(i)}`).join('\n');
    const { deps, events } = setup(fakeHarness(), {}, async () => ({ passed: false, output }));
    const out = await runImplementerPhase(deps, pbi([task(1)]), IMPLEMENTING);
    expect(out.state.kind).toBe('blocked');
    expect(out.failureTail?.split('\n')).toHaveLength(50);
    expect(out.failureTail?.endsWith('out 79')).toBe(true);
    expect(events.at(-1)?.type).toBe('run.blocked');
  });

  it('emits the parsed test result before the state changes', async () => {
    const output = ' FAIL  a.test.ts > breaks\n      Tests  1 failed | 3 passed (4)';
    const { deps, events } = setup(fakeHarness(), {}, async () => ({ passed: false, output }));
    await runImplementerPhase(deps, pbi([task(1)]), IMPLEMENTING);
    expect(events.find((e) => e.type === 'outcome.tests')).toEqual({
      type: 'outcome.tests',
      data: { passed: 3, failed: 1, failures: ['a.test.ts > breaks'] },
    });
  });

  it('blocks without running tests when a session reports failure', async () => {
    const fake = fakeHarness((p) => ({
      status: p.includes('#2') ? 'failed' : 'done',
      summary: 'nope',
    }));
    const { deps, events, commands } = setup(fake);
    const out = await runImplementerPhase(deps, pbi([task(1), task(2)]), IMPLEMENTING);
    expect(out.state).toEqual({ kind: 'blocked', reason: 'implementer #2 failed: nope' });
    expect(commands).toEqual([]);
    expect(events.filter((e) => e.type === 'phase.failed')).toHaveLength(1);
  });

  it('treats a harness error or a result off the schema as a failed session', async () => {
    const thrown = setup(fakeHarness(() => new Error('timeout')));
    const a = await runImplementerPhase(thrown.deps, pbi([]), IMPLEMENTING);
    expect(a.state).toEqual({ kind: 'blocked', reason: 'implementer #10 failed: timeout' });

    const bad = setup(fakeHarness(() => ({ wrong: true })));
    const b = await runImplementerPhase(bad.deps, pbi([]), IMPLEMENTING);
    expect(b.state.kind).toBe('blocked');
  });

  it('uses the round-2 model after a review round', async () => {
    const fake = fakeHarness();
    const { deps } = setup(fake);
    await runImplementerPhase(deps, pbi([]), { kind: 'implementing', round: 1 });
    expect(fake.inputs[0]?.model).toBe('opus');
  });
});
