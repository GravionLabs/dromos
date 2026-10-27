import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { ClaimError, type RunnerIssue } from './github.js';
import type { Harness } from './harness.js';
import {
  acceptanceCriteria,
  EXIT_BLOCKED,
  EXIT_DONE,
  EXIT_ERROR,
  parseTitle,
  type RunPbiEvent,
  type RunPbiOps,
  runPbi,
} from './run-pbi.js';

const issue: RunnerIssue = {
  number: 224,
  title: '[PBI] feat: dromos run pbi CLI',
  body: '## Overview\n\nx\n\n## Acceptance Criteria\n\n- [ ] a\n- [ ] b\n\n## Technical Notes\n\nn',
  labels: [],
  subIssues: [],
  blockedBy: [],
};

function setup(
  answers: unknown[],
  opts: { issue?: RunnerIssue; ops?: Partial<RunPbiOps>; dryRun?: boolean } = {},
) {
  const queue = [...answers];
  const calls: string[] = [];
  let harnessStarted = 0;
  const harness: Harness & { version(): Promise<string | null> } = {
    async version() {
      harnessStarted++;
      return '1.2.3';
    },
    async runPhase() {
      harnessStarted++;
      const result = queue.shift();
      if (result instanceof Error) throw result;
      return { result, events: [], usage: null };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'dromos-pbi-'));
  const events: RunPbiEvent[] = [];
  const ops: Partial<RunPbiOps> = {
    repoSlug: async () => 'o/r',
    readIssue: async () => opts.issue ?? issue,
    claimIssue: async () => {
      calls.push('claim');
    },
    releaseIssue: async () => {
      calls.push('release');
    },
    openWorktree: async () => {
      calls.push('worktree');
      return { path: dir, branch: 'feat/224-x', base: 'release/next' };
    },
    finishWorktree: async (_repo, _wt, outcome) => {
      calls.push(`finish:${outcome}`);
      return outcome === 'pr_opened';
    },
    makeHarness: () => harness,
    createPr: async () => {
      calls.push('pr');
      return { number: 9, url: 'https://github.com/o/r/pull/9' };
    },
    comment: async () => {},
    runTests: async () => ({ passed: true, output: '' }),
    listCommits: async () => [],
    ...opts.ops,
  };
  const db = openDb(':memory:');
  const run = () =>
    runPbi({
      issue: 224,
      repo: dir,
      harness: 'claude',
      dryRun: opts.dryRun,
      db,
      emit: (e) => events.push(e),
      ops,
    });
  return { run, events, calls, db, started: () => harnessStarted };
}

const done = { status: 'done', summary: 'ok' };
const clean = { blocking: [], notes: [] };

describe('parsing', () => {
  it('reads the acceptance criteria section', () => {
    expect(acceptanceCriteria(issue.body)).toBe('- [ ] a\n- [ ] b');
    expect(acceptanceCriteria('no section')).toBe('');
    expect(acceptanceCriteria('## Acceptance Criteria\n- [ ] last')).toBe('- [ ] last');
  });

  it('takes branch type and title from the issue title', () => {
    expect(parseTitle('[PBI] fix: broken x')).toEqual({ type: 'fix', title: 'broken x' });
    expect(parseTitle('chore(ci): bump')).toEqual({ type: 'chore', title: 'bump' });
    expect(parseTitle('plain title')).toEqual({ type: 'feat', title: 'plain title' });
  });
});

describe('runPbi', () => {
  it('opens the PR: header first, claim released, worktree removed', async () => {
    const s = setup([done, clean]);
    expect(await s.run()).toBe(EXIT_DONE);
    expect(s.events[0]).toMatchObject({
      type: 'run.header',
      issue: 224,
      repo: 'o/r',
      dryRun: false,
      harness: { name: 'claude', version: '1.2.3' },
      models: { implementer: 'sonnet', reviewer: 'sonnet', planner: 'opus' },
    });
    expect(s.events.at(-1)).toMatchObject({
      type: 'run.finished',
      outcome: 'pr_opened',
      pr: { number: 9, draft: false },
    });
    expect(s.calls).toEqual(['claim', 'worktree', 'pr', 'release', 'finish:pr_opened']);
  });

  it('stores phase events with the run id', async () => {
    const s = setup([done, clean]);
    await s.run();
    const stored = s.db.queryEvents({ issue: 224, limit: 50 }).events;
    expect(stored.map((e) => e.kind)).toEqual([
      'phase.started',
      'phase.finished',
      'phase.started',
      'phase.finished',
    ]);
    expect(stored[0]?.runId).toMatch(/^pbi-224-/);
  });

  it('exits 1 and keeps the worktree when the run is blocked', async () => {
    const s = setup([{ status: 'failed', summary: 'cannot' }]);
    expect(await s.run()).toBe(EXIT_BLOCKED);
    expect(s.events.at(-1)).toMatchObject({ outcome: 'blocked' });
    expect(s.calls).toEqual(['claim', 'worktree', 'release', 'finish:blocked']);
  });

  it('exits 1 when an open issue blocks the PBI, before any claim', async () => {
    const blocked = { ...issue, blockedBy: [{ number: 5, title: 't', state: 'OPEN' }] };
    const s = setup([], { issue: blocked });
    expect(await s.run()).toBe(EXIT_BLOCKED);
    expect(s.events.at(-1)).toMatchObject({ outcome: 'blocked', reason: 'blocked by #5' });
    expect(s.calls).toEqual([]);
  });

  it('exits 1 on an existing claim without --force', async () => {
    const s = setup([], {
      ops: {
        claimIssue: async () => {
          throw new ClaimError('already carries in-progress');
        },
      },
    });
    expect(await s.run()).toBe(EXIT_BLOCKED);
    expect(s.calls).toEqual([]);
  });

  it('exits 3 on an unexpected error and releases the claim', async () => {
    const s = setup([], {
      ops: {
        openWorktree: async () => {
          throw new Error('git exploded');
        },
      },
    });
    expect(await s.run()).toBe(EXIT_ERROR);
    expect(s.events.at(-1)).toMatchObject({ outcome: 'error', reason: 'git exploded' });
    expect(s.calls).toEqual(['claim', 'release']);
  });

  it('exits 3 when the issue cannot be read', async () => {
    const s = setup([], {
      ops: {
        readIssue: async () => {
          throw new Error('gh: not found');
        },
      },
    });
    expect(await s.run()).toBe(EXIT_ERROR);
    expect(s.events[0]?.type).toBe('run.header');
  });

  it('dry run lists the steps without a harness, claim, worktree or PR', async () => {
    const withTasks: RunnerIssue = {
      ...issue,
      subIssues: [
        { number: 230, title: 'closed one', state: 'CLOSED' },
        { number: 231, title: 'task one', state: 'OPEN' },
      ],
    };
    const s = setup([], {
      dryRun: true,
      issue: withTasks,
      ops: {
        readIssue: async (_slug, nr) =>
          nr === 224 ? withTasks : { ...issue, number: nr, title: 'task one', subIssues: [] },
      },
    });
    expect(await s.run()).toBe(EXIT_DONE);
    expect(s.started()).toBe(0);
    expect(s.calls).toEqual([]);
    expect(s.events[0]).toMatchObject({ type: 'run.header', dryRun: true });
    const steps = s.events
      .filter((e) => e.type === 'run.step')
      .map((e) => (e as { step: string }).step);
    expect(steps.some((t) => t.includes('Task #231'))).toBe(true);
    expect(steps.some((t) => t.includes('#230'))).toBe(false);
    expect(s.events.at(-1)).toMatchObject({ type: 'run.finished', outcome: 'dry_run' });
  });
});
