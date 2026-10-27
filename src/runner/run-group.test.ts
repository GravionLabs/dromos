import { describe, expect, it } from 'vitest';
import type { IssueRef, RunnerIssue } from './github.js';
import {
  dependencyOrder,
  EXIT_INTERRUPTED,
  type RunGroupEvent,
  type RunGroupOps,
  runGroup,
  skipReason,
} from './run-group.js';
import { EXIT_BLOCKED, EXIT_DONE, EXIT_ERROR } from './run-pbi.js';

const ref = (number: number, title: string, state = 'OPEN'): IssueRef => ({ number, title, state });

function issue(number: number, title: string, extra: Partial<RunnerIssue> = {}): RunnerIssue {
  return { number, title, body: '', labels: [], subIssues: [], blockedBy: [], ...extra };
}

/** A fake GitHub: issues by number, mutated by the fake plan and PBI runs. */
interface Fake {
  store: Map<number, RunnerIssue>;
  calls: string[];
  controller: AbortController;
}

function setup(issues: RunnerIssue[], override: (fake: Fake) => Partial<RunGroupOps> = () => ({})) {
  const store = new Map(issues.map((i) => [i.number, i]));
  const events: RunGroupEvent[] = [];
  const calls: string[] = [];
  const controller = new AbortController();
  const ops = override({ store, calls, controller });
  const current: (number | null)[] = [];
  const run = (level: 'feature' | 'epic', nr: number, force = false) =>
    runGroup({
      level,
      issue: nr,
      repo: '/tmp/repo',
      force,
      emit: (e) => events.push(e),
      signal: controller.signal,
      onCurrent: (n) => current.push(n),
      ops: {
        repoSlug: async () => 'o/r',
        readIssue: async (_slug, n) => {
          const found = store.get(n);
          if (!found) throw new Error(`no issue #${String(n)}`);
          return found;
        },
        plan: async (n) => {
          calls.push(`plan ${String(n)}`);
          return EXIT_DONE;
        },
        runPbi: async (n) => {
          calls.push(`pbi ${String(n)}`);
          return EXIT_DONE;
        },
        ...ops,
      },
    });
  const report = () => {
    const last = events.at(-1);
    if (last?.type !== 'group.finished') throw new Error('no group.finished event');
    return last;
  };
  return { store, events, calls, controller, current, run, report };
}

describe('dependencyOrder', () => {
  it('puts blockers of the list first and keeps the input order otherwise', () => {
    const a = issue(1, '[PBI] a', { blockedBy: [ref(3, 'c')] });
    const b = issue(2, '[PBI] b');
    const c = issue(3, '[PBI] c', { blockedBy: [ref(99, 'outside')] });
    expect(dependencyOrder([a, b, c]).map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it('appends PBIs of a cycle in input order', () => {
    const a = issue(1, '[PBI] a', { blockedBy: [ref(2, 'b')] });
    const b = issue(2, '[PBI] b', { blockedBy: [ref(1, 'a')] });
    expect(dependencyOrder([a, b]).map((p) => p.number)).toEqual([1, 2]);
  });
});

describe('skipReason', () => {
  const feature = issue(10, '[Feature] f');
  it('needs approval on the PBI or its Feature', () => {
    expect(skipReason(issue(1, '[PBI] a'), feature, false)).toMatch(/not approved/);
    expect(skipReason(issue(1, '[PBI] a', { labels: ['approved'] }), feature, false)).toBeNull();
    expect(
      skipReason(issue(1, '[PBI] a'), issue(10, '[Feature] f', { labels: ['approved'] }), false),
    ).toBeNull();
  });

  it('skips claimed PBIs unless forced and PBIs with an open blocker', () => {
    const claimed = issue(1, '[PBI] a', { labels: ['approved', 'in-progress'] });
    expect(skipReason(claimed, feature, false)).toBe("claimed ('in-progress')");
    expect(skipReason(claimed, feature, true)).toBeNull();
    const blocked = issue(1, '[PBI] a', {
      labels: ['approved'],
      blockedBy: [ref(7, 'x'), ref(8, 'y', 'CLOSED')],
    });
    expect(skipReason(blocked, feature, false)).toBe('blocked by #7');
  });
});

describe('runGroup', () => {
  it('runs approved, unclaimed, unblocked PBIs of a Feature in dependency order', async () => {
    const t = setup([
      issue(10, '[Feature] feat: f', {
        labels: ['approved'],
        subIssues: [ref(11, '[PBI] a'), ref(12, '[PBI] b'), ref(13, '[PBI] done', 'CLOSED')],
      }),
      issue(11, '[PBI] a', { blockedBy: [ref(12, '[PBI] b', 'CLOSED')] }),
      issue(12, '[PBI] b'),
    ]);
    expect(await t.run('feature', 10)).toBe(EXIT_DONE);
    expect(t.calls).toEqual(['pbi 12', 'pbi 11']);
    expect(t.current).toEqual([12, null, 11, null]);
    expect(t.report()).toMatchObject({
      outcome: 'done',
      ran: [
        { issue: 12, code: 0 },
        { issue: 11, code: 0 },
      ],
      skipped: [],
    });
  });

  it('skips and reports unapproved, claimed and blocked PBIs without waiting', async () => {
    const t = setup([
      issue(10, '[Feature] feat: f', {
        subIssues: [ref(11, '[PBI] a'), ref(12, '[PBI] b'), ref(13, '[PBI] c'), ref(14, '[PBI] d')],
      }),
      issue(11, '[PBI] a', { labels: ['needs-approval'] }),
      issue(12, '[PBI] b', { labels: ['approved', 'in-progress'] }),
      issue(13, '[PBI] c', { labels: ['approved'], blockedBy: [ref(99, 'other')] }),
      issue(14, '[PBI] d', { labels: ['approved'] }),
    ]);
    expect(await t.run('feature', 10)).toBe(EXIT_DONE);
    expect(t.calls).toEqual(['pbi 14']);
    expect(t.report().skipped.map((s) => [s.issue, s.reason])).toEqual([
      [11, expect.stringMatching(/not approved/)],
      [12, "claimed ('in-progress')"],
      [13, 'blocked by #99'],
    ]);
  });

  it('re-reads a PBI before it runs: one blocked by a PBI of this run stays skipped', async () => {
    const t = setup([
      issue(10, '[Feature] f', {
        labels: ['approved'],
        subIssues: [ref(11, '[PBI] a'), ref(12, '[PBI] b')],
      }),
      issue(11, '[PBI] a'),
      issue(12, '[PBI] b', { blockedBy: [ref(11, '[PBI] a')] }),
    ]);
    expect(await t.run('feature', 10)).toBe(EXIT_DONE);
    expect(t.calls).toEqual(['pbi 11']);
    expect(t.report().skipped).toEqual([{ issue: 12, title: '[PBI] b', reason: 'blocked by #11' }]);
  });

  it('plans an Epic Feature without PBIs and reports the new, unapproved PBIs', async () => {
    const t = setup(
      [
        issue(1, '[Epic] e', {
          subIssues: [
            ref(10, '[Feature] f'),
            ref(20, '[Feature] g'),
            ref(30, '[Feature] old', 'CLOSED'),
          ],
        }),
        issue(10, '[Feature] f'),
        issue(20, '[Feature] g', { labels: ['approved'], subIssues: [ref(21, '[PBI] x')] }),
        issue(21, '[PBI] x'),
      ],
      ({ store, calls }) => ({
        plan: async (n) => {
          calls.push(`plan ${String(n)}`);
          store.set(n, issue(n, '[Feature] f', { subIssues: [ref(15, '[PBI] new')] }));
          store.set(15, issue(15, '[PBI] new', { labels: ['needs-approval'] }));
          return EXIT_DONE;
        },
      }),
    );
    expect(await t.run('epic', 1)).toBe(EXIT_DONE);
    expect(t.calls).toEqual(['plan 10', 'pbi 21']);
    expect(t.report().skipped).toEqual([
      { issue: 15, title: '[PBI] new', reason: expect.stringMatching(/not approved/) },
    ]);
  });

  it('skips a Feature whose planner questions are open and never prompts', async () => {
    const t = setup([issue(10, '[Feature] f')], () => ({ plan: async () => 2 }));
    expect(await t.run('feature', 10)).toBe(EXIT_DONE);
    expect(t.report()).toMatchObject({
      outcome: 'done',
      ran: [],
      skipped: [{ issue: 10, reason: 'planner questions open (needs-decision)' }],
    });
  });

  it('exits 1 when a PBI run is blocked', async () => {
    const t = setup(
      [
        issue(10, '[Feature] f', { labels: ['approved'], subIssues: [ref(11, '[PBI] a')] }),
        issue(11, '[PBI] a'),
      ],
      () => ({ runPbi: async () => EXIT_BLOCKED }),
    );
    expect(await t.run('feature', 10)).toBe(EXIT_BLOCKED);
    expect(t.report().ran).toEqual([{ issue: 11, title: '[PBI] a', code: EXIT_BLOCKED }]);
  });

  it('starts no further PBI after Ctrl-C and reports the run as interrupted', async () => {
    const t = setup(
      [
        issue(10, '[Feature] f', {
          labels: ['approved'],
          subIssues: [ref(11, '[PBI] a'), ref(12, '[PBI] b')],
        }),
        issue(11, '[PBI] a'),
        issue(12, '[PBI] b'),
      ],
      ({ calls, controller }) => ({
        runPbi: async (n) => {
          calls.push(`pbi ${String(n)}`);
          controller.abort();
          return EXIT_ERROR;
        },
      }),
    );
    expect(await t.run('feature', 10)).toBe(EXIT_INTERRUPTED);
    expect(t.calls).toEqual(['pbi 11']);
    expect(t.report()).toMatchObject({ outcome: 'interrupted', ran: [{ issue: 11 }] });
  });

  it('refuses an issue of the wrong level', async () => {
    const t = setup([issue(10, '[PBI] not a feature')]);
    expect(await t.run('feature', 10)).toBe(EXIT_ERROR);
    expect(t.report()).toMatchObject({
      outcome: 'error',
      reason: "#10 is not a Feature: '[PBI] not a feature'",
    });
    expect(await t.run('epic', 10)).toBe(EXIT_ERROR);
  });

  it('runs PBIs directly under an Epic with the Epic as their approval', async () => {
    const t = setup([
      issue(1, '[Epic] e', { labels: ['approved'], subIssues: [ref(5, '[PBI] direct')] }),
      issue(5, '[PBI] direct'),
    ]);
    expect(await t.run('epic', 1)).toBe(EXIT_DONE);
    expect(t.calls).toEqual(['pbi 5']);
  });
});
