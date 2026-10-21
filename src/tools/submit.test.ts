import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGateCommands, runGate } from '../gate.js';
import type { GateResult } from '../schemas.js';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';
import { pendingGates } from './submit.js';

const mockExeca = vi.hoisted(() => vi.fn());
/** When set, the bus log throws for lines matching it (once), to simulate a logging failure. */
const failLog = vi.hoisted(() => ({ pattern: undefined as RegExp | undefined }));
vi.mock('../bus-log.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../bus-log.js')>();
  return {
    ...real,
    createBusLog: (dataDir: string) => {
      const log = real.createBusLog(dataDir);
      return {
        file: log.file,
        logLine: (kind: Parameters<typeof log.logLine>[0], text: string) => {
          if (failLog.pattern?.test(`${kind} ${text}`)) {
            failLog.pattern = undefined;
            throw new Error('log down');
          }
          log.logLine(kind, text);
        },
      };
    },
  };
});
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

/** Gates held open by a test; afterEach releases them so a failed assertion cannot hang. */
const held: ((g: GateResult) => void)[] = [];

function deferred() {
  let resolve: (g: GateResult) => void = () => undefined;
  const promise = new Promise<GateResult>((r) => {
    resolve = r;
  });
  held.push(resolve);
  return { promise, resolve };
}

describe('submit_implementation', () => {
  let bus: TestBus;
  let status = '';
  let ahead = '2';

  const addRun = (
    patch: {
      state?: 'implementing' | 'reviewing';
      round?: number;
      baseBranch?: string;
      worktreePath?: string;
    } = {},
  ) =>
    bus.db.insertRun({
      id: 'run-1-1',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 1,
      issueTitle: 'Title',
      baseBranch: patch.baseBranch ?? 'main',
      branch: 'agent/1-title',
      worktreePath: patch.worktreePath ?? '/wt',
      state: patch.state ?? 'implementing',
      round: patch.round ?? 1,
    });
  const submit = async (summary = 'Did it') => {
    const client = await bus.connect('implementer');
    return client.callTool({
      name: 'submit_implementation',
      arguments: { runId: 'run-1-1', summary },
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
    failLog.pattern = undefined;
    for (const release of held.splice(0)) release(green);
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
      diffCommand: 'git -C /wt diff origin/main...HEAD',
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
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      round: 2,
      failedStep: 'test',
      exitCode: 2,
      outputTail: 'boom tail',
    });
    expect(run?.lastGate).toEqual(red);
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
    expect(bus.db.getRun('run-1-1')?.lastGate).toEqual(red);
    expect(bus.db.listUnacked('implementer')).toEqual([]);
  });

  it('treats a crashing gate as failed and logs ERROR', async () => {
    addRun();
    mockRunGate.mockRejectedValue(new Error('spawn exploded'));
    await submit();
    await settle();
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'implementing', round: 2 });
    expect(bus.readLog()).toMatch(/ERROR.*gate crashed: spawn exploded/);
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      round: 2,
      failedStep: 'gate',
      exitCode: 1,
      outputTail: 'gate crashed: spawn exploded',
    });
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
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['/wt', 'status', '--porcelain']),
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['/wt', 'rev-list', '--count', 'origin/main..HEAD']),
      expect.objectContaining({ timeout: 30_000 }),
    );
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
    expect(textOf(second)).toBe(
      "run run-1-1 is in state 'gating', submit_implementation needs 'implementing'",
    );
    expect(mockRunGate).toHaveBeenCalledTimes(1);
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

  it('treats a failure to persist the outcome as gate_failed', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await submit();
    await settle();
    spy.mockRestore();
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'implementing', round: 2 });
    expect(bus.readLog()).toMatch(/ERROR.*gate handling failed: disk full/);
    expect(bus.db.listUnacked('reviewer')).toEqual([]);
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      round: 2,
      failedStep: 'gate',
      exitCode: 1,
      outputTail: 'gate handling failed: disk full',
    });
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
    expect(bus.readLog()).toMatch(/ERROR\s+run-1-1 gate crashed: no commands/);
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.type).toBe('gate_result');
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      round: 2,
      failedStep: 'gate',
      exitCode: 1,
      outputTail: 'gate crashed: no commands',
    });
  });

  it('blocks the run when the gate_failed fallback lands on the last round', async () => {
    addRun({ round: bus.config.maxRounds });
    mockRunGate.mockResolvedValue(green);
    const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await submit();
    await settle();
    spy.mockRestore();
    expect(bus.db.getRun('run-1-1')?.state).toBe('blocked');
    const [msg] = bus.db.listUnacked('orchestrator');
    expect(msg?.payload).toMatchObject({
      runId: 'run-1-1',
      reason: 'round limit reached',
      lastGate: { passed: false, steps: [{ outputTail: 'gate handling failed: disk full' }] },
    });
  });

  it('logs ERROR and leaves the run when even the gate_failed fallback cannot be stored', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementation(() => {
      throw new Error('read-only');
    });
    await submit();
    await settle();
    spy.mockRestore();
    const log = bus.readLog();
    expect(log).toMatch(/ERROR\s+run-1-1 gate_failed handling failed: read-only/);
    expect(bus.db.getRun('run-1-1')?.state).toBe('gating');
    expect(bus.db.listUnacked('orchestrator')).toEqual([]);
    expect(pendingGates.size).toBe(0);
  });

  it('does not fall back to gate_failed when only post-commit logging fails', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const realGetRun = bus.db.getRun.bind(bus.db);
    // Fail only the read that follows the committed outcome (the run is then reviewing).
    const spy = vi.spyOn(bus.db, 'getRun').mockImplementation((id: string) => {
      const run = realGetRun(id);
      if (run?.state === 'reviewing') throw new Error('read failed');
      return run;
    });
    const wake = vi.spyOn(bus.events, 'messageFor');
    await submit();
    await settle();
    spy.mockRestore();
    expect(wake).toHaveBeenCalledWith('reviewer');
    wake.mockRestore();
    expect(bus.db.getRun('run-1-1')?.state).toBe('reviewing');
    expect(bus.db.listUnacked('reviewer')).toHaveLength(1);
    expect(bus.db.listUnacked('implementer')).toEqual([]);
    const log = bus.readLog();
    expect(log).toMatch(/ERROR\s+run-1-1 could not log the gate outcome: read failed/);
    expect(log).not.toContain('gate handling failed');
  });

  it('still delivers the message when waking the recipient fails', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const wake = vi.spyOn(bus.events, 'messageFor').mockImplementation(() => {
      throw new Error('wake failed');
    });
    await submit();
    await settle();
    expect(wake).toHaveBeenCalledWith('reviewer');
    wake.mockRestore();
    expect(bus.db.getRun('run-1-1')?.state).toBe('reviewing');
    expect(bus.db.listUnacked('reviewer')).toHaveLength(1);
  });

  it('wakes only the reviewer on green and logs GATE, STATE and MESSAGE', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const wake = vi.spyOn(bus.events, 'messageFor');
    await submit();
    await settle();
    expect(wake.mock.calls).toEqual([['reviewer']]);
    wake.mockRestore();
    const log = bus.readLog();
    expect(log).toMatch(/STATE\s+run-1-1 gating \(round 1\)/);
    expect(log).toMatch(/GATE\s+run-1-1 passed/);
    expect(log).toMatch(/STATE\s+run-1-1 reviewing \(round 1\)/);
    expect(log).toMatch(/MESSAGE\s+implementer -> reviewer \[review_request\] run-1-1/);
  });

  it('wakes only the implementer on red and logs GATE, STATE and MESSAGE', async () => {
    addRun();
    mockRunGate.mockResolvedValue(red);
    const wake = vi.spyOn(bus.events, 'messageFor');
    await submit();
    await settle();
    expect(wake.mock.calls).toEqual([['implementer']]);
    wake.mockRestore();
    const log = bus.readLog();
    expect(log).toMatch(/GATE\s+run-1-1 failed/);
    expect(log).toMatch(/STATE\s+run-1-1 implementing \(round 2\)/);
    expect(log).toMatch(/MESSAGE\s+orchestrator -> implementer \[gate_result\] run-1-1/);
  });

  it('wakes only the orchestrator when the run is blocked', async () => {
    addRun({ round: bus.config.maxRounds });
    mockRunGate.mockResolvedValue(red);
    const wake = vi.spyOn(bus.events, 'messageFor');
    await submit();
    await settle();
    expect(wake.mock.calls).toEqual([['orchestrator']]);
    wake.mockRestore();
    const log = bus.readLog();
    expect(log).toMatch(/STATE\s+run-1-1 blocked/);
    expect(log).toMatch(/MESSAGE\s+implementer -> orchestrator \[notice\] run-1-1/);
  });

  it('single-quotes a worktree path with spaces in the diff command', async () => {
    addRun({ worktreePath: "/tmp/my wt's" });
    mockRunGate.mockResolvedValue(green);
    await submit();
    await settle();
    const [msg] = bus.db.listUnacked('reviewer');
    expect(msg?.payload).toMatchObject({
      diffCommand: "git -C '/tmp/my wt'\\''s' diff origin/main...HEAD",
    });
  });

  it('lets only one of two concurrent submits start a gate', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    // Hold both status checks until both submits are past the first state check.
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>((r) => {
      release = r;
    });
    let statusCalls = 0;
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('status')) {
        statusCalls += 1;
        if (statusCalls === 2) release();
        await bothArrived;
        return { stdout: '' };
      }
      return { stdout: '2' };
    });
    const results = await Promise.all([submit(), submit()]);
    await settle();
    const losers = results.filter((r) => r.isError);
    expect(losers).toHaveLength(1);
    expect(textOf(losers[0])).toBe("run run-1-1 is no longer in state 'implementing'");
    expect(mockRunGate).toHaveBeenCalledTimes(1);
  });

  it('reports a generic failed step when a red gate has no steps', async () => {
    addRun();
    mockRunGate.mockResolvedValue({ passed: false, steps: [] });
    await submit();
    await settle();
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'implementing', round: 2 });
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      round: 2,
      failedStep: 'gate',
      exitCode: 1,
      outputTail: 'gate reported no steps',
    });
  });

  it('still starts the gate when logging the gating state fails', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    failLog.pattern = /^STATE run-1-1 gating/;
    const result = await submit();
    await settle();
    expect(JSON.parse(textOf(result))).toEqual({ status: 'gate_started' });
    expect(mockRunGate).toHaveBeenCalledTimes(1);
    expect(bus.db.getRun('run-1-1')?.state).toBe('reviewing');
    expect(bus.readLog()).toMatch(/ERROR\s+run-1-1 could not log the state change: log down/);
  });

  it('reports the last step when a red gate has no non-zero step', async () => {
    addRun();
    mockRunGate.mockResolvedValue({
      passed: false,
      steps: [
        { name: 'lint', command: 'pnpm lint', exitCode: 0, durationMs: 1, outputTail: 'a' },
        {
          name: 'build',
          command: 'pnpm build',
          exitCode: 0,
          durationMs: 1,
          outputTail: 'timed out',
        },
      ],
    });
    await submit();
    await settle();
    const [msg] = bus.db.listUnacked('implementer');
    expect(msg?.payload).toEqual({
      runId: 'run-1-1',
      round: 2,
      failedStep: 'build',
      exitCode: 0,
      outputTail: 'timed out',
    });
  });

  it('passes the worktree, configured commands and timeout to the gate', async () => {
    await bus.close();
    const commands = [{ name: 'check', run: 'make check' }];
    bus = await startTestBus({ gate: { commands, timeoutSeconds: 42 } });
    addRun();
    const resolved = [{ name: 'test', run: 'pnpm test' }];
    mockResolve.mockReturnValueOnce(resolved);
    mockRunGate.mockResolvedValue(green);
    await submit();
    await settle();
    expect(mockResolve).toHaveBeenCalledWith('/wt', commands);
    expect(mockRunGate).toHaveBeenCalledWith(resolved, '/wt', 42);
  });

  it.each([
    ['an empty runId', { runId: '', summary: 'x' }],
    ['an empty summary', { runId: 'run-1-1', summary: '' }],
    ['a summary over 5000 characters', { runId: 'run-1-1', summary: 'x'.repeat(5001) }],
  ])('rejects %s', async (_label, args) => {
    addRun();
    const client = await bus.connect('implementer');
    const result = await client
      .callTool({ name: 'submit_implementation', arguments: args })
      .catch((e: Error) => e);
    const failed = result instanceof Error || result.isError === true;
    expect(failed).toBe(true);
    expect(mockExeca).not.toHaveBeenCalled();
    expect(bus.db.getRun('run-1-1')?.state).toBe('implementing');
  });

  it('accepts a summary of exactly 5000 characters', async () => {
    addRun();
    mockRunGate.mockResolvedValue(green);
    const result = await submit('x'.repeat(5000));
    expect(JSON.parse(textOf(result))).toEqual({ status: 'gate_started' });
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

describe('submit_implementation against a real git worktree', () => {
  let bus: TestBus;
  let repo: string;
  let realExeca: typeof import('execa').execa;

  const sh = (...args: string[]) =>
    realExeca('git', ['-C', repo, ...args], {
      env: {
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  const submit = async () => {
    const client = await bus.connect('implementer');
    return client.callTool({
      name: 'submit_implementation',
      arguments: { runId: 'run-1-1', summary: 'Did it' },
    });
  };

  beforeEach(async () => {
    realExeca = (await vi.importActual<typeof import('execa')>('execa')).execa;
    mockExeca.mockReset();
    mockExeca.mockImplementation(realExeca);
    mockRunGate.mockReset();
    mockRunGate.mockResolvedValue(green);
    repo = mkdtempSync(join(tmpdir(), 'submit-git-'));
    await sh('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a');
    await sh('add', 'a.txt');
    await sh('commit', '-q', '-m', 'base');
    // Stand-in for a fetched remote: origin/main points at the base commit.
    await sh('update-ref', 'refs/remotes/origin/main', 'HEAD');
    bus = await startTestBus();
    bus.db.insertRun({
      id: 'run-1-1',
      repo: 'o/r',
      repoPath: repo,
      issueNumber: 1,
      issueTitle: 'Title',
      baseBranch: 'main',
      branch: 'main',
      worktreePath: repo,
      state: 'implementing',
      round: 1,
    });
  });
  afterEach(async () => {
    await Promise.all([...pendingGates.values()]);
    await bus.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('rejects a branch with no commits ahead of origin/<base>', async () => {
    const result = await submit();
    expect(textOf(result)).toBe('no commits ahead of origin/main: commit your work first');
    expect(bus.db.getRun('run-1-1')?.state).toBe('implementing');
  });

  it('reports a failing git call for a directory that is not a repository', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'submit-nogit-'));
    bus.db.insertRun({
      id: 'run-2-1',
      repo: 'o/r',
      repoPath: notARepo,
      issueNumber: 2,
      issueTitle: 'Other',
      baseBranch: 'main',
      branch: 'main',
      worktreePath: notARepo,
      state: 'implementing',
      round: 1,
    });
    const client = await bus.connect('implementer');
    const result = await client.callTool({
      name: 'submit_implementation',
      arguments: { runId: 'run-2-1', summary: 'x' },
    });
    rmSync(notARepo, { recursive: true, force: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^could not inspect the worktree: .*not a git repository/s);
    expect(bus.db.getRun('run-2-1')?.state).toBe('implementing');
  });

  it('rejects uncommitted changes', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b');
    const result = await submit();
    expect(textOf(result)).toBe('uncommitted changes in the worktree: commit everything first');
  });

  it('starts the gate for a clean worktree with commits ahead', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b');
    await sh('add', 'b.txt');
    await sh('commit', '-q', '-m', 'work');
    const result = await submit();
    expect(JSON.parse(textOf(result))).toEqual({ status: 'gate_started' });
    await Promise.all([...pendingGates.values()]);
    expect(bus.db.getRun('run-1-1')?.state).toBe('reviewing');
  });
});
