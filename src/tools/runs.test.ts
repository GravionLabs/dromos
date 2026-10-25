import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leaseKey, stamp } from '../lease.js';
import { afterRunTransition } from '../run-lease.js';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';

vi.mock('execa');
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

describe('start_run', () => {
  // Mimics git: any path inside repoPath resolves to the repo root.
  const toplevelOf = (a: string[]): string => {
    const p = a[a.indexOf('-C') + 1] ?? '';
    return p === repoPath || p.startsWith(`${repoPath}/`) ? repoPath : p;
  };
  let bus: TestBus;
  let root: string;
  let repoPath: string;
  let stateDir: string;
  const leaseOf = (path: string) => join(stateDir, 'leases', `${leaseKey(path)}.json`);
  const seedLease = (path: string, issue: number, heartbeat: string) => {
    mkdirSync(join(stateDir, 'leases'), { recursive: true });
    writeFileSync(
      leaseOf(path),
      `${JSON.stringify({ path, issue, branch: 'b', host: 'h', started: heartbeat, heartbeat })}\n`,
    );
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'start-run-'));
    repoPath = join(root, 'repo');
    stateDir = join(root, 'state');
    vi.stubEnv('DROMOS_STATE_DIR', stateDir);
    mockExeca.mockReset();
    mockExeca.mockImplementation(async (cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: `${toplevelOf(args)}\n` };
      if (cmd === 'gh' && args[0] === 'repo') return { stdout: 'o/r\n' };
      if (cmd === 'gh' && args[0] === 'issue') {
        return {
          stdout: JSON.stringify({ number: 14, title: 'Add Start Run!', body: 'Body', labels: [] }),
        };
      }
      if (args.includes('check-ignore')) return { exitCode: 0 };
      if (args.includes('rev-parse')) return { exitCode: 1 };
      return { stdout: '' };
    });
    bus = await startTestBus();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await bus.close();
    rmSync(root, { recursive: true, force: true });
  });

  const args = () => ({ repoPath, issue: 14 });
  const destructive = () =>
    mockExeca.mock.calls.filter(([cmd, a]) => {
      const list = (a as string[]) ?? [];
      return (
        cmd === 'rm' ||
        list.some((x) => ['remove', 'prune', '-D', '-d', 'rm', 'clean'].includes(x)) ||
        list.includes('--force')
      );
    });

  it('sets the agent run_id on the first start_run and keeps it on later ones', async () => {
    const orchestrator = await bus.connect('orchestrator', 'orch-1');
    expect(bus.db.getAgent('orch-1')?.runId).toBeNull();
    await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(bus.db.getAgent('orch-1')?.runId).toBe('run-14-1');
    await orchestrator.callTool({ name: 'start_run', arguments: { repoPath, issue: 15 } });
    expect(bus.db.getRun('run-15-1')).toBeDefined();
    expect(bus.db.getAgent('orch-1')?.runId).toBe('run-14-1');
  });

  it('leaves the agent run_id unset when start_run fails', async () => {
    mockExeca.mockImplementation(async () => {
      throw new Error('boom');
    });
    const orchestrator = await bus.connect('orchestrator', 'orch-2');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(bus.db.getAgent('orch-2')?.runId).toBeNull();
  });

  it('creates the worktree, stores the run and delivers the task', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    const worktreePath = join(repoPath, '.worktrees', '14');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      runId: 'run-14-1',
      branch: 'feat/14-add-start-run',
      worktreePath,
    });
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd: repoPath },
    );
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'issue',
      'view',
      '14',
      '-R',
      'o/r',
      '--json',
      'number,title,body,labels',
    ]);
    expect(mockExeca).toHaveBeenCalledWith('git', [
      '-C',
      repoPath,
      'worktree',
      'add',
      '-b',
      'feat/14-add-start-run',
      '--',
      worktreePath,
      'origin/main',
    ]);
    expect(bus.db.getRun('run-14-1')).toMatchObject({
      repo: 'o/r',
      repoPath,
      issueNumber: 14,
      issueTitle: 'Add Start Run!',
      baseBranch: 'main',
      state: 'implementing',
      round: 1,
    });
    expect(bus.db.listUnacked('implementer')).toMatchObject([
      {
        from: 'orchestrator',
        type: 'task',
        runId: 'run-14-1',
        payload: {
          runId: 'run-14-1',
          issue: { number: 14, title: 'Add Start Run!', body: 'Body' },
          worktreePath,
          branch: 'feat/14-add-start-run',
          baseBranch: 'main',
        },
      },
    ]);
    expect(bus.readLog()).toContain('orchestrator -> implementer [task] run-14-1');
    expect(bus.readLog()).toContain(
      'run-14-1 started: implementing (round 1) on feat/14-add-start-run',
    );
  });

  it('uses an explicit baseBranch', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({
      name: 'start_run',
      arguments: { ...args(), baseBranch: 'develop' },
    });
    expect(mockExeca).toHaveBeenCalledWith('git', [
      '-C',
      repoPath,
      'fetch',
      '--',
      'origin',
      'develop',
    ]);
    expect(bus.db.getRun('run-14-1')?.baseBranch).toBe('develop');
  });

  it.each(['implementer', 'reviewer'] as const)('rejects role %s', async (role) => {
    const client = await bus.connect(role);
    const result = await client
      .callTool({ name: 'start_run', arguments: args() })
      .catch((e: Error) => e);
    const message = result instanceof Error ? result.message : textOf(result);
    expect(message).toContain(
      `tool start_run is not allowed for role ${role} (allowed: orchestrator)`,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(bus.db.listRuns()).toEqual([]);
  });

  it('rejects a relative repoPath', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator
      .callTool({ name: 'start_run', arguments: { repoPath: 'repo', issue: 14 } })
      .catch((e: Error) => e);
    const message = result instanceof Error ? result.message : textOf(result);
    expect(message).toContain('absolute');
    expect(bus.db.listRuns()).toEqual([]);
  });

  it('refuses when the worktree dir is not git-ignored and creates nothing', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementation(async (cmd: string, a: string[]) =>
      a.includes('check-ignore') ? { exitCode: 1 } : base(cmd, a),
    );
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("worktree directory '.worktrees' is not git-ignored");
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['-C', repoPath, 'check-ignore', '-q', '--', '.worktrees/probe'],
      { reject: false },
    );
    const calledWith = (word: string) =>
      mockExeca.mock.calls.some(([, a]) => (a as string[]).includes(word));
    expect(calledWith('fetch')).toBe(false);
    expect(calledWith('worktree')).toBe(false);
    expect(mockExeca.mock.calls.some(([cmd]) => cmd === 'gh')).toBe(false);
    expect(existsSync(join(repoPath, '.worktrees'))).toBe(false);
    expect(bus.db.listRuns()).toEqual([]);
  });

  it('honours a custom worktreeDir with exact worktree add args', async () => {
    await bus.close();
    bus = await startTestBus({ worktreeDir: 'work/trees' });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    const worktreePath = join(repoPath, 'work', 'trees', '14');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).worktreePath).toBe(worktreePath);
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['-C', repoPath, 'check-ignore', '-q', '--', 'work/trees/probe'],
      { reject: false },
    );
    expect(mockExeca).toHaveBeenCalledWith('git', [
      '-C',
      repoPath,
      'worktree',
      'add',
      '-b',
      'feat/14-add-start-run',
      '--',
      worktreePath,
      'origin/main',
    ]);
  });

  it('refuses a worktreeDir symlinked outside the repository', async () => {
    mkdirSync(repoPath, { recursive: true });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(repoPath, '.worktrees'));
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('resolves outside the repository');
    expect(mockExeca.mock.calls.some(([, a]) => (a as string[]).includes('worktree'))).toBe(false);
    expect(bus.db.listRuns()).toEqual([]);
  });

  it('leaves no worktree dir behind when the branch already exists', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementation(async (cmd: string, a: string[]) =>
      a.includes('rev-parse') && !a.includes('--show-toplevel') ? { exitCode: 0 } : base(cmd, a),
    );
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(existsSync(join(repoPath, '.worktrees'))).toBe(false);
  });

  it('returns a readable error when the worktree path exists and removes nothing', async () => {
    mkdirSync(join(repoPath, '.worktrees', '14'), { recursive: true });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('worktree path already exists');
    expect(bus.db.listRuns()).toEqual([]);
    expect(bus.db.listUnacked('implementer')).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  it('rejects a duplicate active run before any gh or worktree call', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({ name: 'start_run', arguments: args() });
    mockExeca.mockClear();
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('already has an active run');
    expect(textOf(result)).toContain('run-14-1');
    expect(mockExeca.mock.calls.filter(([cmd]) => cmd === 'gh')).toEqual([]);
    expect(mockExeca.mock.calls.some(([, a]) => (a as string[]).includes('worktree'))).toBe(false);
    expect(bus.db.listRuns()).toHaveLength(1);
  });

  it('allows a new run when the previous run is terminal', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({ name: 'start_run', arguments: args() });
    bus.db.updateRun('run-14-1', { state: 'pr_opened' });
    // no pr_opened writer exists yet: run the shared transition hook the writers use
    await afterRunTransition(
      { log: { logLine: () => undefined } },
      {
        repoPath,
        worktreePath: join(repoPath, '.worktrees', '14'),
        issueNumber: 14,
        state: 'pr_opened',
      },
    );
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).runId).toBe('run-14-2');
  });

  it('surfaces helper failures as readable errors', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
      if (cmd === 'gh') throw new Error('gh: not authenticated');
      return base(cmd, a);
    });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('gh: not authenticated');
    expect(bus.db.listRuns()).toEqual([]);
  });

  it.each(['--upload-pack=touch /tmp/pwned', '-x', 'a..b', 'main\nINJECT'])(
    'rejects unsafe baseBranch %j before any command runs',
    async (baseBranch) => {
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator
        .callTool({ name: 'start_run', arguments: { ...args(), baseBranch } })
        .catch((e: Error) => e);
      const message = result instanceof Error ? result.message : textOf(result);
      expect(message).toContain('baseBranch');
      expect(mockExeca).not.toHaveBeenCalled();
      expect(bus.db.listRuns()).toEqual([]);
    },
  );

  it('rejects a repoPath with .. segments', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator
      .callTool({ name: 'start_run', arguments: { repoPath: `${root}/a/..`, issue: 14 } })
      .catch((e: Error) => e);
    const message = result instanceof Error ? result.message : textOf(result);
    expect(message).toContain('..');
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('rejects a path that is not a git repository', async () => {
    mockExeca.mockImplementation(async (_cmd: string, a: string[]) => {
      if (a.includes('--show-toplevel')) throw new Error('fatal: not a git repository');
      return { stdout: '' };
    });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`not a git repository: ${repoPath}`);
    expect(bus.db.listRuns()).toEqual([]);
  });

  it('rejects a duplicate for another non-terminal state', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({ name: 'start_run', arguments: args() });
    bus.db.updateRun('run-14-1', { state: 'reviewing' });
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('run-14-1 (reviewing)');
  });

  it('allows the same issue number in a different repoPath', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({ name: 'start_run', arguments: args() });
    const other = join(root, 'other');
    vi.stubEnv('DROMOS_STATE_DIR', join(root, 'state-other')); // leases are per repository
    const result = await orchestrator.callTool({
      name: 'start_run',
      arguments: { repoPath: other, issue: 14 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).worktreePath).toBe(join(root, 'other', '.worktrees', '14'));
  });

  it('guards concurrent starts for the same repo and issue', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const [a, b] = await Promise.all([
      orchestrator.callTool({ name: 'start_run', arguments: args() }),
      orchestrator.callTool({ name: 'start_run', arguments: args() }),
    ]);
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    expect(bus.db.listRuns()).toHaveLength(1);
  });

  it('reports a branch that already exists', async () => {
    mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
      if (a.includes('check-ignore')) return { exitCode: 0 };
      if (a.includes('--show-toplevel')) return { stdout: `${toplevelOf(a)}\n` };
      if (cmd === 'gh' && a[0] === 'repo') return { stdout: 'o/r' };
      if (cmd === 'gh') {
        return { stdout: JSON.stringify({ number: 14, title: 'Add Start Run!', body: '' }) };
      }
      if (a.includes('rev-parse')) return { exitCode: 0 };
      return { stdout: '' };
    });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('branch already exists: feat/14-add-start-run');
    expect(bus.db.listRuns()).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  it('leaves no run or message when viewIssue fails', async () => {
    mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
      if (a.includes('check-ignore')) return { exitCode: 0 };
      if (a.includes('--show-toplevel')) return { stdout: `${toplevelOf(a)}\n` };
      if (cmd === 'gh' && a[0] === 'repo') return { stdout: 'o/r' };
      if (cmd === 'gh') return { stdout: 'garbage' };
      return { stdout: '' };
    });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('malformed JSON');
    expect(bus.db.listRuns()).toEqual([]);
    expect(bus.db.listUnacked('implementer')).toEqual([]);
  });

  it('leaves no run or message when worktree add fails', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
      if (a.includes('worktree')) throw new Error('fatal: add failed');
      return base(cmd, a);
    });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('add failed');
    expect(textOf(result)).not.toContain('clean them up manually');
    expect(bus.db.listRuns()).toEqual([]);
    expect(bus.db.listUnacked('implementer')).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  it('rolls back the run and reports manual cleanup when the DB write fails', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    spy.mockRestore();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('disk full');
    expect(textOf(result)).toContain('feat/14-add-start-run');
    expect(textOf(result)).toContain(join(repoPath, '.worktrees', '14'));
    expect(textOf(result)).toContain('clean them up manually');
    expect(bus.db.listRuns()).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  describe('branch type', () => {
    const withIssue = (title: string, labels: string[]) => {
      const base = mockExeca.getMockImplementation() as (
        c: string,
        a: string[],
      ) => Promise<unknown>;
      mockExeca.mockImplementation(async (cmd: string, a: string[]) =>
        cmd === 'gh' && a[0] === 'issue'
          ? {
              stdout: JSON.stringify({
                number: 14,
                title,
                body: '',
                labels: labels.map((name) => ({ name })),
              }),
            }
          : base(cmd, a),
      );
    };
    const branchFor = async (): Promise<string> => {
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      expect(result.isError).toBeFalsy();
      return JSON.parse(textOf(result)).branch;
    };
    // Branch convention enforced by the apm-hub ledger hook.
    const conventional = /^(feat|fix)\/\d+-[a-z0-9-]+$/;

    it('uses fix for a bug label (case-insensitive)', async () => {
      withIssue('Crash on start', ['Bug']);
      expect(await branchFor()).toBe('fix/14-crash-on-start');
    });

    it.each([
      'Fix crash on start',
      '[Bug] crash on start',
      'Fixes crash',
      'Fixed crash',
      'FIX: crash',
    ])('uses fix for title %j', async (title) => {
      withIssue(title, []);
      const branch = await branchFor();
      expect(branch).toMatch(/^fix\/14-/);
      expect(branch).toMatch(conventional);
    });

    it.each([
      ['Fixture loader', 'feat/14-fixture-loader'],
      ['Fixing things', 'feat/14-fixing-things'],
      ['Add fix command', 'feat/14-add-fix-command'],
      ['Prefix [bug] handling', 'feat/14-prefix-bug-handling'],
    ])('keeps feat for title %j', async (title, expected) => {
      withIssue(title, ['enhancement']);
      expect(await branchFor()).toBe(expected);
    });

    it('uses fix/<issue> when a bug title has no slug characters', async () => {
      withIssue('***', ['bug']);
      expect(await branchFor()).toBe('fix/14');
    });

    it('uses <prefix>/<issue> for a fixed prefix when the title has no slug characters', async () => {
      await bus.close();
      bus = await startTestBus({ branchPrefix: 'agent' });
      withIssue('***', []);
      expect(await branchFor()).toBe('agent/14');
    });

    it('defaults to feat and matches the ledger hook regex', async () => {
      expect(await branchFor()).toMatch(conventional);
    });

    it('uses a fixed branchPrefix with exact worktree add args', async () => {
      await bus.close();
      bus = await startTestBus({ branchPrefix: 'agent' });
      withIssue('Fix crash', ['bug']);
      expect(await branchFor()).toBe('agent/14-fix-crash');
      expect(mockExeca).toHaveBeenCalledWith('git', [
        '-C',
        repoPath,
        'worktree',
        'add',
        '-b',
        'agent/14-fix-crash',
        '--',
        join(repoPath, '.worktrees', '14'),
        'origin/main',
      ]);
    });
  });

  it('falls back to feat/<issue> when the title has no slug characters', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementation(async (cmd: string, a: string[]) =>
      cmd === 'gh' && a[0] === 'issue'
        ? { stdout: JSON.stringify({ number: 14, title: '***', body: '' }) }
        : base(cmd, a),
    );
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(JSON.parse(textOf(result)).branch).toBe('feat/14');
  });

  it('uses the git toplevel for a subdirectory repoPath and dedupes against the root', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({
      name: 'start_run',
      arguments: { repoPath: join(repoPath, 'src', 'deep'), issue: 14 },
    });
    expect(JSON.parse(textOf(result)).worktreePath).toBe(join(repoPath, '.worktrees', '14'));
    expect(bus.db.getRun('run-14-1')?.repoPath).toBe(repoPath);
    const dup = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(dup.isError).toBe(true);
    expect(textOf(dup)).toContain('already has an active run');
  });

  it('normalizes a trailing slash in repoPath', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({
      name: 'start_run',
      arguments: { repoPath: `${repoPath}/`, issue: 14 },
    });
    expect(result.isError).toBeFalsy();
    expect(bus.db.getRun('run-14-1')?.repoPath).toBe(repoPath);
  });

  it('releases the in-flight guard after a failed start so a retry succeeds', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementationOnce(base).mockImplementationOnce(async () => {
      throw new Error('gh down');
    });
    const orchestrator = await bus.connect('orchestrator');
    const first = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(first.isError).toBe(true);
    const retry = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(retry.isError).toBeFalsy();
  });

  it('mentions the in-progress start for a concurrent duplicate', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
      if (cmd === 'gh' && a[0] === 'issue') await gate;
      return base(cmd, a);
    });
    const orchestrator = await bus.connect('orchestrator');
    const first = orchestrator.callTool({ name: 'start_run', arguments: args() });
    await vi.waitFor(() =>
      expect(
        mockExeca.mock.calls.some(([c, a]) => c === 'gh' && (a as string[])[0] === 'issue'),
      ).toBe(true),
    );
    const second = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    release();
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('start in progress');
    expect((await first).isError).toBeFalsy();
  });

  it('still succeeds when logging fails after the run is committed', async () => {
    bus.events.onMessageFor('implementer', () => {
      throw new Error('listener boom');
    });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain('clean them up');
    expect(bus.db.listRuns()).toHaveLength(1);
  });

  describe('checkout lease', () => {
    const wt = () => join(repoPath, '.worktrees', '14');
    const noWorktreeAdd = () =>
      mockExeca.mock.calls.every(([, a]) => !((a as string[]) ?? []).includes('worktree'));

    it('writes an apm-hub lease for the worktree on a successful start', async () => {
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      expect(result.isError).toBeFalsy();
      const lease = JSON.parse(readFileSync(leaseOf(wt()), 'utf8'));
      expect(lease).toMatchObject({
        path: wt(),
        issue: 14,
        branch: 'feat/14-add-start-run',
        owner: 'dromos',
      });
      expect(lease.heartbeat).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(lease.started).toBe(lease.heartbeat);
      expect(typeof lease.host).toBe('string');
    });

    it('refuses a foreign live lease on the same path before any git change', async () => {
      seedLease(wt(), 99, stamp());
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('nothing was created');
      expect(textOf(result)).toContain('#99');
      expect(noWorktreeAdd()).toBe(true);
      expect(bus.db.listRuns()).toEqual([]);
      expect(bus.db.listUnacked('implementer')).toEqual([]);
    });

    it('refuses a live lease of the same issue on another path', async () => {
      const other = join(root, 'elsewhere', '.worktrees', '14');
      seedLease(other, 14, stamp());
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(other);
      expect(noWorktreeAdd()).toBe(true);
      expect(existsSync(leaseOf(wt()))).toBe(false);
      expect(bus.db.listRuns()).toEqual([]);
    });

    it('takes over a stale lease on the same path', async () => {
      seedLease(wt(), 99, '2020-01-01T00:00:00Z');
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(readFileSync(leaseOf(wt()), 'utf8')).issue).toBe(14);
    });

    it('reports a non-conflict claim error and creates nothing', async () => {
      const blocker = join(root, 'state-is-a-file');
      writeFileSync(blocker, '');
      vi.stubEnv('DROMOS_STATE_DIR', blocker);
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('start_run failed');
      expect(textOf(result)).not.toContain('nothing was created');
      expect(noWorktreeAdd()).toBe(true);
      expect(bus.db.listRuns()).toEqual([]);
      expect(bus.db.listUnacked('implementer')).toEqual([]);
    });

    it('removes the lease when worktree add fails', async () => {
      const base = mockExeca.getMockImplementation() as (
        c: string,
        a: string[],
      ) => Promise<unknown>;
      mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
        if (a.includes('worktree')) throw new Error('fatal: add failed');
        return base(cmd, a);
      });
      const orchestrator = await bus.connect('orchestrator');
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      expect(result.isError).toBe(true);
      expect(existsSync(leaseOf(wt()))).toBe(false);
    });

    it('removes the lease when the DB write fails', async () => {
      const orchestrator = await bus.connect('orchestrator');
      const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementation(() => {
        throw new Error('disk full');
      });
      const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      spy.mockRestore();
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('disk full');
      expect(existsSync(leaseOf(wt()))).toBe(false);
    });

    it('logs a failing release and keeps the original start_run error', async () => {
      const orchestrator = await bus.connect('orchestrator');
      const spy = vi.spyOn(bus.db, 'insertMessage').mockImplementation(() => {
        throw new Error('disk full');
      });
      // make the release itself fail: replace the leases dir by a file after the claim
      const origInsert = bus.db.insertRun.bind(bus.db);
      const insertSpy = vi.spyOn(bus.db, 'insertRun').mockImplementation((r) => {
        rmSync(join(stateDir, 'leases'), { recursive: true, force: true });
        writeFileSync(join(stateDir, 'leases'), '');
        return origInsert(r);
      });
      let result: Awaited<ReturnType<typeof orchestrator.callTool>>;
      try {
        result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
      } finally {
        spy.mockRestore();
        insertSpy.mockRestore();
      }
      expect(textOf(result)).toContain('start_run failed: disk full');
      expect(bus.readLog()).toContain('lease release failed');
    });
  });
});
