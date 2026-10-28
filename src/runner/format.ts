import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execa } from 'execa';
import type { RunnerConfig } from './config.js';

/**
 * Format step: after every implementer phase and fix round the runner formats the files changed
 * against the base and commits the result, so a formatting slip never turns tests or CI red.
 * Same detection table as `references/format.md` of the apm-hub `implementation` skill.
 */

export interface ShellResult {
  passed: boolean;
  /** Combined stdout and stderr. */
  output: string;
}

export type FormatEvent =
  | { type: 'format.skipped'; data: { reason: 'no-formatter' | 'no-files' | 'disabled' } }
  | { type: 'format.failed'; data: { command: string; stderrTail: string } }
  | { type: 'format.finished'; data: { command: string; files: number; committed: boolean } };

/** A resolved formatter. */
export interface Formatter {
  /** Extensions (with dot) the formatter handles; `null` accepts every file. */
  extensions: string[] | null;
  /** Shell commands, run in order, for `files`. */
  commands: (files: string[]) => string[];
  /** Command text for dry run and events. */
  describe: string;
}

const JS_EXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'];
const FORMAT_TAIL_LINES = 20;

const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
const quoteAll = (files: string[]): string => files.map(shellQuote).join(' ');

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function hasPrettier(dir: string, pkg: Record<string, unknown> | null): boolean {
  if (pkg && 'prettier' in pkg) return true;
  return readdirSync(dir).some((f) => f.startsWith('.prettierrc'));
}

function hasRuff(dir: string): boolean {
  if (existsSync(join(dir, 'ruff.toml'))) return true;
  const py = join(dir, 'pyproject.toml');
  return existsSync(py) && /^\s*\[tool\.ruff[\].]/m.test(readFileSync(py, 'utf8'));
}

/** `dotnet jb` when the local tool manifest lists ReSharper CLI (it wins over PATH), else `jb` on PATH. */
function resharperCommand(dir: string, jbOnPath: boolean): string | null {
  const tools = readJson(join(dir, '.config', 'dotnet-tools.json'))?.tools;
  if (typeof tools === 'object' && tools !== null && 'jetbrains.resharper.globaltools' in tools) {
    return 'dotnet jb';
  }
  return jbOnPath ? 'jb' : null;
}

async function onPath(binary: string): Promise<boolean> {
  const res = await execa(process.platform === 'win32' ? 'where' : 'which', [binary], {
    reject: false,
  });
  return res.exitCode === 0;
}

/**
 * The formatter of the repo at `dir`; the first match wins. `jbOnPath` is injectable for tests.
 * With several solutions ReSharper needs the one at the repo root; otherwise `dotnet format` is used.
 */
export async function detectFormatter(
  dir: string,
  jbOnPath: () => Promise<boolean> = () => onPath('jb'),
): Promise<Formatter | null> {
  const pkgFile = join(dir, 'package.json');
  const pkg = existsSync(pkgFile) ? readJson(pkgFile) : null;
  const scripts = pkg?.scripts;
  if (typeof scripts === 'object' && scripts !== null && 'format' in scripts) {
    const cmd = `${packageManager(dir)} run format`;
    return { extensions: null, commands: () => [cmd], describe: cmd };
  }
  if (existsSync(join(dir, 'biome.json')) || existsSync(join(dir, 'biome.jsonc'))) {
    return {
      extensions: JS_EXT,
      commands: (f) => [`biome check --write ${quoteAll(f)}`],
      describe: 'biome check --write <files>',
    };
  }
  if (hasPrettier(dir, pkg)) {
    return {
      extensions: JS_EXT,
      commands: (f) => [`prettier --write ${quoteAll(f)}`],
      describe: 'prettier --write <files>',
    };
  }
  if (hasRuff(dir)) {
    return {
      extensions: ['.py'],
      commands: (f) => [`ruff format ${quoteAll(f)}`, `ruff check --fix ${quoteAll(f)}`],
      describe: 'ruff format <files> && ruff check --fix <files>',
    };
  }
  const entries = readdirSync(dir);
  const solutions = entries.filter((f) => f.endsWith('.sln') || f.endsWith('.slnx'));
  if (solutions.length > 0 || entries.some((f) => f.endsWith('.csproj'))) {
    const sln = solutions.length === 1 ? solutions[0] : undefined;
    const jb = sln ? resharperCommand(dir, await jbOnPath()) : null;
    if (jb && sln) {
      return {
        extensions: ['.cs'],
        commands: (f) => [
          `${jb} cleanupcode ${shellQuote(sln)} --include="${f.join(';')}" --profile="Built-in: Reformat Code"`,
        ],
        describe: `${jb} cleanupcode ${sln} --include="<files>" --profile="Built-in: Reformat Code"`,
      };
    }
    return {
      extensions: ['.cs'],
      commands: (f) => [`dotnet format --include ${quoteAll(f)}`],
      describe: 'dotnet format --include <files>',
    };
  }
  if (existsSync(join(dir, 'Cargo.toml'))) {
    return { extensions: ['.rs'], commands: () => ['cargo fmt'], describe: 'cargo fmt' };
  }
  return null;
}

/**
 * The formatter for a run: `config.format` replaces detection (`false` disables, a string is a
 * command with an optional `{files}` placeholder). `null` means nothing was detected.
 */
export async function resolveFormatter(
  config: RunnerConfig,
  dir: string,
  jbOnPath?: () => Promise<boolean>,
): Promise<Formatter | 'disabled' | null> {
  if (config.format === false) return 'disabled';
  if (typeof config.format === 'string') {
    const template = config.format;
    return {
      extensions: null,
      commands: (f) => [template.replaceAll('{files}', quoteAll(f))],
      describe: template,
    };
  }
  return detectFormatter(dir, jbOnPath);
}

/** Keeps the files the formatter handles. */
export function filterFiles(formatter: Formatter, files: string[]): string[] {
  const exts = formatter.extensions;
  return exts ? files.filter((f) => exts.includes(extname(f))) : files;
}

/** Git side of the step; replaced in unit tests. */
export interface FormatGit {
  /** Files changed against `origin/<base>` plus uncommitted ones, deleted files skipped. */
  changedFiles: (base: string, cwd: string) => Promise<string[]>;
  /** Commits all changes; false when there was nothing to commit. */
  commitAll: (message: string, cwd: string) => Promise<boolean>;
}

async function lines(cwd: string, args: string[]): Promise<string[]> {
  const res = await execa('git', ['-C', cwd, ...args], { reject: false });
  return String(res.stdout)
    .split('\n')
    .filter((l) => l !== '');
}

export const gitFormatOps: FormatGit = {
  async changedFiles(base, cwd) {
    const all = await Promise.all([
      lines(cwd, ['diff', '--name-only', '--diff-filter=d', `origin/${base}...HEAD`]),
      lines(cwd, ['diff', '--name-only', '--diff-filter=d', 'HEAD']),
      lines(cwd, ['ls-files', '--others', '--exclude-standard']),
    ]);
    return [...new Set(all.flat())].filter((f) => existsSync(join(cwd, f)));
  },
  async commitAll(message, cwd) {
    const status = await lines(cwd, ['status', '--porcelain']);
    if (status.length === 0) return false;
    await execa('git', ['-C', cwd, 'add', '-A']);
    await execa('git', ['-C', cwd, 'commit', '-m', message]);
    return true;
  },
};

export interface FormatStepInput {
  config: RunnerConfig;
  cwd: string;
  base: string;
  issue: number;
  run: (command: string, cwd: string) => Promise<ShellResult>;
  emit: (event: FormatEvent) => void;
  git?: FormatGit;
  jbOnPath?: () => Promise<boolean>;
}

function tailOf(output: string): string {
  return output.trimEnd().split('\n').slice(-FORMAT_TAIL_LINES).join('\n');
}

/** Formats the changed files and commits the result; never throws, a failure only emits an event. */
export async function runFormatStep(input: FormatStepInput): Promise<void> {
  const { emit, cwd } = input;
  const git = input.git ?? gitFormatOps;
  try {
    const formatter = await resolveFormatter(input.config, cwd, input.jbOnPath);
    if (formatter === 'disabled') {
      emit({ type: 'format.skipped', data: { reason: 'disabled' } });
      return;
    }
    if (formatter === null) {
      emit({ type: 'format.skipped', data: { reason: 'no-formatter' } });
      return;
    }
    const files = filterFiles(formatter, await git.changedFiles(input.base, cwd));
    if (files.length === 0) {
      emit({ type: 'format.skipped', data: { reason: 'no-files' } });
      return;
    }
    for (const command of formatter.commands(files)) {
      const res = await input.run(command, cwd);
      if (!res.passed) {
        emit({ type: 'format.failed', data: { command, stderrTail: tailOf(res.output) } });
        return;
      }
    }
    const committed = await git.commitAll(`style: format (#${String(input.issue)})`, cwd);
    emit({
      type: 'format.finished',
      data: { command: formatter.describe, files: files.length, committed },
    });
  } catch (error) {
    emit({
      type: 'format.failed',
      data: {
        command: 'format',
        stderrTail: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
