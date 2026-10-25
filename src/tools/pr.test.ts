import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPrBody } from '../pr-body.js';
import type { GateResult, Review } from '../schemas.js';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';

const mockExeca = vi.hoisted(() => vi.fn());
const mockAfter = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('execa', () => ({ execa: mockExeca }));
vi.mock('../run-lease.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../run-lease.js')>()),
  afterRunTransition: mockAfter,
}));

const gate: GateResult = {
  passed: true,
  steps: [{ name: 'test', command: 'pnpm test', exitCode: 0, durationMs: 1500, outputTail: '' }],
};
const review: Review = { verdict: 'approve', summary: 'Looks good', findings: [] };
const PR_URL = 'https://github.com/o/r/pull/9';

describe('open_pr', () => {
  let bus: TestBus;

  const addRun = (state: 'approved' | 'reviewing' = 'approved') =>
    bus.db.insertRun({
      id: 'run-1-1',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 1,
      issueTitle: 'Title',
      baseBranch: 'main',
      branch: 'feat/1-title',
      worktreePath: '/wt',
      state,
      round: 2,
    });
  const call = async (
    args: Record<string, unknown> = {},
    role: 'orchestrator' | 'reviewer' = 'orchestrator',
  ) => {
    const client = await bus.connect(role);
    return client.callTool({ name: 'open_pr', arguments: { runId: 'run-1-1', ...args } });
  };
  const allArgs = () => mockExeca.mock.calls.flatMap((c) => c[1] as string[]);

  beforeEach(async () => {
    mockExeca.mockReset();
    mockAfter.mockClear();
    mockExeca.mockImplementation(async (cmd: string) => ({
      stdout: cmd === 'gh' ? `Creating pull request\n${PR_URL}\n` : '',
    }));
    bus = await startTestBus();
  });
  afterEach(async () => {
    expect(allArgs().some((a) => a.includes('merge'))).toBe(false);
    await bus.close();
  });

  it('pushes, opens the PR, stores the url and notifies the orchestrator', async () => {
    addRun();
    bus.db.updateRun('run-1-1', { lastSummary: 'Did it', lastGate: gate, lastReview: review });
    const result = await call();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ prUrl: PR_URL });
    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-C', '/wt', 'push', '-u', 'origin', '--', 'feat/1-title'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    const run = bus.db.getRun('run-1-1');
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'gh',
      [
        'pr',
        'create',
        '-R',
        'o/r',
        '--base',
        'main',
        '--head',
        'feat/1-title',
        '--title',
        'Title (#1)',
        '--body-file',
        '-',
      ],
      expect.objectContaining({
        input: buildPrBody(run as NonNullable<typeof run>),
        timeout: expect.any(Number),
      }),
    );
    const input = mockExeca.mock.calls[1]?.[2].input as string;
    expect(input).toContain('Closes #1');
    expect(input).toContain('Did it');
    expect(run).toMatchObject({ state: 'pr_opened', prUrl: PR_URL });
    expect(mockAfter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: 'pr_opened', worktreePath: '/wt' }),
    );
    const [msg] = bus.db.listUnacked('orchestrator');
    expect(msg?.type).toBe('notice');
    expect(msg?.payload).toEqual({ runId: 'run-1-1', event: 'pr_opened', prUrl: PR_URL });
  });

  it('adds --draft only when draft is true', async () => {
    addRun();
    await call({ draft: true });
    expect(mockExeca.mock.calls[1]?.[1]).toContain('--draft');
  });

  it.each(['pr_opened', 'blocked', 'implementing', 'gating', 'reviewing'] as const)(
    'rejects a run in state %s without running anything',
    async (state) => {
      addRun('approved');
      bus.db.updateRun('run-1-1', { state });
      const result = await call();
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(`run run-1-1 is ${state}; open_pr requires approved`);
      expect(mockExeca).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown run', async () => {
    const result = await call();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('unknown run: run-1-1');
  });

  it('rejects non-orchestrator roles', async () => {
    addRun();
    const result = await call({}, 'reviewer').catch((e: unknown) => e);
    expect(String(result instanceof Error ? result.message : textOf(result))).toContain(
      'not allowed',
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(bus.db.getRun('run-1-1')?.state).toBe('approved');
  });

  it.each(['git', 'gh'])('leaves the run approved when %s fails', async (failing) => {
    addRun();
    mockExeca.mockImplementation(async (cmd: string) => {
      if (cmd === failing) {
        throw Object.assign(new Error(`Command failed: ${cmd} secret-arg`), {
          stderr: `${failing} boom https://user:tok@github.com/o/r\nsecond`,
        });
      }
      return { stdout: PR_URL };
    });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`${failing} boom https://***@github.com/o/r`);
    expect(textOf(result)).not.toMatch(/tok|secret-arg|second/);
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'approved', prUrl: null });
    expect(bus.db.listUnacked('orchestrator')).toEqual([]);
  });

  it('returns the gh error when a PR already exists', async () => {
    addRun();
    mockExeca.mockImplementation(async (cmd: string) => {
      if (cmd === 'gh')
        throw Object.assign(new Error('x'), { stderr: 'a pull request for branch already exists' });
      return { stdout: '' };
    });
    const result = await call();
    expect(textOf(result)).toContain('already exists');
  });

  it('rejects a concurrent call for the same run', async () => {
    addRun();
    let release: () => void = () => undefined;
    const gateOpen = new Promise<void>((r) => {
      release = r;
    });
    mockExeca.mockImplementation(async (cmd: string) => {
      if (cmd === 'git') await gateOpen;
      return { stdout: PR_URL };
    });
    const first = call();
    await vi.waitFor(() => expect(mockExeca).toHaveBeenCalledTimes(1));
    const second = await call();
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('already in progress');
    expect(mockExeca).toHaveBeenCalledTimes(1);
    release();
    expect((await first).isError).toBeFalsy();
    const cmds = mockExeca.mock.calls.map(
      (c) => `${c[0]} ${(c[1] as string[]).slice(0, 2).join(' ')}`,
    );
    expect(cmds.filter((c) => c.startsWith('gh pr'))).toHaveLength(1);
    expect(mockExeca.mock.calls.filter((c) => (c[1] as string[]).includes('push'))).toHaveLength(1);
    expect(bus.db.getRun('run-1-1')?.state).toBe('pr_opened');
  });

  it('errors when the run left approved during the awaits', async () => {
    addRun();
    mockExeca.mockImplementation(async (cmd: string) => {
      if (cmd === 'gh') bus.db.updateRun('run-1-1', { state: 'blocked' });
      return { stdout: PR_URL };
    });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'blocked', prUrl: null });
  });

  it('maps a timeout to a short error and leaves the run approved', async () => {
    addRun();
    mockExeca.mockRejectedValue(Object.assign(new Error('Command timed out'), { timedOut: true }));
    const result = await call();
    expect(textOf(result)).toBe('git push timed out');
    expect(bus.db.getRun('run-1-1')?.state).toBe('approved');
  });

  it.each([
    ['empty output', ''],
    ['non-url text', 'done'],
    ['http url', 'http://github.com/o/r/pull/9'],
    ['url with trailing text', 'https://github.com/o/r/pull/9 created'],
  ])('rejects gh output without an https url: %s', async (_n, out) => {
    addRun();
    mockExeca.mockImplementation(async (cmd: string) => ({ stdout: cmd === 'gh' ? out : '' }));
    const result = await call();
    expect(result.isError).toBe(true);
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'approved', prUrl: null });
  });

  it('surfaces the created PR url when the run left approved meanwhile', async () => {
    addRun();
    mockExeca.mockImplementation(async (cmd: string) => {
      if (cmd === 'gh') bus.db.updateRun('run-1-1', { state: 'blocked' });
      return { stdout: PR_URL };
    });
    const result = await call();
    expect(textOf(result)).toContain(PR_URL);
    expect(bus.readLog()).toContain(PR_URL);
  });

  it('returns the created PR url when recording it fails', async () => {
    addRun();
    const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementation(() => {
      throw new Error('db down');
    });
    const result = await call();
    spy.mockRestore();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(PR_URL);
    expect(textOf(result)).toContain('db down');
    expect(bus.db.getRun('run-1-1')).toMatchObject({ state: 'approved', prUrl: null });
  });
});
