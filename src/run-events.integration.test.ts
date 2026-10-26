import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGateCommands, runGate } from './gate.js';
import { sweepNotices } from './notice-sweep.js';
import { recordRunTransition } from './run-events.js';
import type { GateResult, Review } from './schemas.js';
import { startTestBus, type TestBus } from './test-helpers.js';
import { pendingGates } from './tools/submit.js';

const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));
vi.mock('./run-lease.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-lease.js')>()),
  afterRunTransition: vi.fn(async () => undefined),
}));
vi.mock('./gate.js', () => ({
  resolveGateCommands: vi.fn(() => [{ name: 'test', run: 'pnpm test' }]),
  runGate: vi.fn(),
}));
const mockRunGate = vi.mocked(runGate);
void resolveGateCommands;

const PR_URL = 'https://github.com/o/r/pull/9';
const RUN = 'run-1-1';
const red: GateResult = {
  passed: false,
  steps: [{ name: 'test', command: 'pnpm test', exitCode: 2, durationMs: 1, outputTail: 'boom' }],
};
const green: GateResult = {
  passed: true,
  steps: [{ name: 'test', command: 'pnpm test', exitCode: 0, durationMs: 1, outputTail: '' }],
};
const approve: Review = { verdict: 'approve', summary: 'ok', findings: [] };
const changes: Review = {
  verdict: 'changes',
  summary: 'fix',
  findings: [{ severity: 'important', file: 'a.ts', line: 1, summary: 'bad' }],
};

describe('run event sequence', () => {
  let bus: TestBus;

  const events = () =>
    bus.db
      .queryEvents({ issue: 1, sources: ['dromos'], limit: 500 })
      .events.filter((e) => e.runId === RUN);
  const seq = () =>
    events().map((e) => {
      const d = e.data as Record<string, unknown>;
      const tag = e.kind === 'run.state' ? d.state : (d.outcome ?? d.cause ?? d.verdict);
      return tag === undefined ? e.kind : `${e.kind}:${String(tag)}`;
    });

  const start = () =>
    bus.db.transaction(() => {
      const run = bus.db.insertRun({
        id: RUN,
        repo: 'o/r',
        repoPath: '/repo',
        issueNumber: 1,
        issueTitle: 'Title',
        baseBranch: 'main',
        branch: 'agent/1-title',
        worktreePath: '/wt',
        state: 'implementing',
        round: 1,
      });
      recordRunTransition(bus.db, run, null, { state: 'implementing', round: 1 });
    });
  const call = async (
    role: 'implementer' | 'reviewer' | 'orchestrator',
    name: string,
    args: object,
  ) => {
    const client = await bus.connect(role);
    const result = await client.callTool({ name, arguments: { runId: RUN, ...args } });
    expect(result.isError).toBeFalsy();
  };
  const submit = async (gate: GateResult) => {
    mockRunGate.mockResolvedValueOnce(gate);
    await call('implementer', 'submit_implementation', { summary: 'Did it' });
    await Promise.all([...pendingGates.values()]);
  };

  beforeEach(async () => {
    mockRunGate.mockReset();
    mockExeca.mockReset();
    mockExeca.mockImplementation(async (cmd: string, args: string[]) => ({
      stdout: cmd === 'gh' ? `${PR_URL}\n` : args.includes('rev-list') ? '2' : '',
    }));
    bus = await startTestBus();
    start();
  });
  afterEach(async () => {
    await bus.close();
  });

  it('records the full sequence of an approved run through to the opened PR', async () => {
    await submit(green);
    await call('reviewer', 'submit_review', { review: approve });
    await call('orchestrator', 'open_pr', {});
    expect(seq()).toEqual([
      'run.state:implementing',
      'attempt.started:initial',
      'run.state:gating',
      'gate.result',
      'run.state:reviewing',
      'review.result:approve',
      'run.state:approved',
      'attempt.settled:approved',
      'run.state:pr_opened',
    ]);
    const gate = events().find((e) => e.kind === 'gate.result');
    expect(gate?.data).toMatchObject({ passed: true, evidence: 'verified' });
    expect(events().find((e) => e.kind === 'review.result')?.data).toMatchObject({
      evidence: 'reported',
    });
  });

  it('records three attempts for two gate failures and a pass, each with an evidence tier', async () => {
    await submit(red);
    await submit(red);
    await submit(green);
    await call('reviewer', 'submit_review', { review: approve });
    const started = events()
      .filter((e) => e.kind === 'attempt.started')
      .map((e) => e.data as { n: number; cause: string });
    expect(started).toEqual([
      expect.objectContaining({ n: 1, cause: 'initial' }),
      expect.objectContaining({ n: 2, cause: 'gate_failed' }),
      expect.objectContaining({ n: 3, cause: 'gate_failed' }),
    ]);
    const tiers = events().filter((e) =>
      ['attempt.settled', 'gate.result', 'review.result'].includes(e.kind),
    );
    expect(tiers.map((e) => e.kind)).toEqual([
      'gate.result',
      'attempt.settled',
      'gate.result',
      'attempt.settled',
      'gate.result',
      'review.result',
      'attempt.settled',
    ]);
    for (const e of tiers) {
      expect(['verified', 'reported', 'heuristic', 'asserted']).toContain(
        (e.data as { evidence: string }).evidence,
      );
    }
  });

  it('raises exactly one BLOCKED attention at the round limit, also after a notice sweep', async () => {
    const limit = bus.config.maxRounds;
    for (let i = 0; i < limit; i++) await submit(red);
    expect(bus.db.getRun(RUN)?.state).toBe('blocked');
    const attentions = () => events().filter((e) => e.kind === 'attention');
    expect(attentions()).toHaveLength(1);
    expect(attentions()[0]?.data).toMatchObject({ kind: 'BLOCKED' });

    await sweepNotices(bus.db, bus.events, { logLine: () => undefined } as never, {
      now: () => Date.now() + 120_000,
    });
    expect(attentions()).toHaveLength(1);
  });

  it('records a review sent back as a gate-independent attempt', async () => {
    await submit(green);
    await call('reviewer', 'submit_review', { review: changes });
    expect(seq()).toContain('attempt.settled:sent_back');
    expect(
      events()
        .filter((e) => e.kind === 'attempt.started')
        .map((e) => (e.data as { cause: string }).cause),
    ).toEqual(['initial', 'sent_back']);
  });
});
