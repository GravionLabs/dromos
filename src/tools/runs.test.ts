import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestBus, type TestBus, textOf } from '../test-helpers.js';

vi.mock('execa');
const mockExeca = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

describe('start_run', () => {
  let bus: TestBus;
  let root: string;
  let repoPath: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'start-run-'));
    repoPath = join(root, 'repo');
    mockExeca.mockReset();
    mockExeca.mockImplementation(async (cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: repoPath };
      if (cmd === 'gh' && args[0] === 'repo') return { stdout: 'o/r\n' };
      if (cmd === 'gh' && args[0] === 'issue') {
        return {
          stdout: JSON.stringify({ number: 14, title: 'Add Start Run!', body: 'Body', labels: [] }),
        };
      }
      if (args.includes('rev-parse')) return { exitCode: 1 };
      return { stdout: '' };
    });
    bus = await startTestBus();
  });

  afterEach(async () => {
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

  it('creates the worktree, stores the run and delivers the task', async () => {
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    const worktreePath = join(root, 'wt-repo-14');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      runId: 'run-14-1',
      branch: 'agent/14-add-start-run',
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
      'agent/14-add-start-run',
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
          branch: 'agent/14-add-start-run',
          baseBranch: 'main',
        },
      },
    ]);
    expect(bus.readLog()).toContain('orchestrator -> implementer [task] run-14-1');
    expect(bus.readLog()).toContain(
      'run-14-1 started: implementing (round 1) on agent/14-add-start-run',
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

  it('returns a readable error when the worktree path exists and removes nothing', async () => {
    mkdirSync(join(root, 'wt-repo-14'));
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('worktree path already exists');
    expect(bus.db.listRuns()).toEqual([]);
    expect(bus.db.listUnacked('implementer')).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  it('rejects a duplicate active run before any git call', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({ name: 'start_run', arguments: args() });
    mockExeca.mockClear();
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('already has an active run');
    expect(textOf(result)).toContain('run-14-1');
    expect(mockExeca).not.toHaveBeenCalled();
    expect(bus.db.listRuns()).toHaveLength(1);
  });

  it('allows a new run when the previous run is terminal', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({ name: 'start_run', arguments: args() });
    bus.db.updateRun('run-14-1', { state: 'pr_opened' });
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
    const result = await orchestrator.callTool({
      name: 'start_run',
      arguments: { repoPath: other, issue: 14 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).worktreePath).toBe(join(root, 'wt-other-14'));
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
      if (a.includes('--show-toplevel')) return { stdout: repoPath };
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
    expect(textOf(result)).toContain('branch already exists: agent/14-add-start-run');
    expect(bus.db.listRuns()).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  it('leaves no run or message when viewIssue fails', async () => {
    mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
      if (a.includes('--show-toplevel')) return { stdout: repoPath };
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

  it('leaves no run or message and names manual cleanup when worktree add fails', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementation(async (cmd: string, a: string[]) => {
      if (a.includes('worktree')) throw new Error('fatal: add failed');
      return base(cmd, a);
    });
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('add failed');
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
    expect(textOf(result)).toContain('agent/14-add-start-run');
    expect(textOf(result)).toContain(join(root, 'wt-repo-14'));
    expect(textOf(result)).toContain('clean them up manually');
    expect(bus.db.listRuns()).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  it('falls back to agent/<issue> when the title has no slug characters', async () => {
    const base = mockExeca.getMockImplementation() as (c: string, a: string[]) => Promise<unknown>;
    mockExeca.mockImplementation(async (cmd: string, a: string[]) =>
      cmd === 'gh' && a[0] === 'issue'
        ? { stdout: JSON.stringify({ number: 14, title: '***', body: '' }) }
        : base(cmd, a),
    );
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(JSON.parse(textOf(result)).branch).toBe('agent/14');
  });
});
