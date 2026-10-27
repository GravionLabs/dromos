import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import type { IssueRef, RunnerIssue } from './github.js';
import {
  collectStatus,
  formatStatus,
  lastRun,
  levelOf,
  type PrRef,
  prFor,
  type StatusOps,
} from './status.js';

const ref = (number: number, title: string, state = 'open'): IssueRef => ({ number, title, state });

function issue(number: number, title: string, extra: Partial<RunnerIssue> = {}): RunnerIssue {
  return { number, title, body: '', labels: [], subIssues: [], blockedBy: [], ...extra };
}

function fakeOps(issues: RunnerIssue[], prs: PrRef[] = []): StatusOps {
  const store = new Map(issues.map((i) => [i.number, i]));
  return {
    readIssue: async (_slug, n) => {
      const found = store.get(n);
      if (!found) throw new Error(`no issue #${String(n)}`);
      return found;
    },
    issueState: async () => 'OPEN',
    listPrs: async () => prs,
  };
}

const pr = (number: number, head: string, state = 'open'): PrRef => ({
  number,
  url: `https://github.com/o/r/pull/${String(number)}`,
  state,
  head,
});

describe('levelOf', () => {
  it('reads the [Level] prefix', () => {
    expect(levelOf('[Epic] e')).toBe('Epic');
    expect(levelOf('[PBI] feat: x')).toBe('PBI');
    expect(levelOf('feat: plain')).toBe('issue');
  });
});

describe('prFor', () => {
  it('takes the newest PR of a <type>/<nr>-<slug> branch and ignores other numbers', () => {
    const prs = [pr(5, 'feat/12-a', 'closed'), pr(9, 'fix/12-b', 'merged'), pr(7, 'feat/123-c')];
    expect(prFor(prs, 12)).toEqual({
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      state: 'merged',
    });
    expect(prFor(prs, 1)).toBeNull();
  });
});

describe('lastRun', () => {
  it('builds the header of the newest run from its phase events', () => {
    const db = openDb(':memory:');
    const harness = { name: 'claude', version: '2.1', sdk: null };
    const phase = (kind: string, runId: string, data: object) =>
      db.insertEvent(
        'dromos',
        kind,
        { harness, durationMs: 1, usage: null, ...data },
        { issue: 7, runId },
      );
    phase('phase.started', 'pbi-7-a', { phase: 'implementer', model: 'sonnet' });
    phase('phase.started', 'pbi-7-b', { phase: 'implementer', model: 'sonnet' });
    phase('phase.finished', 'pbi-7-b', { phase: 'implementer', model: 'sonnet' });
    phase('phase.started', 'pbi-7-b', { phase: 'reviewer', model: 'opus' });
    phase('phase.failed', 'pbi-7-b', { phase: 'reviewer', model: 'opus' });
    const run = lastRun(db, 7);
    expect(run).toMatchObject({
      runId: 'pbi-7-b',
      harness,
      models: { implementer: 'sonnet', reviewer: 'opus' },
      last: 'reviewer failed',
    });
    expect(lastRun(db, 8)).toBeNull();
  });
});

describe('collectStatus', () => {
  it('lists an Epic, its Features and their PBIs with labels, blockers and PRs', async () => {
    const ops = fakeOps(
      [
        issue(1, '[Epic] e', {
          subIssues: [ref(10, '[Feature] f'), ref(20, '[Feature] g', 'closed')],
        }),
        issue(10, '[Feature] f', {
          labels: ['approved', 'bug'],
          subIssues: [ref(11, '[PBI] a'), ref(12, '[PBI] b')],
        }),
        issue(11, '[PBI] a', { labels: ['in-progress'] }),
        issue(12, '[PBI] b', {
          labels: ['needs-approval', 'needs-decision'],
          blockedBy: [ref(11, '[PBI] a'), ref(3, 'done', 'closed')],
        }),
        issue(20, '[Feature] g'),
      ],
      [pr(30, 'feat/11-a', 'draft')],
    );
    const status = await collectStatus('o/r', 1, { ops });
    expect(status.rows.map((r) => [r.number, r.depth, r.level, r.state])).toEqual([
      [1, 0, 'Epic', 'open'],
      [10, 1, 'Feature', 'open'],
      [11, 2, 'PBI', 'open'],
      [12, 2, 'PBI', 'open'],
      [20, 1, 'Feature', 'closed'],
    ]);
    const byNr = new Map(status.rows.map((r) => [r.number, r]));
    expect(byNr.get(10)?.labels).toEqual(['approved']);
    expect(byNr.get(11)?.pr).toEqual({
      number: 30,
      url: 'https://github.com/o/r/pull/30',
      state: 'draft',
    });
    expect(byNr.get(12)).toMatchObject({
      labels: ['needs-approval', 'needs-decision'],
      blockedBy: [11],
    });
    expect(byNr.get(12)?.lastRun).toBeNull();
  });

  it('lists the Tasks of a PBI but not their children', async () => {
    const ops = fakeOps([
      issue(5, '[PBI] p', { subIssues: [ref(6, '[Task] t')] }),
      issue(6, '[Task] t', { subIssues: [ref(99, 'deeper')] }),
    ]);
    const status = await collectStatus('o/r', 5, { ops });
    expect(status.rows.map((r) => r.number)).toEqual([5, 6]);
  });
});

describe('formatStatus', () => {
  it('aligns the columns, indents children and strips control characters from titles', async () => {
    const ops = fakeOps(
      [
        issue(10, '[Feature] f', { subIssues: [ref(11, '[PBI] a')] }),
        issue(11, '[PBI] \u001b[31mred\u001b[0m\u0007', { labels: ['approved'] }),
      ],
      [pr(30, 'feat/11-a', 'merged')],
    );
    const text = formatStatus(await collectStatus('o/r', 10, { ops }));
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toMatch(
      /^issue\s+level\s+state\s+labels\s+blocked by\s+pr\s+last run\s+title$/,
    );
    expect(lines[2]).toMatch(
      /^ {2}#11\s+PBI\s+open\s+approved\s+-\s+#30 merged\s+-\s+\[PBI\] red$/,
    );
    expect(text).not.toContain('\u001b');
  });
});
