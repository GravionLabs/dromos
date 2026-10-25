import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGateCommands, runGate } from './gate.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dromos-gate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const touch = (name: string, content = '') => writeFileSync(join(dir, name), content);
const pkg = (scripts: Record<string, string>) => touch('package.json', JSON.stringify({ scripts }));
const runs = (cmds: { run: string }[]) => cmds.map((c) => c.run);

describe('resolveGateCommands', () => {
  it('returns configured commands untouched even when files would match', () => {
    touch('pnpm-lock.yaml');
    const configured = [{ name: 'mine', run: 'make check' }];
    expect(resolveGateCommands(dir, configured)).toEqual(configured);
  });

  it('detects pnpm and only includes scripts present in package.json', () => {
    touch('pnpm-lock.yaml');
    pkg({ lint: 'x', test: 'y' });
    expect(runs(resolveGateCommands(dir, []))).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'pnpm test',
    ]);
  });

  it('includes pnpm build when the script exists', () => {
    touch('pnpm-lock.yaml');
    pkg({ lint: 'a', test: 'b', build: 'c' });
    expect(runs(resolveGateCommands(dir, []))).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'pnpm test',
      'pnpm build',
    ]);
  });

  it('installs only when package.json has no scripts', () => {
    touch('pnpm-lock.yaml');
    touch('package.json', '{}');
    expect(runs(resolveGateCommands(dir, []))).toEqual(['pnpm install --frozen-lockfile']);
  });

  it('fails the gate with the parse error when package.json is malformed', async () => {
    touch('pnpm-lock.yaml');
    touch('package.json', '{ not json');
    const cmds = resolveGateCommands(dir, []);
    expect(cmds.map((c) => c.name)).toEqual(['package-json']);
    const result = await runGate(cmds, dir, 30);
    expect(result.passed).toBe(false);
    expect(result.steps[0]?.outputTail).toContain('invalid package.json');
  });

  it('does not treat foo.sln.bak as a solution', () => {
    touch('foo.sln.bak');
    expect(resolveGateCommands(dir, [])[0]?.name).toBe('no-gate');
  });

  it('detects npm when only package-lock.json exists', () => {
    touch('package-lock.json');
    pkg({ test: 'y', build: 'z' });
    expect(runs(resolveGateCommands(dir, []))).toEqual(['npm ci', 'npm run test', 'npm run build']);
  });

  it('prefers pnpm over npm when both lockfiles exist', () => {
    touch('pnpm-lock.yaml');
    touch('package-lock.json');
    expect(runs(resolveGateCommands(dir, []))).toEqual(['pnpm install --frozen-lockfile']);
  });

  it.each(['app.sln', 'app.slnx'])('detects dotnet from %s', (file) => {
    touch(file);
    expect(runs(resolveGateCommands(dir, []))).toEqual([
      'dotnet build --nologo',
      'dotnet test --nologo --no-build',
    ]);
  });

  it('detects uv from pyproject.toml', () => {
    touch('pyproject.toml');
    expect(runs(resolveGateCommands(dir, []))).toEqual([
      'uv sync',
      'uv run ruff check',
      'uv run pytest -q',
    ]);
  });

  it('concatenates every matching stack in order', () => {
    touch('pnpm-lock.yaml');
    pkg({ test: 'y' });
    touch('app.sln');
    touch('pyproject.toml');
    expect(runs(resolveGateCommands(dir, []))).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm test',
      'dotnet build --nologo',
      'dotnet test --nologo --no-build',
      'uv sync',
      'uv run ruff check',
      'uv run pytest -q',
    ]);
  });

  it('tolerates a lockfile without package.json', () => {
    touch('package-lock.json');
    expect(runs(resolveGateCommands(dir, []))).toEqual(['npm ci']);
  });

  it('falls back to a failing no-gate step when nothing matches', async () => {
    const cmds = resolveGateCommands(dir, []);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.name).toBe('no-gate');
    const result = await runGate(cmds, dir, 30);
    expect(result.passed).toBe(false);
    expect(result.steps[0]?.outputTail).toContain('no gate commands detected');
  });
});

describe('runGate', () => {
  it('passes when every step exits 0', async () => {
    const result = await runGate(
      [
        { name: 'a', run: 'node -e "process.exit(0)"' },
        { name: 'b', run: 'node -e "process.exit(0)"' },
      ],
      dir,
      30,
    );
    expect(result.passed).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(['a', 'b']);
    expect(result.steps.every((s) => s.exitCode === 0)).toBe(true);
  });

  it('stops at the first non-zero exit and records its code', async () => {
    const result = await runGate(
      [
        { name: 'ok', run: 'node -e "process.exit(0)"' },
        { name: 'bad', run: 'node -e "process.exit(3)"' },
        { name: 'never', run: 'node -e "process.exit(0)"' },
      ],
      dir,
      30,
    );
    expect(result.passed).toBe(false);
    expect(result.steps.map((s) => [s.name, s.exitCode])).toEqual([
      ['ok', 0],
      ['bad', 3],
    ]);
    expect(result.steps[1]?.command).toBe('node -e "process.exit(3)"');
  });

  it('runs in the given cwd', async () => {
    const result = await runGate(
      [{ name: 'cwd', run: 'node -e "console.log(process.cwd())"' }],
      dir,
      30,
    );
    expect(result.steps[0]?.outputTail).toContain(realpathSync(dir));
  });

  it('keeps only the last 200 lines of stdout', async () => {
    const script = 'for (let i=1;i<=300;i++) console.log("line"+i)';
    const result = await runGate([{ name: 'noisy', run: `node -e '${script}'` }], dir, 30);
    const lines = result.steps[0]?.outputTail.split('\n') ?? [];
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('line101');
    expect(lines[199]).toBe('line300');
  });

  it('includes stderr output in the tail', async () => {
    const script = 'console.log("out-line"); console.error("err-line")';
    const result = await runGate([{ name: 'mixed', run: `node -e '${script}'` }], dir, 30);
    const tailText = result.steps[0]?.outputTail ?? '';
    expect(tailText).toContain('out-line');
    expect(tailText).toContain('err-line');
  });

  it('fails a step that exceeds the overall timeout', async () => {
    const result = await runGate(
      [{ name: 'slow', run: 'node -e "setTimeout(()=>{},10000)"' }],
      dir,
      1,
    );
    expect(result.passed).toBe(false);
    expect(result.steps[0]?.exitCode).not.toBe(0);
    expect(result.steps[0]?.outputTail).toContain('timed out');
  });

  it('returns passed for an empty command list', async () => {
    expect(await runGate([], dir, 30)).toEqual({ passed: true, steps: [] });
  });

  it('kills a grandchild holding the pipe on timeout without waiting for it', async () => {
    const started = Date.now();
    const result = await runGate([{ name: 'gc', run: "sh -c 'sleep 10 & wait'" }], dir, 1);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(result.passed).toBe(false);
    expect(result.steps[0]?.outputTail).toContain('timed out');
  });

  it('shares one budget across steps', async () => {
    const slow = 'node -e "setTimeout(()=>{},700)"';
    const result = await runGate(
      [
        { name: 'one', run: slow },
        { name: 'two', run: slow },
        { name: 'three', run: 'node -e "process.exit(0)"' },
      ],
      dir,
      1,
    );
    expect(result.passed).toBe(false);
    expect(result.steps.map((s) => s.name)).toEqual(['one', 'two']);
    expect(result.steps[0]?.exitCode).toBe(0);
    expect(result.steps[1]?.outputTail).toContain('timed out');
  });

  it('stops after a step that overruns the budget', async () => {
    const result = await runGate(
      [
        { name: 'one', run: 'node -e "setTimeout(()=>{},1200)"' },
        { name: 'two', run: 'node -e "process.exit(0)"' },
      ],
      dir,
      1,
    );
    expect(result.steps.map((s) => s.name)).toEqual(['one']);
    expect(result.passed).toBe(false);
  });

  it('returns a failed step instead of throwing when the cwd does not exist', async () => {
    const result = await runGate(
      [{ name: 'x', run: 'node -e "process.exit(0)"' }],
      join(dir, 'missing'),
      30,
    );
    expect(result.passed).toBe(false);
    expect(result.steps[0]?.exitCode).not.toBe(0);
  });
});
