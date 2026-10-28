import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerConfigSchema } from './config.js';
import { detectSetup, resolveSetup, runSetupStep, type SetupEvent } from './dependencies.js';
import type { ShellResult } from './format.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dromos-setup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (...files: string[]): void => {
  for (const f of files) writeFileSync(join(dir, f), '');
};

describe('detectSetup', () => {
  it.each([
    [['pnpm-lock.yaml'], 'pnpm install --frozen-lockfile --prefer-offline'],
    [['package-lock.json'], 'npm ci --prefer-offline'],
    [['yarn.lock'], 'yarn install --frozen-lockfile --prefer-offline'],
    [['yarn.lock', '.yarnrc.yml'], 'yarn install --immutable'],
    [['uv.lock'], 'uv sync --frozen'],
    [['poetry.lock'], 'poetry sync'],
  ])('%j → %s', (files, command) => {
    touch(...files);
    expect(detectSetup(dir)).toEqual([command]);
  });

  it('prefers uv over a leftover poetry.lock', () => {
    touch('uv.lock', 'poetry.lock');
    expect(detectSetup(dir)).toEqual(['uv sync --frozen']);
  });

  it('runs one command per ecosystem, JS before Python', () => {
    touch('uv.lock', 'pnpm-lock.yaml');
    expect(detectSetup(dir)).toEqual([
      'pnpm install --frozen-lockfile --prefer-offline',
      'uv sync --frozen',
    ]);
  });

  it('prefers pnpm over a leftover package-lock.json', () => {
    touch('pnpm-lock.yaml', 'package-lock.json');
    expect(detectSetup(dir)).toEqual(['pnpm install --frozen-lockfile --prefer-offline']);
  });

  it('detects nothing without a lockfile, also for a package.json alone', () => {
    touch('package.json', 'Cargo.lock');
    expect(detectSetup(dir)).toEqual([]);
  });
});

describe('resolveSetup', () => {
  it('uses the override instead of detection', () => {
    touch('pnpm-lock.yaml');
    expect(resolveSetup(RunnerConfigSchema.parse({ setup: 'make deps' }), dir)).toEqual([
      'make deps',
    ]);
  });

  it('is disabled by false', () => {
    touch('pnpm-lock.yaml');
    expect(resolveSetup(RunnerConfigSchema.parse({ setup: false }), dir)).toBe('disabled');
  });

  it('rejects an empty command', () => {
    expect(RunnerConfigSchema.safeParse({ setup: '' }).success).toBe(false);
  });
});

describe('runSetupStep', () => {
  function step(config: unknown, results: ShellResult[]) {
    const events: SetupEvent[] = [];
    const ran: string[] = [];
    let clock = 1000;
    const result = runSetupStep({
      config: RunnerConfigSchema.parse(config),
      cwd: dir,
      run: async (command) => {
        ran.push(command);
        clock += 250;
        return results.shift() ?? { passed: true, output: '' };
      },
      emit: (e) => events.push(e),
      now: () => clock,
    });
    return { result, events, ran };
  }

  it('runs the detected command and reports its duration', async () => {
    touch('package-lock.json');
    const s = step({}, []);
    expect(await s.result).toBeNull();
    expect(s.ran).toEqual(['npm ci --prefer-offline']);
    expect(s.events).toEqual([
      { type: 'setup.started', data: { command: 'npm ci --prefer-offline' } },
      { type: 'setup.finished', data: { command: 'npm ci --prefer-offline', durationMs: 250 } },
    ]);
  });

  it('runs the commands of every detected ecosystem', async () => {
    touch('package-lock.json', 'poetry.lock');
    const s = step({}, []);
    expect(await s.result).toBeNull();
    expect(s.ran).toEqual(['npm ci --prefer-offline', 'poetry sync']);
    expect(s.events.filter((e) => e.type === 'setup.finished')).toHaveLength(2);
  });

  it('stops at the first failing command', async () => {
    touch('package-lock.json', 'uv.lock');
    const s = step({}, [{ passed: false, output: 'npm ERR' }]);
    expect(await s.result).toBe('npm ci --prefer-offline');
    expect(s.ran).toEqual(['npm ci --prefer-offline']);
  });

  it('skips without a lockfile', async () => {
    const s = step({}, []);
    expect(await s.result).toBeNull();
    expect(s.ran).toEqual([]);
    expect(s.events).toEqual([{ type: 'setup.skipped', data: { reason: 'no-lockfile' } }]);
  });

  it('skips when disabled', async () => {
    touch('pnpm-lock.yaml');
    const s = step({ setup: false }, []);
    expect(await s.result).toBeNull();
    expect(s.ran).toEqual([]);
    expect(s.events).toEqual([{ type: 'setup.skipped', data: { reason: 'disabled' } }]);
  });

  it('returns the failed command with the last 20 lines of its output', async () => {
    const output = Array.from({ length: 25 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const s = step({ setup: 'make deps' }, [{ passed: false, output: `${output}\n` }]);
    expect(await s.result).toBe('make deps');
    const failed = s.events.at(-1);
    expect(failed?.type).toBe('setup.failed');
    const tail = failed?.type === 'setup.failed' ? failed.data.stderrTail.split('\n') : [];
    expect(tail).toHaveLength(20);
    expect(tail[0]).toBe('line 6');
    expect(tail.at(-1)).toBe('line 25');
  });
});
