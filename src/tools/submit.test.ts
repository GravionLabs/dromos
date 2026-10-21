import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGateCommands, runGate } from '../gate.js';
import type { GateResult } from '../schemas.js';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';
import { pendingGates, redact } from './submit.js';

const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));
vi.mock('../gate.js', () => ({
  resolveGateCommands: vi.fn(() => [{ name: 'test', run: 'pnpm test' }]),
  runGate: vi.fn(),
}));
const mockResolve = vi.mocked(resolveGateCommands);
const mockRunGate = vi.mocked(runGate);

const red: GateResult = {
  passed: false,
  steps: [
    { name: 'lint', command: 'pnpm lint', exitCode: 0, durationMs: 1, outputTail: 'ok' },
    { name: 'test', command: 'pnpm test', exitCode: 2, durationMs: 1, outputTail: 'boom tail' },
  ],
};
const green: GateResult = {
  passed: true,
  steps: [{ name: 'test', command: 'pnpm test', exitCode: 0, durationMs: 1, outputTail: '' }],
};

function deferred() {
  let resolve: (g: GateResult) => void = () => undefined;
  const promise = new Promise<GateResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('redact', () => {
  it('masks tokens, bearer headers and secret assignments', () => {
    const out = redact('ghp_abcdefghijklmnopqrstu Bearer abcdefgh12345 API_KEY: xyz');
    expect(out).not.toMatch(/ghp_abc|abcdefgh12345|xyz/);
  });
  it('leaves ordinary text alone', () => {
    expect(redact('3 tests failed')).toBe('3 tests failed');
  });
});

describe('submit_implementation', () => {
  let bus: TestBus;
  let status = '';
  let ahead = '2';

  const addRun = (patch: { state?: 'implementing' | 'reviewing'; round?: number } = {}) =>
    bus.db.insertRun({
      id: 'run-1-1',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 1,
      issueTitle: 'Title',
      baseBranch: 'main',
      branch: 'agent/1-title',
      worktreePath: '/wt',
      state: patch.state ?? 'implementing',
      round: patch.round ?? 1,
    });
  const submit = async () => {
    const client = await bus.connect('implementer');
    return client.callTool({
      name: 'submit_implementation',
      arguments: { runId: 'run-1-1', summary: 'Did it' },
    });
  };
  const settle = () => Promise.all([...pendingGates.values()]);

  beforeEach(async () => {
    status = '';
    ahead = '2';
    mockRunGate.mockReset();
    mockExeca.mockReset();
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => ({
      stdout: args.includes('status') ? status : args.includes('rev-list') ? ahead : '',
    }));
    bus = await startTestBus();
  });
  afterEach(async () => {
    await settle();
    await bus.close();
  });

  it('returns gate_started before the gate resolves, then sends review_request on green', async () => {
    addRun();
    const gate = deferred();
    mockRunGate.mockReturnValue(gate.promise);
    const result = await submit();
    expect(JSON.parse(textOf(result))).toEqual({ status: 'gate_started' });
    expect(bus.db.getRun('run-1-1')?.state).toBe('gating');
    expect(bus.db.listUnacked('reviewer')).toEqual([]);

    gate.resolve(green);
    await settle();
    const run = bus.db.getRun('run-1-1');
    expect(run?.state).toBe('reviewing');
    expect(run?.lastGate).toEqual(green);
    const [msg] = bus.db.listUnacked('reviewer');
    expect(msg?.type).toBe('review_request');
    expect(msg?.payload).toMatchObject({
      runId: 'run-1-1',
      worktreePath: '/wt',
      branch: 'agent/1-title',
      baseBranch: 'main',
      implementationSummary: 'Did it',
      diffCommand: "git -C '/wt' diff 'origin/main'...HEAD",
      issue: { number: 1, title: 'Title' },
      instructions: 'Review the diff read-only. Call submit_review.',
    });
    expect(pendingGates.size).toBe(0);
  });

  it('sends gate_result with the failing step and increments the round on red', async () => {
    addRun();
    mockRunGate.mockResolvedValue(red);
    await submit();
    await settle();
    const run = bus.db.getRun('run-1-1');
    expect(run).toMatchObject({ state: 'implementing', round: 2 });
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.type).toBe('gate_result');
    expect(msg?.payload).toMatchObject({
      failedStep: 'test',
      exitCode: 2,
      outputTail: 'boom tail',
      round: 2,
    });
    expect(run?.lastGate).toEqual(red);
    expect(msg?.payload).toMatchObject({ passed: false });
    expect(bus.db.listUnacked('reviewer')).toEqual([]);
  });

  it('blocks the run and notifies the orchestrator on red in the last round', async () => {
    addRun({ round: bus.config.maxRounds });
    mockRunGate.mockResolvedValue(red);
    await submit();
    await settle();
    expect(bus.db.getRun('run-1-1')?.state).toBe('blocked');
    const [msg] = bus.db.listUnacked('orchestrator');
    expect(msg?.type).toBe('notice');
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      reason: 'round limit reached',
      lastGate: red,
    });
    expect(bus.db.listUnacked('implementer')).toEqual([]);
  });

  it('treats a crashing gate as failed and logs ERROR', async () => {
    addRun();
    mockRunGate.mockRejectedValue(new Error('spawn exploded'));
    await submit();
    await settle();
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'implementing', round: 2 });
    expect(bus.readLog()).toContain('spawn exploded');
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.payload).toMatchObject({ outputTail: expect.stringContaining('spawn exploded') });
  });

  it('rejects uncommitted changes without a state change', async () => {
    addRun();
    status = ' M file.ts';
    const result = await submit();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('uncommitted changes');
    expect(bus.db.getRun('run-1-1')?.state).toBe('implementing');
    expect(mockRunGate).not.toHaveBeenCalled();
  });

  it('rejects zero commits ahead of the base', async () => {
    addRun();
    ahead = '0';
    const result = await submit();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no commits ahead of origin/main');
    expect(bus.db.getRun('run-1-1')?.state).toBe('implementing');
  });

  it('rejects a run that is not implementing', async () => {
    addRun({ state: 'reviewing' });
    const result = await submit();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is in state 'reviewing'");
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('asks git for status and the commit range against origin/<base>', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    await submit();
    await settle();
    const argvs = mockExeca.mock.calls.map(([, argv]) => (argv as string[]).join(' '));
    expect(argvs).toContain('-C /wt status --porcelain');
    expect(argvs).toContain('-C /wt rev-list --count origin/main..HEAD');
  });

  it('reports a git failure without a state change', async () => {
    addRun();
    mockExeca.mockRejectedValue(new Error('not a repo'));
    const result = await submit();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('could not inspect the worktree: not a repo');
    expect(bus.db.getRun('run-1-1')?.state).toBe('implementing');
  });

  it('rejects a non-numeric commit count', async () => {
    addRun();
    ahead = 'garbage';
    const result = await submit();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no commits ahead');
    expect(mockRunGate).not.toHaveBeenCalled();
  });

  it('rejects a double submit while the gate is running', async () => {
    addRun();
    const gate = deferred();
    mockRunGate.mockReturnValue(gate.promise);
    await submit();
    const second = await submit();
    expect(second.isError).toBe(true);
    expect(mockRunGate).toHaveBeenCalledTimes(1);
    gate.resolve(green);
  });

  it('drops a stale gate result when the run left gating', async () => {
    addRun();
    const gate = deferred();
    mockRunGate.mockReturnValue(gate.promise);
    await submit();
    bus.db.updateRun('run-1-1', { state: 'blocked' });
    gate.resolve(green);
    await settle();
    expect(bus.db.getRun('run-1-1')?.state).toBe('blocked');
    expect(bus.db.listUnacked('reviewer')).toEqual([]);
    expect(bus.readLog()).toContain('gate result dropped');
  });

  it('blocks the run and notifies the orchestrator when persisting the outcome fails', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await submit();
    await settle();
    spy.mockRestore();
    expect(bus.db.getRun('run-1-1')?.state).toBe('blocked');
    expect(bus.readLog()).toContain('disk full');
    const [msg] = bus.db.listUnacked('orchestrator');
    expect(msg?.payload).toMatchObject({ reason: 'gate handling failed: disk full' });
    expect(bus.db.listUnacked('reviewer')).toEqual([]);
    expect(pendingGates.size).toBe(0);
  });

  it('treats a throwing resolveGateCommands as a failed gate', async () => {
    addRun();
    mockResolve.mockImplementationOnce(() => {
      throw new Error('no commands');
    });
    await submit();
    await settle();
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'implementing', round: 2 });
    expect(mockRunGate).not.toHaveBeenCalled();
  });

  it('still delivers the message when waking the recipient fails', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    vi.spyOn(bus.events, 'messageFor').mockImplementation(() => {
      throw new Error('wake failed');
    });
    await submit();
    await settle();
    expect(bus.db.getRun('run-1-1')?.state).toBe('reviewing');
    expect(bus.db.listUnacked('reviewer')).toHaveLength(1);
  });

  it('wakes the reviewer on green', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const wake = vi.spyOn(bus.events, 'messageFor');
    await submit();
    await settle();
    expect(wake).toHaveBeenCalledWith('reviewer');
  });

  it('includes a per-step summary in gate_result', async () => {
    addRun();
    mockRunGate.mockResolvedValue(red);
    await submit();
    await settle();
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.payload).toMatchObject({
      steps: [
        { name: 'lint', exitCode: 0 },
        { name: 'test', exitCode: 2 },
      ],
    });
  });

  it('redacts credentials in relayed output', async () => {
    addRun();
    mockRunGate.mockResolvedValue({
      passed: false,
      steps: [
        {
          name: 'test',
          command: 'x',
          exitCode: 1,
          durationMs: 1,
          outputTail: 'GITHUB_TOKEN=abc123 failed',
        },
      ],
    });
    await submit();
    await settle();
    const [msg] = bus.db.listUnacked('implementer');
    expect(JSON.stringify(msg?.payload)).not.toContain('abc123');
  });

  it('survives a failing git fetch', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('fetch')) throw new Error('offline');
      return { stdout: args.includes('status') ? '' : '2' };
    });
    const result = await submit();
    await settle();
    expect(result.isError).toBeFalsy();
  });

  it('lets only one of two concurrent submits start a gate', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const [a, b] = await Promise.all([submit(), submit()]);
    await settle();
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    expect(mockRunGate).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown run', async () => {
    const result = await submit();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unknown run: run-1-1');
  });

  it.each(['orchestrator', 'reviewer'] as const)('rejects role %s', async (role) => {
    addRun();
    const client = await bus.connect(role);
    const result = await client
      .callTool({ name: 'submit_implementation', arguments: { runId: 'run-1-1', summary: 'x' } })
      .catch((e: Error) => e);
    const message = result instanceof Error ? result.message : textOf(result);
    expect(message).toContain(
      `tool submit_implementation is not allowed for role ${role} (allowed: implementer)`,
    );
    expect(bus.db.getRun('run-1-1')?.state).toBe('implementing');
  });
});
