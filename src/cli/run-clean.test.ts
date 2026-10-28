import { describe, expect, it } from 'vitest';
import { runRunCli } from './run.js';

describe('dromos run clean', () => {
  const ops = {
    git: async (args: string[]) => ({
      exitCode: 0,
      stdout:
        args[0] === 'worktree' && args[1] === 'list'
          ? 'worktree /r/.worktrees/5\nHEAD a\nbranch refs/heads/feat/5-x\n'
          : '',
    }),
    issueState: async () => 'CLOSED',
    prs: async () => [],
  };
  const run = async (args: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runRunCli(['clean', ...args], {
      out: (t) => stdout.push(t),
      err: (l) => stderr.push(l),
      clean: { ops },
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('\n') };
  };

  it('lists what a dry run would remove', async () => {
    const res = await run(['5', '--dry-run', '--repo', '/r']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('would remove .worktrees/5\nwould remove branch feat/5-x\n');
  });

  it('removes what finished', async () => {
    const res = await run(['--repo', '/r']);
    expect(res.stdout).toBe('removed .worktrees/5\nremoved branch feat/5-x\n');
  });

  it('rejects a bad number and extra arguments', async () => {
    expect((await run(['x'])).code).toBe(2);
    expect((await run(['1', '2'])).code).toBe(2);
  });
});
