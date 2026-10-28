import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusEvents } from './bus-events.js';
import { type Db, type EventRecord, openDb } from './db.js';
import { EventValidationError } from './event-store.js';
import { publishRows, recordRunTransition } from './run-events.js';

const run = { id: 'run-7-1', issueNumber: 7 };

describe('recordRunTransition', () => {
  let db: Db;

  const kinds = () => db.listEventsSince(0).map((e) => e.kind);

  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('records run.state and the initial attempt for a new run', () => {
    const rows = recordRunTransition(db, run, null, { state: 'implementing', round: 1 });
    expect(rows.map((r) => r.kind)).toEqual(['run.state', 'attempt.started']);
    expect(rows[0]).toMatchObject({
      role: 'dromos',
      agentId: null,
      issue: 7,
      runId: 'run-7-1',
      data: { state: 'implementing', round: 1, previous: null },
    });
    expect(rows[1]?.data).toEqual({ n: 1, cause: 'initial', startedAt: expect.any(String) });
    expect(db.listEventsSince(0)).toEqual(rows);
  });

  it('records only run.state for a transition without a settlement', () => {
    const rows = recordRunTransition(
      db,
      run,
      { state: 'implementing', round: 1 },
      { state: 'gating', round: 1 },
    );
    expect(rows.map((r) => r.data)).toEqual([
      { state: 'gating', round: 1, previous: 'implementing' },
    ]);
  });

  it('settles the open attempt and starts the next one on a retry', () => {
    const [, started] = recordRunTransition(db, run, null, { state: 'implementing', round: 1 });
    const startedAt = (started?.data as { startedAt: string } | undefined)?.startedAt;
    const rows = recordRunTransition(
      db,
      run,
      { state: 'gating', round: 1 },
      { state: 'implementing', round: 2 },
      { outcome: 'gate_failed', evidence: 'verified' },
    );
    expect(rows.map((r) => r.kind)).toEqual(['run.state', 'attempt.settled', 'attempt.started']);
    expect(rows[1]?.data).toEqual({
      n: 1,
      cause: 'initial',
      startedAt,
      endedAt: expect.any(String),
      outcome: 'gate_failed',
      evidence: 'verified',
    });
    expect(rows[2]?.data).toMatchObject({ n: 2, cause: 'gate_failed' });
  });

  it('settles without a new attempt when the run is blocked or approved', () => {
    recordRunTransition(db, run, null, { state: 'implementing', round: 1 });
    const blocked = recordRunTransition(
      db,
      run,
      { state: 'gating', round: 3 },
      { state: 'blocked', round: 4 },
      { outcome: 'blocked', evidence: 'verified' },
    );
    expect(blocked.map((r) => r.kind)).toEqual(['run.state', 'attempt.settled']);
    expect(blocked[1]?.data).toMatchObject({ n: 1, outcome: 'blocked' });
  });

  it('ignores attempts of other runs of the same issue', () => {
    recordRunTransition(db, { id: 'run-7-0', issueNumber: 7 }, null, {
      state: 'implementing',
      round: 1,
    });
    recordRunTransition(
      db,
      { id: 'run-7-0', issueNumber: 7 },
      { state: 'reviewing', round: 1 },
      { state: 'implementing', round: 2 },
      { outcome: 'sent_back', evidence: 'reported' },
    );
    recordRunTransition(db, run, null, { state: 'implementing', round: 1 });
    const rows = recordRunTransition(
      db,
      run,
      { state: 'reviewing', round: 1 },
      { state: 'implementing', round: 2 },
      { outcome: 'sent_back', evidence: 'reported' },
    );
    expect(rows[1]?.data).toMatchObject({ n: 1, cause: 'initial', outcome: 'sent_back' });
    expect(rows[2]?.data).toMatchObject({ n: 2, cause: 'sent_back' });
  });

  it('starts the attempt at the round for a run that has no recorded attempt', () => {
    const rows = recordRunTransition(
      db,
      run,
      { state: 'gating', round: 2 },
      { state: 'implementing', round: 3 },
      { outcome: 'gate_failed', evidence: 'verified' },
    );
    expect(rows.map((r) => r.kind)).toEqual(['run.state', 'attempt.started']);
    expect(rows[1]?.data).toMatchObject({ n: 3, cause: 'gate_failed' });
  });

  it('throws EventValidationError and stores nothing for an invalid event', () => {
    expect(() =>
      recordRunTransition(db, { id: 'x'.repeat(129), issueNumber: 7 }, null, {
        state: 'implementing',
        round: 1,
      }),
    ).toThrow(EventValidationError);
    expect(kinds()).toEqual([]);
  });

  it('rolls back the run update together with the events inside a transaction', () => {
    db.insertRun({
      id: 'run-7-1',
      repo: 'o/r',
      repoPath: '/repo',
      issueNumber: 7,
      issueTitle: 'T',
      baseBranch: 'main',
      branch: 'b',
      worktreePath: '/wt',
      state: 'gating',
      round: 1,
    });
    recordRunTransition(db, run, null, { state: 'implementing', round: 1 });
    expect(() =>
      db.transaction(() => {
        db.updateRun('run-7-1', { state: 'implementing', round: 2 });
        // Round 0 violates the run.state schema, so the transaction throws after updateRun.
        recordRunTransition(
          db,
          run,
          { state: 'gating', round: 1 },
          { state: 'implementing', round: 0 },
          { outcome: 'gate_failed', evidence: 'verified' },
        );
      }),
    ).toThrow(EventValidationError);
    expect(db.getRun('run-7-1')).toMatchObject({ state: 'gating', round: 1 });
    expect(kinds()).toEqual(['run.state', 'attempt.started']);
  });
});

describe('publishRows', () => {
  it('publishes every row in order', () => {
    const events = new BusEvents();
    const seen: number[] = [];
    events.onEvent((e) => seen.push(e.id));
    const row = (id: number): EventRecord => ({
      id,
      role: 'dromos',
      kind: 'run.state',
      data: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      agentId: null,
      issue: 1,
      runId: 'r',
      repo: null,
    });
    publishRows(events, [row(3), row(4)]);
    expect(seen).toEqual([3, 4]);
  });

  it('publishes nothing for no rows', () => {
    const events = new BusEvents();
    const seen: number[] = [];
    events.onEvent((e) => seen.push(e.id));
    publishRows(events, []);
    expect(seen).toEqual([]);
  });
});
