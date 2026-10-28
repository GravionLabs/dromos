import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkDependencies } from './dependencies.js';

let repo: string;
let worktree: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'dromos-deps-'));
  await execa('git', ['-C', repo, 'init', '-q']);
  worktree = join(repo, 'wt');
  mkdirSync(worktree);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('linkDependencies', () => {
  it('links node_modules into the worktree and keeps the link out of git status', async () => {
    mkdirSync(join(repo, 'node_modules'));
    expect(await linkDependencies(repo, worktree)).toBe(true);
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
    const status = await execa('git', ['-C', repo, 'status', '--porcelain', '--', 'node_modules']);
    expect(status.stdout).not.toContain('node_modules');
  });

  it('does nothing without node_modules in the repository', async () => {
    expect(await linkDependencies(repo, worktree)).toBe(false);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
  });

  it('keeps a node_modules the worktree already has', async () => {
    mkdirSync(join(repo, 'node_modules'));
    mkdirSync(join(worktree, 'node_modules'));
    expect(await linkDependencies(repo, worktree)).toBe(false);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).not.toContain(
      '/node_modules',
    );
  });
});
