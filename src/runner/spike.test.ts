import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db.js';
import type { Harness, HarnessName } from './harness.js';
import { runSpike } from './spike.js';

let dir: string;
let db: Db;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dromos-spike-'));
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'release/next', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'release/next');
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const events = () =>
  db.queryEvents({ issue: 7, limit: 50 }).events.map((e) => ({ type: e.kind, data: e.data }));

function fake(commit: boolean): (n: HarnessName) => Harness & { version(): Promise<string> } {
  return () => ({
    version: async () => '1.2.3',
    async runPhase(input) {
      if (commit) {
        writeFileSync(join(input.cwd, 'x.txt'), 'x');
        git(input.cwd, 'add', 'x.txt');
        git(
          input.cwd,
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '-m',
          'x',
        );
      }
      return {
        result: 'done',
        events: [],
        usage: { inputTokens: 3, outputTokens: 2, costUsd: null },
      };
    },
  });
}

describe('runSpike', () => {
  it('creates the worktree, checks the commit and writes phase events', async () => {
    const res = await runSpike({
      issue: 7,
      harness: 'claude',
      repo: join(dir, 'repo'),
      db,
      title: 'Add the thing',
      makeHarness: fake(true),
    });
    expect(res.ok).toBe(true);
    expect(res.branch).toBe('spike/7-add-the-thing');
    expect(git(res.worktree, 'log', '-1', '--format=%s').trim()).toBe('x');
    const e = events();
    expect(e.map((x) => x.type)).toEqual(['phase.started', 'phase.finished']);
    expect(e[1]?.data).toMatchObject({
      phase: 'implementer',
      harness: { name: 'claude', version: '1.2.3' },
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it('writes phase.failed when no commit exists', async () => {
    const res = await runSpike({
      issue: 7,
      harness: 'copilot',
      repo: join(dir, 'repo'),
      db,
      title: 'No change',
      makeHarness: fake(false),
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/without a new commit/);
    expect(events().map((x) => x.type)).toEqual(['phase.started', 'phase.failed']);
  });

  it('writes phase.failed when the harness throws', async () => {
    const res = await runSpike({
      issue: 7,
      harness: 'claude',
      repo: join(dir, 'repo'),
      db,
      title: 'Boom',
      makeHarness: () => ({
        version: async () => null,
        runPhase: async () => {
          throw new Error('cli died');
        },
      }),
    });
    expect(res).toMatchObject({ ok: false, message: 'cli died' });
    expect(events().map((x) => x.type)).toEqual(['phase.started', 'phase.failed']);
  });
});
