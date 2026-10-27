import { describe, expect, it } from 'vitest';
import { ALLOWED_COMMANDS, createPermissions } from './permissions.js';

// Cases ported from apm-hub test/packages/hooks/git-guardrails.test.ts (v2.5.4). The commands are
// written for the guardrails, so the allowlist is widened to everything they start with.
const WIDE = [
  'bash',
  'sh',
  'zsh',
  'env',
  'timeout',
  'xargs',
  'nohup',
  'nice',
  'sudo',
  'echo',
  'printf',
  'eval',
  'cd',
  'cat',
  'source',
  '.',
  'stdbuf',
  'flock',
  'su',
  'script',
  'chronic',
  'unbuffer',
  'ls',
  'head',
  'FOO=1',
  'g',
  "'git'",
  'git',
  '((',
];

function make(opts: { branch?: string | null; dirty?: boolean; allow?: string[] } = {}) {
  const p = createPermissions({
    cwd: '/repo',
    allow: opts.allow ?? WIDE,
    currentBranch: () => (opts.branch === undefined ? 'feature' : opts.branch),
    isDirty: () => opts.dirty ?? false,
    now: () => new Date('2026-10-27T10:00:00.000Z'),
  });
  return { ...p, run: (command: string) => p.allow('Bash', { command }) };
}

const blocked = [
  'git push --force origin main',
  'git push -f origin main',
  'git push --force-with-lease origin main',
  'git push --force-with-lease=main origin main',
  'git push --force origin release/2.1',
  'git push origin +main',
  'git push origin HEAD:main --force',
  'git push --delete origin release/2.1',
  'git push origin :main',
  'git push origin :release/2.1',
  'git push --delete origin release/next-x',
  'git push --delete origin release/next/x',
  'git push origin :release/next-x',
  'git push --force origin release/next',
  'git push origin +release/next',
  'git push origin +refs/heads/release/next',
  'git push -f --delete origin release/next',
  'git push origin +:release/next',
  'git push --delete origin main release/next',
  'git reset --hard',
  'git reset --hard HEAD~1',
  'git clean -f',
  'git clean -fd',
  'git branch -D old',
  'cd x && git reset --hard',
  'echo hi; git -C . reset --hard',
  'FOO=1 git reset --hard',
  'git push origin HEAD:refs/heads/main -f',
  'git push origin +refs/heads/main',
  'git push -o x -f origin main',
  'git push --repo origin -f main',
  'git branch -d -f old',
  'git branch -df old',
  'git branch -fd old',
  'git branch --delete --force old',
  'env git reset --hard',
  'env FOO=1 -i git reset --hard',
  'env -u X git reset --hard',
  "bash -c 'git reset --hard'",
  'sh -c "git clean -fd"',
  "bash -lc 'cd x && git reset --hard'",
  'zsh -c "bash -c \'git reset --hard\'"',
  'timeout 5 git reset --hard',
  'timeout -s KILL 5 git reset --hard',
  'echo x | xargs git reset --hard',
  'echo x | xargs -n 1 git branch -D',
  'nohup git reset --hard',
  'nice -n 5 git reset --hard',
  'sudo -u bob git reset --hard',
  'echo `git reset --hard`',
  'echo $(git reset --hard)',
  'echo "x $(git reset --hard)"',
  'eval "git reset --hard"',
  'bash <<EOF\ngit reset --hard\nEOF',
  'sh <<-EOF\n\tgit clean -fd\nEOF',
  'cat <<EOF\n$(git reset --hard)\nEOF',
  'cat <<EOF\n`git reset --hard`\nEOF',
  'sh <<< "git reset --hard"',
  'bash <<<"git push -f origin main"',
  '(( x<<2 ))\ngit reset --hard',
  'echo $((1<<2))\ngit reset --hard',
  "echo $'it\\'s'; git reset --hard",
  'git reset --hard>/dev/null',
  'git push -f origin main>/dev/null',
  'git reset --hard 2>&1',
  'g""it reset --hard',
  'g\\it reset --hard',
  "'git' reset --hard",
  // pipes into a shell, process substitution read by a shell
  "echo 'git reset --hard' | sh",
  'echo git reset --hard | bash -s',
  "printf 'git reset --hard\\n' | bash",
  "echo 'git reset --hard' | sh -",
  "echo 'git reset --hard' |& sh",
  "echo 'git reset --hard' |\n sh",
  'cat <<EOF | bash\ngit reset --hard\nEOF',
  "cat <<'EOF' | sh\ngit clean -fd\nEOF",
  "source <(echo 'git reset --hard')",
  '. <(echo git reset --hard)',
  'bash <(echo git reset --hard)',
  // wrappers
  'stdbuf -oL git reset --hard',
  'stdbuf -o L git reset --hard',
  'flock /tmp/l git reset --hard',
  'flock -w 5 /tmp/l git reset --hard',
  "flock /tmp/l -c 'git reset --hard'",
  "su -c 'git reset --hard' bob",
  "su bob -c 'git reset --hard'",
  "su - bob -lc 'git clean -fd'",
  "script -qc 'git reset --hard' /dev/null",
  "script --command='git reset --hard'",
  'chronic git reset --hard',
  'unbuffer -p git reset --hard',
  // git -c alias.*
  "git -c alias.x='reset --hard' x",
  "git -c alias.x='!git reset --hard' x",
  "git -c alias.nuke='push -f origin' nuke main",
  "git -c Alias.y='clean -fd' status",
  // options end at --
  'git clean -f -- -n',
  // another repository is never inspected with git: counts as dirty
  'git --git-dir=/tmp/x/.git checkout .',
  'git --work-tree=/tmp restore -- .',
  'GIT_DIR=/tmp/x git restore .',
  'env GIT_WORK_TREE=/tmp git checkout .',
  'git --git-dir=/tmp/x push -f origin HEAD',
];

const allowed = [
  'git push --force origin feature',
  'git push -f origin feat/199-x',
  'git push --force-with-lease origin feature',
  'git push origin main',
  'git push --delete origin feature',
  'git push --delete origin release/next',
  'git push origin :release/next',
  'git push origin :refs/heads/release/next',
  'git push --delete origin refs/heads/release/next',
  'git reset --soft HEAD~1',
  'git reset HEAD file',
  'git clean -n',
  'git clean -nfd',
  'git branch -d merged',
  'git status',
  'git commit -m "docs: mention git reset"',
  'ls -la',
  'cd x && git status',
  'git restore --staged .',
  'git commit -m "fix; git reset --hard"',
  "git commit -m 'a && git clean -fd'",
  'git commit -m "$(cat <<\'EOF\'\nfix: thing\n\ngit reset --hard; git push -f origin main\nEOF\n)"',
  'git log --format="%s | git reset --hard"',
  'git -C',
  'git push -o force origin feature',
  'git push -f origin HEAD',
  'git push -f origin @',
  'echo "git reset --hard"',
  'bash -c "git status"',
  'env FOO=1 git status',
  'timeout 5 git status',
  'cat <<EOF\ngit reset --hard\nEOF',
  "cat <<'EOF'\n$(git reset --hard)\nEOF",
  'bash <<EOF\ngit status\nEOF',
  'git commit -F - <<EOF\nfix: mention git reset --hard\nEOF',
  'echo $((1<<2))\ngit status',
  "echo $'it\\'s; git reset --hard'",
  'git push -f origin feature>/dev/null',
  'git status 2>&1',
  'cat <<EOF >out.txt\ngit reset --hard\nEOF',
  "cat <<'EOF' > f\ngit reset --hard\nEOF",
  'git log | head',
  "git log --oneline | sh -c 'cat'",
  "echo 'git reset --hard' | cat",
  "echo 'git reset --hard' | bash script.sh",
  "echo 'git reset --hard' || sh",
  "echo 'git push' | sh",
  'cat <<EOF | bash\ngit status\nEOF',
  'source <(echo git status)',
  'stdbuf -oL git status',
  'flock /tmp/l git status',
  "su -c 'git status'",
  'git -c alias.x=status x',
  'git -c alias.co=checkout co feature',
  'git -c core.pager=cat status',
  'git clean -n -- -f',
  'git restore ./',
  'git -C . checkout .',
  'git -C . push -f',
];

describe('git guardrails', () => {
  it.each(blocked)('denies %s', (command) => {
    const p = make();
    const d = p.run(command);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('git guardrails');
  });

  it.each(allowed)('passes %s', (command) => {
    expect(make().run(command)).toEqual({ allow: true });
  });

  it('denies a bare force push while on a protected branch', () => {
    for (const branch of ['main', 'release/2.0', 'release/next', null]) {
      const p = make({ branch });
      expect(p.run('git push --force').allow).toBe(false);
      expect(p.run('git push -f origin').allow).toBe(false);
    }
  });

  it('passes a bare force push on a feature branch', () => {
    expect(make().run('git push --force')).toEqual({ allow: true });
  });

  it('resolves HEAD to the current protected branch', () => {
    const p = make({ branch: 'release/2.0' });
    expect(p.run('git push -f origin HEAD').allow).toBe(false);
    expect(p.run('git push --force-with-lease origin HEAD').allow).toBe(false);
    expect(p.run('git push -f origin @').allow).toBe(false);
    expect(p.run('git push origin HEAD:release/2.0 --force-with-lease').allow).toBe(false);
    expect(p.run('git push origin HEAD').allow).toBe(true);
    expect(p.run('git push -f origin HEAD:feature').allow).toBe(true);
  });

  it('allows deleting HEAD on the remote only on release/next', () => {
    expect(make({ branch: 'release/next' }).run('git push --delete origin HEAD').allow).toBe(true);
    expect(make({ branch: 'release/2.1' }).run('git push --delete origin HEAD').allow).toBe(false);
    expect(make({ branch: 'main' }).run('git push --delete origin HEAD').allow).toBe(false);
  });

  it.each([
    'git checkout -- .',
    'git checkout .',
    'git restore .',
    'git restore --worktree .',
    'git checkout ./',
    'git restore -- ./',
    'git restore ..',
    'git checkout -- ./.',
    'git -c alias.co=checkout co -- ./',
  ])('denies %s only with uncommitted changes', (command) => {
    expect(make({ dirty: false }).run(command).allow).toBe(true);
    expect(make({ dirty: true }).run(command).allow).toBe(false);
  });

  it('allows restore --staged . even when dirty', () => {
    expect(make({ dirty: true }).run('git restore --staged .').allow).toBe(true);
  });

  it('treats a directory change before checkout . as possibly dirty', () => {
    expect(make().run('cd other && git checkout -- .').allow).toBe(false);
  });

  it('treats git -C into another repository as unknown', () => {
    const p = make();
    expect(p.run('git -C /elsewhere checkout .').allow).toBe(false);
    expect(p.run('git -C /elsewhere push -f').allow).toBe(false);
  });

  it('denies nesting beyond 24 levels', () => {
    let cmd = 'git status';
    for (let i = 0; i < 26; i++) cmd = `echo $(${cmd})`;
    expect(make().run(cmd).allow).toBe(false);
  });
});

describe('allowlist', () => {
  const strict = () => make({ allow: [] });

  it.each([
    'git status',
    'git push origin feat/215-x',
    'pnpm test',
    'pnpm run build && pnpm run lint',
    'npx vitest run',
    'node -v',
    'dotnet test',
    'uv run pytest',
    'python -m pytest',
    'ng build',
    'pwsh -File x.ps1',
  ])('allows %s', (command) => {
    expect(strict().run(command)).toEqual({ allow: true });
  });

  it.each([
    'gh pr merge 5',
    'gh issue view 215',
    'gh pr create --base release/next',
    'gh api repos/o/r/issues',
    'git rebase main',
    'git stash',
    'rm -rf node_modules',
    'curl https://example.com',
    'pnpm test && rm -rf x',
    'echo $(rm -rf x)',
  ])('denies %s', (command) => {
    const d = strict().run(command);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('allowlist');
  });

  it('does not match a prefix inside a word', () => {
    expect(strict().run('gitk').allow).toBe(false);
    expect(strict().run('nodejs x').allow).toBe(false);
  });

  it('extends the list with the config allow', () => {
    expect(strict().run('make test').allow).toBe(false);
    expect(make({ allow: ['make'] }).run('make test').allow).toBe(true);
    expect(make({ allow: ['gh pr merge'] }).run('gh pr merge 5').allow).toBe(true);
  });

  it('does not let the config allow lift a guardrail', () => {
    expect(make({ allow: ['git reset'] }).run('git reset --hard').allow).toBe(false);
  });

  it('keeps the built-in list when the config extends it', () => {
    expect(ALLOWED_COMMANDS).toContain('git push');
    expect(make({ allow: ['make'] }).run('git status').allow).toBe(true);
  });

  it('passes tools other than shell', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Skill', 'view']) {
      expect(strict().allow(tool, { path: 'a' })).toEqual({ allow: true });
    }
  });

  it('reads the command of Claude and Copilot payloads', () => {
    const p = strict();
    expect(p.allow('Bash', { command: 'git status' }).allow).toBe(true);
    expect(p.allow('bash', { toolArgs: '{"command":"git status"}' }).allow).toBe(true);
    expect(p.allow('powershell', { toolArgs: { command: 'git reset --hard' } }).allow).toBe(false);
  });

  it('denies a shell call without a command', () => {
    expect(strict().allow('Bash', {}).allow).toBe(false);
    expect(strict().allow('Bash', null).allow).toBe(false);
    expect(strict().allow('bash', { toolArgs: 'not json' }).allow).toBe(false);
  });
});

describe('permission_denied events', () => {
  it('records every deny and nothing else', () => {
    const p = make({ allow: [] });
    p.run('git status');
    p.run('git reset --hard');
    p.run('rm -rf x');
    p.allow('Bash', {});
    expect(p.denied).toHaveLength(3);
    expect(p.denied[0]).toEqual({
      at: '2026-10-27T10:00:00.000Z',
      kind: 'permission_denied',
      summary: expect.stringContaining('git reset --hard discards'),
    });
    expect(p.denied[1]?.summary).toContain('rm -rf x');
  });

  it('keeps summaries within the RunEvent limit', () => {
    const p = make({ allow: [] });
    p.run(`unknown ${'x'.repeat(2000)}`);
    expect(p.denied[0]?.summary.length).toBeLessThanOrEqual(500);
  });
});
