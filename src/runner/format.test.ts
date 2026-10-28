import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from './config.js';
import {
  detectFormatter,
  type FormatEvent,
  type FormatGit,
  filterFiles,
  resolveFormatter,
  runFormatStep,
} from './format.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dromos-format-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const put = (name: string, content = '') => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), content);
};
const noJb = async () => false;
const yesJb = async () => true;

describe('detectFormatter', () => {
  it('returns null for an empty repo', async () => {
    expect(await detectFormatter(dir, noJb)).toBeNull();
  });

  it('prefers scripts.format and takes the package manager from the lockfile', async () => {
    put('package.json', JSON.stringify({ scripts: { format: 'x' } }));
    put('pnpm-lock.yaml');
    put('biome.json');
    const f = await detectFormatter(dir, noJb);
    expect(f?.commands(['a.ts'])).toEqual(['pnpm run format']);
  });

  it('falls back to npm without a lockfile', async () => {
    put('package.json', JSON.stringify({ scripts: { format: 'x' } }));
    expect((await detectFormatter(dir, noJb))?.describe).toBe('npm run format');
  });

  it('detects biome before prettier', async () => {
    put('biome.jsonc');
    put('.prettierrc');
    const f = await detectFormatter(dir, noJb);
    expect(f?.commands(['a.ts', 'b c.ts'])).toEqual(["biome check --write 'a.ts' 'b c.ts'"]);
  });

  it('detects prettier by rc file and by package.json key', async () => {
    put('.prettierrc.json');
    expect((await detectFormatter(dir, noJb))?.commands(['a.ts'])).toEqual([
      "prettier --write 'a.ts'",
    ]);
    rmSync(join(dir, '.prettierrc.json'));
    put('package.json', JSON.stringify({ prettier: {} }));
    expect((await detectFormatter(dir, noJb))?.describe).toBe('prettier --write <files>');
  });

  it('detects ruff from pyproject.toml and runs format then check', async () => {
    put('pyproject.toml', '[tool.ruff]\nline-length = 100\n');
    const f = await detectFormatter(dir, noJb);
    expect(f?.commands(['a.py'])).toEqual(["ruff format 'a.py'", "ruff check --fix 'a.py'"]);
  });

  it('ignores pyproject.toml without a ruff table', async () => {
    put('pyproject.toml', '[tool.black]\n');
    expect(await detectFormatter(dir, noJb)).toBeNull();
  });

  it('uses dotnet format without ReSharper CLI', async () => {
    put('App.sln');
    expect((await detectFormatter(dir, noJb))?.commands(['A.cs'])).toEqual([
      "dotnet format --include 'A.cs'",
    ]);
  });

  it('uses jb from PATH for cleanupcode', async () => {
    put('App.slnx');
    expect((await detectFormatter(dir, yesJb))?.commands(['A.cs', 'B.cs'])).toEqual([
      `jb cleanupcode 'App.slnx' --include="A.cs;B.cs" --profile="Built-in: Reformat Code"`,
    ]);
  });

  it('prefers the local tool manifest over PATH', async () => {
    put('App.sln');
    put(
      '.config/dotnet-tools.json',
      JSON.stringify({ tools: { 'jetbrains.resharper.globaltools': { version: '1' } } }),
    );
    expect((await detectFormatter(dir, yesJb))?.commands(['A.cs'])[0]).toMatch(
      /^dotnet jb cleanupcode/,
    );
    expect((await detectFormatter(dir, noJb))?.commands(['A.cs'])[0]).toMatch(
      /^dotnet jb cleanupcode/,
    );
  });

  it('skips ReSharper with several solutions and falls back to dotnet format', async () => {
    put('A.sln');
    put('B.sln');
    expect((await detectFormatter(dir, yesJb))?.describe).toBe('dotnet format --include <files>');
  });

  it('detects a lone csproj', async () => {
    put('App.csproj');
    expect((await detectFormatter(dir, noJb))?.describe).toBe('dotnet format --include <files>');
  });

  it('detects cargo fmt', async () => {
    put('Cargo.toml');
    expect((await detectFormatter(dir, noJb))?.commands(['src/a.rs'])).toEqual(['cargo fmt']);
  });
});

describe('filterFiles', () => {
  it('keeps only handled extensions', async () => {
    put('biome.json');
    const f = await detectFormatter(dir, noJb);
    expect(filterFiles(f as NonNullable<typeof f>, ['a.ts', 'b.md', 'c.json', 'd.py'])).toEqual([
      'a.ts',
      'c.json',
    ]);
  });
});

describe('resolveFormatter', () => {
  it('false disables the step', async () => {
    const config = RunnerConfigSchema.parse({ format: false });
    expect(await resolveFormatter(config, dir, noJb)).toBe('disabled');
  });

  it('a command replaces detection and substitutes {files}', async () => {
    put('biome.json');
    const config = RunnerConfigSchema.parse({ format: 'fmt {files} --x' });
    const f = await resolveFormatter(config, dir, noJb);
    expect(f).not.toBe('disabled');
    expect(typeof f === 'object' && f?.commands(['a b.ts', 'c.ts'])).toEqual([
      "fmt 'a b.ts' 'c.ts' --x",
    ]);
  });

  it('a command without {files} runs as is', async () => {
    const config = RunnerConfigSchema.parse({ format: 'make fmt' });
    const f = await resolveFormatter(config, dir, noJb);
    expect(typeof f === 'object' && f?.commands(['a.ts'])).toEqual(['make fmt']);
  });
});

function harness(opts: { files?: string[]; passed?: boolean; committed?: boolean } = {}) {
  const events: FormatEvent[] = [];
  const commands: string[] = [];
  const budgets: number[] = [];
  const messages: string[] = [];
  const git: FormatGit = {
    changedFiles: async () => opts.files ?? ['a.ts'],
    commitAll: async (m) => {
      messages.push(m);
      return opts.committed ?? true;
    },
  };
  const input = (config: Record<string, unknown> = {}) => ({
    config: RunnerConfigSchema.parse(config),
    cwd: dir,
    base: 'release/next',
    issue: 287,
    run: async (c: string, _cwd: string, timeoutMs: number) => {
      commands.push(c);
      budgets.push(timeoutMs);
      return { passed: opts.passed ?? true, output: 'l1\nboom' };
    },
    emit: (e: FormatEvent) => events.push(e),
    git,
    jbOnPath: noJb,
  });
  return { events, commands, budgets, messages, input };
}

describe('runFormatStep', () => {
  it('gives the formatter the format budget of timeouts, 10 minutes by default', async () => {
    put('biome.json');
    const h = harness();
    await runFormatStep(h.input());
    await runFormatStep(h.input({ timeouts: { format: 3 } }));
    expect(h.budgets).toEqual([600_000, 180_000]);
  });

  it('formats, commits and reports', async () => {
    put('biome.json');
    const h = harness();
    await runFormatStep(h.input());
    expect(h.commands).toEqual(["biome check --write 'a.ts'"]);
    expect(h.messages).toEqual(['style: format (#287)']);
    expect(h.events).toEqual([
      {
        type: 'format.finished',
        data: { command: 'biome check --write <files>', files: 1, committed: true },
      },
    ]);
  });

  it('reports committed false when the formatter changed nothing', async () => {
    put('biome.json');
    const h = harness({ committed: false });
    await runFormatStep(h.input());
    expect(h.events[0]).toMatchObject({ type: 'format.finished', data: { committed: false } });
  });

  it('skips with no-formatter', async () => {
    const h = harness();
    await runFormatStep(h.input());
    expect(h.events).toEqual([{ type: 'format.skipped', data: { reason: 'no-formatter' } }]);
    expect(h.commands).toEqual([]);
  });

  it('skips when no changed file matches', async () => {
    put('biome.json');
    const h = harness({ files: ['README.md'] });
    await runFormatStep(h.input());
    expect(h.events).toEqual([{ type: 'format.skipped', data: { reason: 'no-files' } }]);
    expect(h.commands).toEqual([]);
  });

  it('does nothing but report when disabled', async () => {
    put('biome.json');
    const h = harness();
    await runFormatStep(h.input({ format: false }));
    expect(h.events).toEqual([{ type: 'format.skipped', data: { reason: 'disabled' } }]);
    expect(h.commands).toEqual([]);
  });

  it('a failing formatter emits format.failed and commits nothing', async () => {
    put('biome.json');
    const h = harness({ passed: false });
    await runFormatStep(h.input());
    expect(h.events).toEqual([
      {
        type: 'format.failed',
        data: { command: "biome check --write 'a.ts'", stderrTail: 'l1\nboom' },
      },
    ]);
    expect(h.messages).toEqual([]);
  });

  it('a throwing git step does not escape', async () => {
    put('biome.json');
    const h = harness();
    const input = h.input();
    input.git = {
      changedFiles: async () => {
        throw new Error('no git');
      },
      commitAll: async () => false,
    };
    await runFormatStep(input);
    expect(h.events[0]).toMatchObject({ type: 'format.failed', data: { stderrTail: 'no git' } });
  });
});
