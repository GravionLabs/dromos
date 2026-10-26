import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusEvents } from './bus-events.js';
import { type Db, openDb } from './db.js';
import { startNoticeSweep, sweepNotices } from './notice-sweep.js';
import type { Role } from './schemas.js';

const lines: string[] = [];
const log = { logLine: (_k: 'ERROR', t: string) => void lines.push(t) };

describe('notice sweep', () => {
  let db: Db;
  let events: BusEvents;
  let published: number[];
  beforeEach(() => {
    db = openDb(':memory:');
    events = new BusEvents();
    published = [];
    events.onEvent((e) => published.push(e.id));
    lines.length = 0;
    db.insertRun({
      id: 'run-7',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 7,
      issueTitle: 'T',
      baseBranch: 'main',
      branch: 'b',
      worktreePath: '/wt',
      state: 'implementing',
      round: 1,
    });
  });
  afterEach(() => db.close());

  const notice = (to: Role = 'orchestrator', payload: unknown = { reason: 'needs input' }) =>
    db.insertMessage({ from: 'implementer', to, type: 'notice', runId: 'run-7', payload });
  const at = (m: { createdAt: string }, ms: number) => () => Date.parse(m.createdAt) + ms;
  const questions = () => db.listAttention({ limit: 50 }).filter((a) => a.kind === 'QUESTION');

  it('raises nothing at 59 s and exactly one QUESTION at 60 s', async () => {
    const m = notice();
    await sweepNotices(db, events, log, { now: at(m, 59_000) });
    expect(questions()).toHaveLength(0);
    await sweepNotices(db, events, log, { now: at(m, 60_000) });
    const [q] = questions();
    expect(questions()).toHaveLength(1);
    expect(q).toMatchObject({ summary: 'needs input', issue: 7, runId: 'run-7', state: 'open' });
    expect(published).toEqual([q?.id]);
  });

  it('does not raise twice across sweeps or a restarted sweep', async () => {
    const m = notice();
    await sweepNotices(db, events, log, { now: at(m, 61_000) });
    await sweepNotices(db, events, log, { now: at(m, 120_000) });
    await sweepNotices(db, events, log, { now: at(m, 180_000) });
    expect(questions()).toHaveLength(1);
  });

  it('ignores acked notices and notices to other roles', async () => {
    const acked = notice();
    db.ackMessage(acked.id, 'orchestrator');
    const other = notice('reviewer');
    await sweepNotices(db, events, log, { now: at(other, 90_000) });
    expect(db.listAttention({ limit: 50 })).toHaveLength(0);
  });

  it('skips notices of a run that already raised a BLOCKED attention', async () => {
    const m = notice();
    const ev = db.insertEvent(
      'dromos',
      'attention',
      { kind: 'BLOCKED', summary: 's', pr: null },
      { issue: 7, runId: 'run-7' },
    );
    db.insertAttention(ev);
    await sweepNotices(db, events, log, { now: at(m, 90_000) });
    expect(questions()).toHaveLength(0);
  });

  it('does not raise for a notice the orchestrator addressed to itself', async () => {
    const m = db.insertMessage({
      from: 'orchestrator',
      to: 'orchestrator',
      type: 'notice',
      runId: 'run-7',
      payload: { event: 'pr_opened' },
    });
    await sweepNotices(db, events, log, { now: at(m, 90_000) });
    expect(db.listAttention({ limit: 50 })).toHaveLength(0);
  });

  it('raises a QUESTION without issue for a notice without a run', async () => {
    const m = db.insertMessage({
      from: 'implementer',
      to: 'orchestrator',
      type: 'notice',
      payload: { reason: 'no run' },
    });
    await sweepNotices(db, events, log, { now: at(m, 61_000) });
    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({ issue: null, runId: null, summary: 'no run' });
  });

  it('still raises when the run only has a QUESTION attention', async () => {
    const first = notice();
    await sweepNotices(db, events, log, { now: at(first, 61_000) });
    const second = notice('orchestrator', { reason: 'again' });
    await sweepNotices(db, events, log, { now: at(second, 61_000) });
    expect(questions().map((q) => q.summary)).toEqual(['needs input', 'again']);
  });

  it('ignores messages of other types', async () => {
    const m = db.insertMessage({
      from: 'implementer',
      to: 'orchestrator',
      type: 'gate_result',
      runId: 'run-7',
      payload: {},
    });
    await sweepNotices(db, events, log, { now: at(m, 90_000) });
    expect(db.listAttention({ limit: 50 })).toHaveLength(0);
  });

  it('stops mid-sweep when isStopped turns true', async () => {
    const m = notice();
    notice();
    let calls = 0;
    await sweepNotices(db, events, log, {
      now: at(m, 90_000),
      isStopped: () => ++calls > 1,
    });
    expect(questions()).toHaveLength(1);
  });

  it('uses the event name when there is no reason and strips forbidden characters', async () => {
    const m = notice('orchestrator', { event: 'appr\u0000oved' });
    await sweepNotices(db, events, log, { now: at(m, 61_000) });
    expect(questions()[0]?.summary).toBe('appr oved');
  });

  it('truncates a long reason to 2000 characters', async () => {
    const m = notice('orchestrator', { reason: 'x'.repeat(5000) });
    await sweepNotices(db, events, log, { now: at(m, 61_000) });
    expect(questions()[0]?.summary).toHaveLength(2000);
  });

  it('leaves the message eligible and logs when the attention insert fails', async () => {
    const m = notice();
    const spy = vi.spyOn(db, 'insertAttention').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await sweepNotices(db, events, log, { now: at(m, 61_000) });
    expect(spy).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('boom');
    expect(db.listAttention({ limit: 50 })).toHaveLength(0);
    await sweepNotices(db, events, log, { now: at(m, 62_000) });
    expect(questions()).toHaveLength(1);
  });

  it('logs a failing query as ERROR and keeps the timer running', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(db, 'listStaleOrchestratorNotices').mockImplementation(() => {
        throw new Error('db gone');
      });
      const stop = startNoticeSweep(db, events, log, { intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(2500);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(lines.filter((l) => l.includes('db gone'))).toHaveLength(2);
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
