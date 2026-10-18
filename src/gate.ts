import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { GateCommand } from './config.js';
import type { GateResult, GateStepResult } from './schemas.js';

const TAIL_LINES = 200;
const MAX_BUFFER = 8 * 1024 * 1024;
const NODE_SCRIPTS = ['lint', 'test', 'build'] as const;

type Scripts = { scripts: Set<string> } | { error: string };

function packageScripts(worktreePath: string): Scripts {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, 'package.json'), 'utf8');
  } catch {
    return { scripts: new Set() };
  }
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> } | null;
    return { scripts: new Set(Object.keys(pkg?.scripts ?? {})) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function nodeSteps(worktreePath: string, install: GateCommand, runner: string): GateCommand[] {
  const found = packageScripts(worktreePath);
  if ('error' in found) {
    // Fail the gate loudly instead of silently skipping lint/test/build.
    const safe = found.error.replace(/[^A-Za-z0-9 .,:_-]/g, ' ');
    return [{ name: 'package-json', run: `echo "invalid package.json: ${safe}" >&2; exit 1` }];
  }
  return [
    install,
    ...NODE_SCRIPTS.filter((s) => found.scripts.has(s)).map((s) => ({
      name: s,
      run: `${runner} ${s}`,
    })),
  ];
}

/** Configured commands win; otherwise detect the stack(s) from lockfiles and project files. */
export function resolveGateCommands(
  worktreePath: string,
  configured: GateCommand[],
): GateCommand[] {
  if (configured.length > 0) return configured;

  const has = (file: string) => existsSync(join(worktreePath, file));
  const steps: GateCommand[] = [];

  if (has('pnpm-lock.yaml')) {
    steps.push(
      ...nodeSteps(
        worktreePath,
        { name: 'install', run: 'pnpm install --frozen-lockfile' },
        'pnpm',
      ),
    );
  } else if (has('package-lock.json')) {
    steps.push(...nodeSteps(worktreePath, { name: 'install', run: 'npm ci' }, 'npm run'));
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(worktreePath);
  } catch {
    // unreadable worktree: fall through to the no-gate step
  }
  if (entries.some((e) => e.endsWith('.sln') || e.endsWith('.slnx'))) {
    steps.push(
      { name: 'dotnet-build', run: 'dotnet build --nologo' },
      { name: 'dotnet-test', run: 'dotnet test --nologo --no-build' },
    );
  }

  if (has('pyproject.toml')) {
    steps.push(
      { name: 'uv-sync', run: 'uv sync' },
      { name: 'ruff', run: 'uv run ruff check' },
      { name: 'pytest', run: 'uv run pytest -q' },
    );
  }

  if (steps.length === 0) {
    return [{ name: 'no-gate', run: 'echo "no gate commands detected" && exit 1' }];
  }
  return steps;
}

function tail(output: string): string {
  const lines = output.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-TAIL_LINES).join('\n');
}

/** Run commands sequentially within one overall timeout budget; stop at the first failure. */
export async function runGate(
  commands: GateCommand[],
  cwd: string,
  timeoutSeconds: number,
): Promise<GateResult> {
  const budgetMs = timeoutSeconds * 1000;
  const start = Date.now();
  const steps: GateStepResult[] = [];

  for (const cmd of commands) {
    const remaining = budgetMs - (Date.now() - start);
    const stepStart = Date.now();
    let exitCode: number;
    let output: string;
    if (remaining <= 0) {
      exitCode = 1;
      output = 'gate timeout budget exhausted before step started';
    } else {
      // The parent env stays inherited: an allowlist would risk dropping variables that
      // pnpm/npm/uv/dotnet rely on (PATH shims, proxies, registries, DOTNET_*, XDG_*).
      const child = execa(cmd.run, {
        shell: true,
        cwd,
        all: true,
        reject: false,
        detached: true,
        maxBuffer: MAX_BUFFER,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the whole process group so grandchildren holding the pipes cannot stall us.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, remaining);
      try {
        const res = await child;
        exitCode = typeof res.exitCode === 'number' ? res.exitCode : 1;
        output = String(res.all ?? '');
        if (timedOut) {
          exitCode = exitCode === 0 ? 1 : exitCode;
          output += `\ngate timed out after ${timeoutSeconds}s`;
        }
      } catch (e) {
        exitCode = 1;
        output = `failed to run step: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
      }
    }
    steps.push({
      name: cmd.name,
      command: cmd.run,
      exitCode,
      durationMs: Date.now() - stepStart,
      outputTail: tail(output),
    });
    if (exitCode !== 0) break;
  }

  return { passed: steps.every((s) => s.exitCode === 0), steps };
}
