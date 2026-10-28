import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RunnerConfig, stepTimeoutMs } from './config.js';
import type { ShellResult } from './format.js';

/**
 * Setup step: installs the dependencies in a fresh worktree before the implementer, the format step
 * and the tests. A real install instead of a link to the main checkout's `node_modules`: pnpm checks
 * the dependency state before every `pnpm run` and fails in a worktree that shares another
 * project's modules directory, and a pull request that changes dependencies must be tested against
 * its own lockfile. Ecosystems with a shared global cache (Cargo, Go, Gradle, Maven) need no step.
 */

export type SetupEvent =
  | { type: 'setup.skipped'; data: { reason: 'disabled' | 'no-lockfile' } }
  | { type: 'setup.started'; data: { command: string } }
  | { type: 'setup.failed'; data: { command: string; stderrTail: string } }
  | { type: 'setup.finished'; data: { command: string; durationMs: number } };

const SETUP_TAIL_LINES = 20;

/** The install command of the JS package manager whose lockfile is in `dir`; the first match wins. */
function jsInstall(dir: string): string | null {
  if (existsSync(join(dir, 'pnpm-lock.yaml')))
    return 'pnpm install --frozen-lockfile --prefer-offline';
  if (existsSync(join(dir, 'yarn.lock'))) {
    // Yarn 2+ (Berry) keeps its settings in `.yarnrc.yml`; Yarn 1 knows neither the file nor `--immutable`.
    return existsSync(join(dir, '.yarnrc.yml'))
      ? 'yarn install --immutable'
      : 'yarn install --frozen-lockfile --prefer-offline';
  }
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm ci --prefer-offline';
  return null;
}

/** The sync command of the Python project manager whose lockfile is in `dir`; the first match wins. */
function pythonInstall(dir: string): string | null {
  if (existsSync(join(dir, 'uv.lock'))) return 'uv sync --frozen';
  // `poetry sync` needs Poetry 2, which deprecated `install --sync` of Poetry 1 for removal.
  if (existsSync(join(dir, 'poetry.lock'))) return 'poetry sync';
  return null;
}

const shellArg = (s: string): string =>
  /^[\w.-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

/** NuGet lockfiles are on when the root has one or `Directory.Build.props` turns them on. */
function nugetLocked(dir: string): boolean {
  if (existsSync(join(dir, 'packages.lock.json'))) return true;
  const props = join(dir, 'Directory.Build.props');
  return (
    existsSync(props) &&
    /<RestorePackagesWithLockFile>\s*true\s*<\/RestorePackagesWithLockFile>/i.test(
      readFileSync(props, 'utf8'),
    )
  );
}

/**
 * `dotnet restore` for each solution at the root, else for each project there. The file is named
 * explicitly: without one, `dotnet restore` fails when the root holds several project or solution files.
 */
function dotnetInstall(dir: string): string | null {
  const entries = readdirSync(dir).sort();
  const solutions = entries.filter((f) => f.endsWith('.sln') || f.endsWith('.slnx'));
  const targets = solutions.length > 0 ? solutions : entries.filter((f) => f.endsWith('.csproj'));
  if (targets.length === 0) return null;
  const locked = nugetLocked(dir) ? ' --locked-mode' : '';
  return targets.map((t) => `dotnet restore ${shellArg(t)}${locked}`).join(' && ');
}

/** The install commands detected from the lockfiles in `dir`, one per ecosystem, in run order. */
export function detectSetup(dir: string): string[] {
  return [jsInstall(dir), pythonInstall(dir), dotnetInstall(dir)].filter(
    (c): c is string => c !== null,
  );
}

/** The commands of the setup step: the `setup` override, `'disabled'`, or detection. */
export function resolveSetup(config: RunnerConfig, dir: string): string[] | 'disabled' {
  if (config.setup === false) return 'disabled';
  if (config.setup !== undefined) return [config.setup];
  return detectSetup(dir);
}

export interface SetupStepInput {
  config: RunnerConfig;
  cwd: string;
  run: (command: string, cwd: string, timeoutMs: number) => Promise<ShellResult>;
  emit: (event: SetupEvent) => void;
  now?: () => number;
}

/**
 * Runs the setup commands in order and stops at the first failure.
 * Resolves to the failed command, or `null` when every command passed or there was nothing to run.
 */
export async function runSetupStep(input: SetupStepInput): Promise<string | null> {
  const { emit, cwd } = input;
  const now = input.now ?? Date.now;
  const commands = resolveSetup(input.config, cwd);
  if (commands === 'disabled' || commands.length === 0) {
    emit({
      type: 'setup.skipped',
      data: { reason: commands === 'disabled' ? 'disabled' : 'no-lockfile' },
    });
    return null;
  }
  for (const command of commands) {
    emit({ type: 'setup.started', data: { command } });
    const start = now();
    const res = await input.run(command, cwd, stepTimeoutMs(input.config, 'setup'));
    if (!res.passed) {
      const stderrTail = res.output.trimEnd().split('\n').slice(-SETUP_TAIL_LINES).join('\n');
      emit({ type: 'setup.failed', data: { command, stderrTail } });
      return command;
    }
    emit({ type: 'setup.finished', data: { command, durationMs: now() - start } });
  }
  return null;
}
