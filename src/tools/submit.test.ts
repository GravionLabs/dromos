import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate } from '../gate.js';
import type { GateResult } from '../schemas.js';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';
import { pendingGates } from './submit.js';

vi.mock('execa');
vi.mock('../gate.js', () => ({
  resolveGateCommands: vi.fn(() => [{ name: 'test', run: 'pnpm test' }]),
  runGate: vi.fn(),
}));
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;
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
      stdout: args.includes('status') ? status : ahead,
    }));
    bus = await startTestBus();
  });
  afterEach(async () => {
    await settle();
    await bus.close();
  });

  it('returns gate_started before the gate resolves, then sends review_request on green', async () => {
    addRun();
    let release: (g: GateResult) => void = () => undefined;
    mockRunGate.mockReturnValue(new Promise((r) => (release = r)));
    const result = await submit();
    expect(JSON.parse(textOf(result))).toEqual({ status: 'gate_started' });
    expect(bus.db.getRun('run-1-1')?.state).toBe('gating');
    expect(bus.db.listUnacked('reviewer')).toEqual([]);

    release(green);
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
      diffCommand: 'git -C /wt diff origin/main...HEAD',
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
