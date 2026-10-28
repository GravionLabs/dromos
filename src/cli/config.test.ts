import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runConfigCli, runInitCli } from './config.js';

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dromos-init-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const cfgPath = (dir: string) => join(dir, '.dromos', 'config.json');
const readCfg = (dir: string) => JSON.parse(readFileSync(cfgPath(dir), 'utf8'));
const cfgFile = (value: unknown) => ({ '.dromos/config.json': JSON.stringify(value) });

async function run(fn: typeof runInitCli, argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await fn(argv, { out: (t) => stdout.push(t), err: (l) => stderr.push(l) });
  return { code, stdout: stdout.join(''), stderr: stderr.join('\n') };
}

describe('dromos init', () => {
  it.each([
    [{ 'package.json': '{}' }, 'npm test'],
    [{ 'package.json': '{}', 'pnpm-lock.yaml': '' }, 'pnpm test'],
    [{ 'pyproject.toml': '' }, 'pytest'],
    [{ 'App.csproj': '' }, 'dotnet test'],
    [{ 'Cargo.toml': '' }, 'cargo test'],
    [
      { 'package.json': '{}', 'angular.json': '{}' },
      'npx ng test --watch=false --browsers=ChromeHeadless',
    ],
    [{}, 'npm test'],
  ])('creates the file for %j with test.full %s', async (files, expected) => {
    const dir = repo(files);
    const res = await run(runInitCli, ['--repo', dir]);
    expect(res.code).toBe(0);
    expect(readCfg(dir)).toEqual({ harness: 'claude', test: { full: expected }, parallel: 3 });
  });

  it('lets --stack and --test-full override detection', async () => {
    const dir = repo({ 'package.json': '{}' });
    await run(runInitCli, ['--repo', dir, '--stack', 'rust']);
    expect(readCfg(dir).test.full).toBe('cargo test');
    const dir2 = repo({ 'package.json': '{}' });
    await run(runInitCli, ['--repo', dir2, '--stack', 'rust', '--test-full', 'make check']);
    expect(readCfg(dir2).test.full).toBe('make check');
  });

  it('keeps user values and adds a missing key', async () => {
    const dir = repo(cfgFile({ harness: 'copilot', test: { full: 'make ci' } }));
    const res = await run(runInitCli, ['--repo', dir, '--format', 'json']);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      path: cfgPath(dir),
      action: 'updated',
      added: ['parallel'],
      kept: ['harness', 'test.full'],
    });
    expect(readCfg(dir)).toEqual({ harness: 'copilot', test: { full: 'make ci' }, parallel: 3 });
  });

  it('adds test.full inside an existing test object', async () => {
    const dir = repo(
      cfgFile({ test: { related: 'vitest related' }, harness: 'claude', parallel: 2 }),
    );
    await run(runInitCli, ['--repo', dir, '--stack', 'py']);
    expect(readCfg(dir).test).toEqual({ related: 'vitest related', full: 'pytest' });
    expect(readCfg(dir).parallel).toBe(2);
  });

  it('reports unchanged when nothing is missing', async () => {
    const dir = repo(cfgFile({ harness: 'claude', test: { full: 'x' }, parallel: 1 }));
    const res = await run(runInitCli, ['--repo', dir, '--format', 'json']);
    expect(JSON.parse(res.stdout).action).toBe('unchanged');
  });

  it('leaves an invalid file untouched and exits 1 with the errors', async () => {
    const content = '{"models":{"planner":"opus"}}';
    const dir = repo({ '.dromos/config.json': content });
    const res = await run(runInitCli, ['--repo', dir]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('models');
    expect(readFileSync(cfgPath(dir), 'utf8')).toBe(content);
  });

  it('writes nothing on --dry-run and prints file and diff', async () => {
    const dir = repo({ 'Cargo.toml': '' });
    const res = await run(runInitCli, ['--repo', dir, '--dry-run']);
    expect(res.code).toBe(0);
    expect(existsSync(cfgPath(dir))).toBe(false);
    expect(res.stdout).toContain('"full": "cargo test"');
    expect(res.stdout).toContain('+   "parallel": 3');
  });

  it.each([
    [['--stack', 'go'], /--stack must be/],
    [['--format', 'xml'], /--format must be/],
    [['--nope'], /unknown option/],
    [['--repo'], /needs a value/],
  ])('rejects %j with exit code 2', async (argv, message) => {
    const res = await run(runInitCli, argv);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(message);
  });
});

describe('dromos config', () => {
  it('check accepts a valid file', async () => {
    const dir = repo(cfgFile({ parallel: 2 }));
    expect((await run(runConfigCli, ['check', '--repo', dir])).code).toBe(0);
  });

  it('check reports path and message of each error, exit 1', async () => {
    const dir = repo(cfgFile({ parallel: 'x', extra: 1 }));
    const res = await run(runConfigCli, ['check', '--repo', dir, '--format', 'json']);
    expect(res.code).toBe(1);
    const paths = JSON.parse(res.stdout).errors.map((e: { path: string }) => e.path);
    expect(paths).toContain('parallel');
    const text = await run(runConfigCli, ['check', '--repo', dir]);
    expect(text.stderr).toContain('parallel:');
  });

  it('check fails on broken JSON', async () => {
    const dir = repo({ '.dromos/config.json': '{' });
    expect((await run(runConfigCli, ['check', '--repo', dir])).code).toBe(1);
  });

  it('prints the JSON Schema', async () => {
    const res = await run(runConfigCli, ['schema']);
    expect(res.code).toBe(0);
    expect(Object.keys(JSON.parse(res.stdout).properties)).toContain('parallel');
  });

  it.each([
    [[]],
    [['bogus']],
    [['check', '--format', 'xml']],
    [['check', '--x']],
    [['schema', 'x']],
  ])('rejects %j with exit code 2', async (argv) => {
    expect((await run(runConfigCli, argv)).code).toBe(2);
  });
});
