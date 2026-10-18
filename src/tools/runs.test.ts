import { mkdtempSync, rmSync } from 'node:fs';
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
    expect(mockExeca).toHaveBeenCalledWith('git', [
      '-C',
      repoPath,
      'worktree',
      'add',
      '-b',
      'agent/14-add-start-run',
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
  });

  it('uses an explicit baseBranch', async () => {
    const orchestrator = await bus.connect('orchestrator');
    await orchestrator.callTool({
      name: 'start_run',
      arguments: { ...args(), baseBranch: 'develop' },
    });
    expect(mockExeca).toHaveBeenCalledWith('git', ['-C', repoPath, 'fetch', 'origin', 'develop']);
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
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'wt-repo-14'));
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('worktree path already exists');
    expect(bus.db.listRuns()).toEqual([]);
    expect(bus.db.listUnacked('implementer')).toEqual([]);
    expect(mockExeca.mock.calls.some(([, a]) => (a as string[]).includes('remove'))).toBe(false);
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
    mockExeca.mockRejectedValueOnce(new Error('gh: not authenticated'));
    const orchestrator = await bus.connect('orchestrator');
    const result = await orchestrator.callTool({ name: 'start_run', arguments: args() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('gh: not authenticated');
    expect(bus.db.listRuns()).toEqual([]);
  });
});
