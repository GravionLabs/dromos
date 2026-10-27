import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRunnerConfig, RunnerConfigError, testCommand } from './config.js';

describe('loadRunnerConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dromos-runner-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(content: unknown): void {
    mkdirSync(join(dir, '.dromos'), { recursive: true });
    writeFileSync(
      join(dir, '.dromos', 'config.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }

  it('returns the defaults when the file is missing', () => {
    expect(loadRunnerConfig(dir)).toEqual({
      harness: 'claude',
      models: {
        planner: 'opus',
        implementer: 'sonnet',
        implementerRound2: 'opus',
        reviewer: 'sonnet',
        retro: 'opus',
      },
      skills: {
        planner: ['planner'],
        implementer: ['implementation'],
        reviewer: ['code-review'],
        retro: ['retro'],
      },
      test: { full: 'npm test' },
      parallel: 3,
      allow: [],
    });
  });

  it('merges a partial file over the defaults', () => {
    write({
      harness: 'copilot',
      models: { implementer: 'gpt-5' },
      skills: { reviewer: ['code-review', 'rust-test'] },
      test: { related: 'pnpm test --changed', full: 'pnpm test' },
      parallel: 1,
      allow: ['pnpm run lint'],
    });
    const config = loadRunnerConfig(dir);
    expect(config.harness).toBe('copilot');
    expect(config.models).toMatchObject({ implementer: 'gpt-5', planner: 'opus' });
    expect(config.skills.reviewer).toEqual(['code-review', 'rust-test']);
    expect(config.skills.planner).toEqual(['planner']);
    expect(config.test).toEqual({ related: 'pnpm test --changed', full: 'pnpm test' });
    expect(config.parallel).toBe(1);
    expect(config.allow).toEqual(['pnpm run lint']);
  });

  it('uses test.full when test.related is absent', () => {
    write({ test: { full: 'cargo test' } });
    expect(testCommand(loadRunnerConfig(dir))).toBe('cargo test');
    write({ test: { related: 'cargo test -p x', full: 'cargo test' } });
    expect(testCommand(loadRunnerConfig(dir))).toBe('cargo test -p x');
  });

  it.each([
    ['unknown harness', { harness: 'gemini' }],
    ['unknown top-level key', { paralel: 2 }],
    ['unknown role', { models: { architect: 'opus' } }],
    ['empty model', { models: { planner: '' } }],
    ['zero parallel', { parallel: 0 }],
    ['fractional parallel', { parallel: 1.5 }],
    ['skills not a list', { skills: { planner: 'planner' } }],
    ['empty test command', { test: { full: '' } }],
  ])('rejects %s', (_name, content) => {
    write(content);
    expect(() => loadRunnerConfig(dir)).toThrow(RunnerConfigError);
  });

  it('names the file and the field in a validation error', () => {
    write({ parallel: 0 });
    expect(() => loadRunnerConfig(dir)).toThrow(/config\.json[\s\S]*parallel/);
  });

  it('rejects invalid JSON', () => {
    write('{ nope');
    expect(() => loadRunnerConfig(dir)).toThrow(/invalid JSON/);
  });
});
