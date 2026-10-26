import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db, MIGRATIONS, type NewRun, openDb } from './db.js';

const newRun = (overrides: Partial<NewRun> = {}): NewRun => ({
  id: 'run-1-1',
  repo: 'GravionLabs/demo',
  repoPath: '/work/demo',
  issueNumber: 1,
  issueTitle: 'Do the thing',
  baseBranch: 'main',
  branch: 'agent/1-do-the-thing',
  worktreePath: '/work/wt-demo-1',
  ...overrides,
});

describe('db', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('migrations 7 and 8', () => {
    it('add attention_raised_at and last_output_at to a version-6 database and keep its rows', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dromos-db-'));
      try {
        const file = join(dir, 'bus.db');
        const raw = new Database(file);
        for (const sql of MIGRATIONS.slice(0, 6)) raw.exec(sql);
        raw.pragma('user_version = 6');
        raw
          .prepare(
            `INSERT INTO agents (id, role, cli, state, created_at, updated_at)
             VALUES ('a1', 'implementer', 'claude', 'idle', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          )
          .run();
        raw.close();
        const migrated = openDb(file);
        expect(migrated.schemaVersion()).toBe(8);
        expect(migrated.getAgent('a1')?.lastOutputAt).toBeNull();
        migrated.close();
        const check = new Database(file, { readonly: true });
        const cols = (table: string) =>
          (check.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
            (c) => c.name,
          );
        expect(cols('messages')).toContain('attention_raised_at');
        expect(cols('agents')).toContain('last_output_at');
        check.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('touchAgentOutput', () => {
    it('moves last_output_at forward only', () => {
      db.insertAgent({ id: 'a1', role: 'implementer', cli: 'claude' });
      db.touchAgentOutput('a1', '2026-01-02T00:00:00.000Z');
      db.touchAgentOutput('a1', '2026-01-01T00:00:00.000Z');
      expect(db.getAgent('a1')?.lastOutputAt).toBe('2026-01-02T00:00:00.000Z');
      db.touchAgentOutput('a1', '2026-01-03T00:00:00.000Z');
      expect(db.getAgent('a1')?.lastOutputAt).toBe('2026-01-03T00:00:00.000Z');
    });
  });

  describe('stale orchestrator notices', () => {
    const notice = (
      over: { from?: 'implementer' | 'orchestrator'; to?: 'orchestrator' | 'reviewer' } = {},
    ) =>
      db.insertMessage({
        from: over.from ?? 'implementer',
        to: over.to ?? 'orchestrator',
        type: 'notice',
        payload: {},
      });
    const future = '9999-01-01T00:00:00.000Z';

    it('lists unacked notices to the orchestrator up to the cutoff, oldest first', () => {
      const a = notice();
      const b = notice();
      expect(db.listStaleOrchestratorNotices('2000-01-01T00:00:00.000Z')).toEqual([]);
      expect(db.listStaleOrchestratorNotices(future).map((m) => m.id)).toEqual([a.id, b.id]);
      expect(db.listStaleOrchestratorNotices(future, 1).map((m) => m.id)).toEqual([a.id]);
    });

    it('excludes acked, marked, self-addressed and other-role notices', () => {
      const acked = notice();
      db.ackMessage(acked.id, 'orchestrator');
      const marked = notice();
      expect(db.markNoticeAttentionRaised(marked.id)).toBe(true);
      expect(db.markNoticeAttentionRaised(marked.id)).toBe(false);
      notice({ from: 'orchestrator' });
      notice({ to: 'reviewer' });
      expect(db.listStaleOrchestratorNotices(future)).toEqual([]);
    });
  });

  describe('migration 5', () => {
    it('adds both event indexes to a version-4 database and keeps its rows', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dromos-db-'));
      try {
        const file = join(dir, 'bus.db');
        const raw = new Database(file);
        for (const sql of MIGRATIONS.slice(0, 4)) raw.exec(sql);
        raw.pragma('user_version = 4');
        raw
          .prepare(
            `INSERT INTO events (role, kind, data_json, created_at, issue)
             VALUES ('implementer', 'hook:idle', '{}', '2026-01-01T00:00:00Z', 7)`,
          )
          .run();
        raw.close();

        const migrated = openDb(file);
        expect(MIGRATIONS).toHaveLength(8);
        expect(migrated.schemaVersion()).toBe(8);
        expect(migrated.queryEvents({ issue: 7, limit: 10 }).events).toHaveLength(1);
        migrated.close();

        const check = new Database(file, { readonly: true });
        const names = (
          check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
        check.close();
        expect(names).toContain('idx_events_issue_id');
        expect(names).toContain('idx_events_kind_id');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('migration 4', () => {
    it('adds last_summary and keeps version-3 runs with a null summary', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dromos-db-'));
      try {
        const file = join(dir, 'bus.db');
        const raw = new Database(file);
        for (const sql of MIGRATIONS.slice(0, 3)) raw.exec(sql);
        raw.pragma('user_version = 3');
        raw
          .prepare(
            `INSERT INTO runs (id, repo, repo_path, issue_number, issue_title, base_branch, branch,
               worktree_path, state, round, created_at, updated_at)
             VALUES ('old', 'o/r', '/r', 1, 't', 'main', 'b', '/w', 'implementing', 1,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          )
          .run();
        raw.close();

        const migrated = openDb(file);
        expect(migrated.schemaVersion()).toBe(MIGRATIONS.length);
        expect(migrated.getRun('old')?.lastSummary).toBeNull();
        expect(migrated.updateRun('old', { lastSummary: 'x' })?.lastSummary).toBe('x');
        expect(migrated.getRun('old')?.lastSummary).toBe('x');
        migrated.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('migration 3', () => {
    it('keeps version-2 event rows and adds nullable agent_id, issue and run_id', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dromos-db-'));
      try {
        const file = join(dir, 'bus.db');
        const raw = new Database(file);
        raw.exec(MIGRATIONS[0] as string);
        raw.exec(MIGRATIONS[1] as string);
        raw.pragma('user_version = 2');
        raw
          .prepare(
            `INSERT INTO events (role, kind, data_json, created_at)
             VALUES ('implementer', 'hook:idle', '{"a":1}', '2026-01-01T00:00:00Z')`,
          )
          .run();
        raw.close();

        const migrated = openDb(file);
        expect(migrated.schemaVersion()).toBe(MIGRATIONS.length);
        expect(migrated.listEvents()).toEqual([
          {
            id: 1,
            role: 'implementer',
            kind: 'hook:idle',
            data: { a: 1 },
            createdAt: '2026-01-01T00:00:00Z',
            agentId: null,
            issue: null,
            runId: null,
          },
        ]);
        migrated.close();

        // Reopening applies nothing twice and keeps the row.
        const again = openDb(file);
        expect(again.listEvents()).toHaveLength(1);
        again.close();

        const check = new Database(file, { readonly: true });
        const columns = check.prepare('PRAGMA table_info(events)').all() as {
          name: string;
          notnull: number;
        }[];
        check.close();
        for (const name of ['agent_id', 'issue', 'run_id']) {
          expect(columns.find((c) => c.name === name)?.notnull).toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('migration 2', () => {
    it('keeps version-1 rows and adds agents plus nullable message agent columns', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dromos-db-'));
      try {
        const file = join(dir, 'bus.db');
        const raw = new Database(file);
        raw.exec(MIGRATIONS[0] as string);
        raw.pragma('user_version = 1');
        raw
          .prepare(
            `INSERT INTO messages (from_role, to_role, type, payload_json, created_at)
             VALUES ('orchestrator', 'implementer', 'task', '{"a":1}', '2026-01-01T00:00:00Z')`,
          )
          .run();
        raw
          .prepare(
            `INSERT INTO events (role, kind, data_json, created_at)
             VALUES ('implementer', 'hook:idle', 'null', '2026-01-01T00:00:00Z')`,
          )
          .run();
        raw.close();

        const migrated = openDb(file);
        expect(migrated.schemaVersion()).toBe(MIGRATIONS.length);
        expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);
        const inbox = migrated.listUnacked('implementer');
        expect(inbox).toHaveLength(1);
        expect(inbox[0]?.payload).toEqual({ a: 1 });
        expect(migrated.listEvents()).toHaveLength(1);
        migrated.close();

        const check = new Database(file, { readonly: true });
        const columns = check.prepare('PRAGMA table_info(messages)').all() as {
          name: string;
          notnull: number;
        }[];
        check.close();
        for (const name of ['from_agent', 'to_agent']) {
          expect(columns.find((c) => c.name === name)?.notnull).toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('agents', () => {
    it('inserts with defaults and reads back', () => {
      const agent = db.insertAgent({ id: 'a-1', role: 'implementer', cli: 'claude' });
      expect(agent).toMatchObject({
        id: 'a-1',
        role: 'implementer',
        runId: null,
        cli: 'claude',
        model: null,
        paneId: null,
        state: 'idle',
      });
      expect(agent.createdAt).toBe(agent.updatedAt);
      expect(db.getAgent('a-1')).toEqual(agent);
    });

    it('returns undefined for an unknown agent', () => {
      expect(db.getAgent('nope')).toBeUndefined();
      expect(db.updateAgentState('nope', 'busy')).toBeUndefined();
    });

    it('rejects a duplicate id', () => {
      db.insertAgent({ id: 'a-1', role: 'reviewer', cli: 'claude' });
      expect(() => db.insertAgent({ id: 'a-1', role: 'reviewer', cli: 'claude' })).toThrow();
    });

    it('updates the state', () => {
      db.insertAgent({ id: 'a-1', role: 'reviewer', cli: 'claude' });
      expect(db.updateAgentState('a-1', 'exited')?.state).toBe('exited');
      expect(db.getAgent('a-1')?.state).toBe('exited');
    });

    it('sets the run id once and keeps the first', () => {
      db.insertRun(newRun());
      db.insertAgent({ id: 'a-1', role: 'orchestrator', cli: 'claude' });
      expect(db.setAgentRun('a-1', 'run-1-1')?.runId).toBe('run-1-1');
      db.insertRun({ ...newRun(), id: 'run-2-1' });
      expect(db.setAgentRun('a-1', 'run-2-1')?.runId).toBe('run-1-1');
      expect(db.setAgentRun('nope', 'run-1-1')).toBeUndefined();
    });

    it('lists with filters in creation order', () => {
      db.insertRun(newRun());
      db.insertAgent({ id: 'a-1', role: 'implementer', cli: 'claude', runId: 'run-1-1' });
      db.insertAgent({ id: 'a-2', role: 'reviewer', cli: 'codex', model: 'm', paneId: '%3' });
      db.insertAgent({ id: 'a-3', role: 'implementer', cli: 'claude', state: 'busy' });
      expect(db.listAgents().map((a) => a.id)).toEqual(['a-1', 'a-2', 'a-3']);
      expect(db.listAgents({ role: 'implementer' }).map((a) => a.id)).toEqual(['a-1', 'a-3']);
      expect(db.listAgents({ runId: 'run-1-1' }).map((a) => a.id)).toEqual(['a-1']);
      expect(db.listAgents({ state: 'busy' }).map((a) => a.id)).toEqual(['a-3']);
      expect(db.listAgents({ role: 'reviewer', state: 'busy' })).toEqual([]);
      expect(db.getAgent('a-2')).toMatchObject({ model: 'm', paneId: '%3' });
    });
  });

  describe('migrations', () => {
    it('sets the schema version to the number of migrations', () => {
      expect(db.schemaVersion()).toBe(MIGRATIONS.length);
    });

    it('is idempotent when a file database is opened twice', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dromos-db-'));
      try {
        const file = join(dir, 'nested', 'bus.db');
        const first = openDb(file);
        first.insertEvent('implementer', 'hook:idle', {});
        first.close();
        const second = openDb(file);
        expect(second.schemaVersion()).toBe(MIGRATIONS.length);
        expect(second.listEvents()).toHaveLength(1);
        second.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('messages', () => {
    it('inserts a message and returns it with id and timestamp', () => {
      const message = db.insertMessage({
        from: 'orchestrator',
        to: 'implementer',
        type: 'task',
        payload: { issue: 1 },
      });
      expect(message).toMatchObject({
        id: 1,
        from: 'orchestrator',
        to: 'implementer',
        type: 'task',
        runId: null,
        payload: { issue: 1 },
        ackedAt: null,
      });
      expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
    });

    it('lists unacked messages for a role, oldest first, respecting the limit', () => {
      for (let i = 0; i < 3; i++) {
        db.insertMessage({ from: 'orchestrator', to: 'implementer', type: 'chat', payload: i });
      }
      db.insertMessage({ from: 'orchestrator', to: 'reviewer', type: 'chat', payload: 'other' });
      expect(db.listUnacked('implementer').map((m) => m.payload)).toEqual([0, 1, 2]);
      expect(db.listUnacked('implementer', 2)).toHaveLength(2);
      expect(db.listUnacked('reviewer')).toHaveLength(1);
    });

    it('returns an empty list when nothing is pending', () => {
      expect(db.listUnacked('orchestrator')).toEqual([]);
    });

    it('acks a message for its addressee only', () => {
      const message = db.insertMessage({
        from: 'orchestrator',
        to: 'implementer',
        type: 'task',
        payload: null,
      });
      expect(db.ackMessage(message.id, 'reviewer')).toBe(false);
      expect(db.listUnacked('implementer')).toHaveLength(1);
      expect(db.ackMessage(message.id, 'implementer')).toBe(true);
      expect(db.listUnacked('implementer')).toHaveLength(0);
    });

    it('refuses to ack twice or to ack an unknown id', () => {
      const message = db.insertMessage({
        from: 'orchestrator',
        to: 'implementer',
        type: 'task',
        payload: null,
      });
      expect(db.ackMessage(message.id, 'implementer')).toBe(true);
      expect(db.ackMessage(message.id, 'implementer')).toBe(false);
      expect(db.ackMessage(999, 'implementer')).toBe(false);
    });

    it('rejects a message that references an unknown run (foreign key)', () => {
      expect(() =>
        db.insertMessage({
          from: 'orchestrator',
          to: 'implementer',
          type: 'task',
          runId: 'nope',
          payload: null,
        }),
      ).toThrow(/FOREIGN KEY/);
    });
  });

  describe('runs', () => {
    it('inserts a run with default state and round', () => {
      const run = db.insertRun(newRun());
      expect(run).toMatchObject({
        id: 'run-1-1',
        state: 'implementing',
        round: 1,
        lastGate: null,
        lastReview: null,
        prUrl: null,
        lastSummary: null,
      });
    });

    it('rejects a duplicate run id', () => {
      db.insertRun(newRun());
      expect(() => db.insertRun(newRun())).toThrow(/UNIQUE|PRIMARY KEY/);
    });

    it('gets a run by id and returns undefined for an unknown id', () => {
      db.insertRun(newRun());
      expect(db.getRun('run-1-1')?.issueTitle).toBe('Do the thing');
      expect(db.getRun('missing')).toBeUndefined();
    });

    it('lists runs newest first', () => {
      db.insertRun(newRun({ id: 'a' }));
      db.insertRun(newRun({ id: 'b' }));
      expect(db.listRuns().map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('updates only the given fields and bumps updatedAt', async () => {
      const run = db.insertRun(newRun());
      await new Promise((resolve) => setTimeout(resolve, 5));
      const gate = {
        passed: false,
        steps: [{ name: 't', command: 'x', exitCode: 1, durationMs: 1, outputTail: 'boom' }],
      };
      const updated = db.updateRun(run.id, { state: 'gating', round: 2, lastGate: gate });
      expect(updated).toMatchObject({
        state: 'gating',
        round: 2,
        lastGate: gate,
        lastReview: null,
      });
      expect(updated?.branch).toBe(run.branch);
      expect((updated?.updatedAt ?? '') > run.updatedAt).toBe(true);
    });

    it('stores a review and a PR url, and can clear a stored gate result', () => {
      db.insertRun(newRun());
      const review = { verdict: 'approve' as const, summary: 'ok', findings: [] };
      const withReview = db.updateRun('run-1-1', {
        lastReview: review,
        prUrl: 'https://github.com/x/y/pull/1',
        lastGate: { passed: true, steps: [] },
      });
      expect(withReview?.lastReview).toEqual(review);
      expect(withReview?.prUrl).toBe('https://github.com/x/y/pull/1');
      expect(db.updateRun('run-1-1', { lastGate: null })?.lastGate).toBeNull();
    });

    it('returns undefined when updating an unknown run', () => {
      expect(db.updateRun('missing', { state: 'blocked' })).toBeUndefined();
    });
  });

  describe('transaction', () => {
    it('returns the value and persists rows on success', () => {
      const value = db.transaction(() => {
        db.insertRun(newRun({ id: 't-1' }));
        return 42;
      });
      expect(value).toBe(42);
      expect(db.getRun('t-1')).toBeDefined();
    });

    it('rolls back every write when fn throws', () => {
      expect(() =>
        db.transaction(() => {
          db.insertRun(newRun({ id: 't-2' }));
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(db.getRun('t-2')).toBeUndefined();
    });
  });

  describe('events', () => {
    it('inserts and lists events, newest first, optionally per role', () => {
      db.insertEvent('implementer', 'hook:idle', { cli: 'claude' });
      db.insertEvent('reviewer', 'hook:busy', { cli: 'copilot' });
      db.insertEvent('implementer', 'hook:busy', { cli: 'claude' });
      expect(db.listEvents().map((e) => e.kind)).toEqual(['hook:busy', 'hook:busy', 'hook:idle']);
      expect(db.listEvents('implementer').map((e) => e.data)).toEqual([
        { cli: 'claude' },
        { cli: 'claude' },
      ]);
      expect(db.listEvents(undefined, 1)).toHaveLength(1);
    });

    it('counts unacked messages per addressed role for one run only', () => {
      db.insertRun({
        id: 'r1',
        repo: 'o/r',
        repoPath: '/r',
        issueNumber: 1,
        issueTitle: 't',
        baseBranch: 'main',
        branch: 'b1',
        worktreePath: '/w1',
      });
      db.insertRun({
        id: 'r2',
        repo: 'o/r',
        repoPath: '/r',
        issueNumber: 2,
        issueTitle: 't',
        baseBranch: 'main',
        branch: 'b2',
        worktreePath: '/w2',
      });
      const send = (to: 'implementer' | 'reviewer', runId: string | null) =>
        db.insertMessage({ from: 'orchestrator', to, type: 'task', runId, payload: {} });
      send('implementer', 'r1');
      send('implementer', 'r1');
      const acked = send('reviewer', 'r1');
      db.ackMessage(acked.id, 'reviewer');
      send('reviewer', 'r2');
      send('reviewer', null);
      expect(db.countUnackedByRole('r1')).toEqual({ implementer: 2 });
      expect(db.countUnackedByRole('r2')).toEqual({ reviewer: 1 });
      expect(db.countUnackedByRole('missing')).toEqual({});
    });

    it('returns the newest hook event per role, ignoring other kinds', () => {
      db.insertEvent('implementer', 'hook:idle', { n: 1 });
      db.insertEvent('implementer', 'hook:busy', { n: 2 });
      db.insertEvent('implementer', 'task:done', { n: 3 });
      db.insertEvent('reviewer', 'hook:idle', { n: 4 });
      expect(db.lastHookEventPerRole().map((e) => [e.role, e.kind, e.data])).toEqual([
        ['implementer', 'hook:busy', { n: 2 }],
        ['reviewer', 'hook:idle', { n: 4 }],
      ]);
    });

    it('returns no hook events on an empty table', () => {
      expect(db.lastHookEventPerRole()).toEqual([]);
    });

    it('lists events strictly after an id, ascending, honouring the limit', () => {
      const ids = ['a', 'b', 'c'].map((k) => db.insertEvent('implementer', `hook:${k}`, null).id);
      expect(db.listEventsSince(0).map((e) => e.kind)).toEqual(['hook:a', 'hook:b', 'hook:c']);
      expect(db.listEventsSince(ids[0] as number).map((e) => e.kind)).toEqual(['hook:b', 'hook:c']);
      expect(db.listEventsSince(0, 2).map((e) => e.kind)).toEqual(['hook:a', 'hook:b']);
      expect(db.listEventsSince(ids[2] as number)).toEqual([]);
    });

    it('stores the envelope context and returns NULLs without it', () => {
      const withCtx = db.insertEvent('s', 'progress', null, {
        agentId: 'a1',
        issue: 43,
        runId: 'r1',
      });
      const without = db.insertEvent('s', 'progress', null);
      expect(withCtx).toMatchObject({ agentId: 'a1', issue: 43, runId: 'r1' });
      expect(without).toMatchObject({ agentId: null, issue: null, runId: null });
      expect(db.listEventsSince(0).map((e) => e.agentId)).toEqual(['a1', null]);
    });

    it('returns an empty list for an empty table', () => {
      expect(db.listEventsSince(0)).toEqual([]);
    });
  });
  describe('queryEvents', () => {
    const ids = (page: { events: { id: number }[] }) => page.events.map((e) => e.id);
    const insertAt = (createdAt: string) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(createdAt));
      try {
        return db.insertEvent('s', 'k', {});
      } finally {
        vi.useRealTimers();
      }
    };

    it('returns everything in id order for an empty filter', () => {
      const a = db.insertEvent('s', 'a', {});
      const b = db.insertEvent('s', 'b', {});
      expect(db.queryEvents({ limit: 10 })).toMatchObject({
        events: [{ id: a.id }, { id: b.id }],
        next: null,
      });
    });

    it('filters by issue and by a type list', () => {
      const e1 = db.insertEvent('s', 'x', {}, { issue: 1 });
      db.insertEvent('s', 'x', {}, { issue: 2 });
      const e3 = db.insertEvent('s', 'y', {}, { issue: 1 });
      db.insertEvent('s', 'z', {}, { issue: 1 });
      expect(ids(db.queryEvents({ issue: 1, types: ['x', 'y'], limit: 10 }))).toEqual([
        e1.id,
        e3.id,
      ]);
      expect(ids(db.queryEvents({ types: ['nope'], limit: 10 }))).toEqual([]);
    });

    it('filters by source and agentId', () => {
      const a = db.insertEvent('impl', 'k', {}, { agentId: 'a1' });
      db.insertEvent('rev', 'k', {}, { agentId: 'a1' });
      db.insertEvent('impl', 'k', {}, { agentId: 'a2' });
      expect(ids(db.queryEvents({ sources: ['impl'], agentId: 'a1', limit: 10 }))).toEqual([a.id]);
      expect(db.queryEvents({ sources: ['impl', 'rev'], limit: 10 }).events).toHaveLength(3);
    });

    it('treats since as inclusive and until as exclusive on created_at', () => {
      const t = [
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        '2026-01-03T00:00:00.000Z',
      ];
      const ev = t.map((c) => insertAt(c));
      expect(ids(db.queryEvents({ since: t[1], limit: 10 }))).toEqual([ev[1]?.id, ev[2]?.id]);
      expect(ids(db.queryEvents({ until: t[1], limit: 10 }))).toEqual([ev[0]?.id]);
      expect(ids(db.queryEvents({ since: t[1], until: t[2], limit: 10 }))).toEqual([ev[1]?.id]);
    });

    it('pages 2500 matching events as 1000+1000+500 without repeats or gaps', () => {
      const all: number[] = [];
      db.transaction(() => {
        for (let i = 0; i < 2500; i++) {
          all.push(db.insertEvent('s', 'k', {}, { issue: 5 }).id);
          db.insertEvent('s', 'other', {}, { issue: 6 });
        }
      });
      const seen: number[] = [];
      const sizes: number[] = [];
      let after: number | undefined;
      for (;;) {
        const page = db.queryEvents({ issue: 5, limit: 1000, after });
        sizes.push(page.events.length);
        seen.push(...ids(page));
        if (page.next === null) break;
        after = page.next;
      }
      expect(sizes).toEqual([1000, 1000, 500]);
      expect(seen).toEqual(all);
    });

    it('returns next null when exactly limit rows match', () => {
      db.insertEvent('s', 'k', {});
      db.insertEvent('s', 'k', {});
      const page = db.queryEvents({ limit: 2 });
      expect(page.events).toHaveLength(2);
      expect(page.next).toBeNull();
    });

    it('does not repeat or skip matching events inserted between pages', () => {
      const first = [1, 2, 3].map(() => db.insertEvent('s', 'k', {}, { issue: 9 }).id);
      const p1 = db.queryEvents({ issue: 9, limit: 2 });
      expect(p1.next).toBe(first[1]);
      const late = db.insertEvent('s', 'k', {}, { issue: 9 });
      db.insertEvent('s', 'k', {}, { issue: 8 });
      const p2 = db.queryEvents({ issue: 9, limit: 2, after: p1.next as number });
      expect([...ids(p1), ...ids(p2)]).toEqual([...first, late.id]);
      expect(p2.next).toBeNull();
    });

    it('treats filter values as data, not SQL', () => {
      db.insertEvent('s', 'k', {});
      expect(db.queryEvents({ types: ["k' OR '1'='1"], limit: 10 }).events).toEqual([]);
    });

    it('uses idx_events_issue_id for an issue filter', () => {
      const raw = new Database(':memory:');
      for (const sql of MIGRATIONS) raw.exec(sql);
      const plan = raw
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM events WHERE issue = ? AND id > ? ORDER BY id ASC LIMIT ?',
        )
        .all(1, 0, 11) as { detail: string }[];
      raw.close();
      expect(plan.map((p) => p.detail).join('\n')).toContain('idx_events_issue_id');
    });
  });

  describe('migration 6 and attention', () => {
    const ev = (issue: number | null, kind = 'GATE') =>
      db.insertEvent(
        'apm-hub/queue',
        'attention',
        { kind, summary: 's', pr: null },
        { agentId: 'a1', issue, runId: null },
      );

    it('upgrades a version-5 database and keeps its events', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dromos-db-'));
      try {
        const file = join(dir, 'bus.db');
        const raw = new Database(file);
        for (const sql of MIGRATIONS.slice(0, 5)) raw.exec(sql);
        raw.pragma('user_version = 5');
        raw
          .prepare(
            `INSERT INTO events (role, kind, data_json, created_at, issue)
             VALUES ('implementer', 'hook:idle', '{}', '2026-01-01T00:00:00Z', 7)`,
          )
          .run();
        raw.close();
        const migrated = openDb(file);
        expect(migrated.schemaVersion()).toBe(8);
        expect(migrated.listAttention({ limit: 10 })).toEqual([]);
        expect(migrated.queryEvents({ issue: 7, limit: 10 }).events).toHaveLength(1);
        migrated.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('inserts an open attention with the event id', () => {
      const event = ev(5);
      const a = db.insertAttention(event);
      expect(a).toMatchObject({
        id: event.id,
        eventId: event.id,
        source: 'apm-hub/queue',
        agentId: 'a1',
        issue: 5,
        kind: 'GATE',
        summary: 's',
        state: 'open',
        answeredAt: null,
        ackedAt: null,
      });
      expect(a.data).toEqual({ kind: 'GATE', summary: 's', pr: null });
      expect(db.getAttention(event.id)).toEqual(a);
      expect(db.getAttention(9999)).toBeUndefined();
    });

    it('rejects any state other than open, answered or acked', () => {
      const raw = new Database(':memory:');
      for (const sql of MIGRATIONS) raw.exec(sql);
      raw
        .prepare(
          "INSERT INTO events (role, kind, data_json, created_at) VALUES ('r','attention','{}','t')",
        )
        .run();
      const insert = (state: string) =>
        raw
          .prepare(
            `INSERT INTO attention (id, event_id, source, kind, summary, data_json, state, created_at)
             VALUES (1, 1, 's', 'k', 'x', '{}', ?, 't')`,
          )
          .run(state);
      expect(() => insert('closed')).toThrow(/CHECK/);
      expect(() => insert('answered')).not.toThrow();
      raw.close();
    });

    it('rejects a duplicate attention for one event', () => {
      const event = ev(5);
      db.insertAttention(event);
      expect(() => db.insertAttention(event)).toThrow();
    });

    it('lists ascending, filtered by state, issue and since', () => {
      const a = db.insertAttention(ev(1));
      const b = db.insertAttention(ev(2));
      const c = db.insertAttention(ev(1));
      expect(db.listAttention({ limit: 10 }).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
      expect(db.listAttention({ issue: 1, limit: 10 }).map((r) => r.id)).toEqual([a.id, c.id]);
      expect(db.listAttention({ state: 'open', limit: 2 }).map((r) => r.id)).toEqual([a.id, b.id]);
      expect(db.listAttention({ state: 'acked', limit: 10 })).toEqual([]);
      expect(db.listAttention({ since: '2999-01-01T00:00:00.000Z', limit: 10 })).toEqual([]);
      expect(db.listAttention({ since: '2000-01-01T00:00:00.000Z', limit: 10 })).toHaveLength(3);
    });

    it('answers an open attention once and reports a conflict on the second answer', () => {
      const a = db.insertAttention(ev(1));
      expect(db.answerAttention(a.id, 'ship it', 'jerome')).toBe('ok');
      expect(db.getAttention(a.id)).toMatchObject({
        state: 'answered',
        answerText: 'ship it',
        answeredBy: 'jerome',
      });
      expect(db.getAttention(a.id)?.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(db.answerAttention(a.id, 'again', 'other')).toBe('conflict');
      expect(db.getAttention(a.id)?.answerText).toBe('ship it');
    });

    it('reports not_found for an unknown attention id', () => {
      expect(db.answerAttention(4242, 'x', 'y')).toBe('not_found');
      expect(db.ackAttention(4242, null)).toBe('not_found');
    });

    it('acks only an answered attention', () => {
      const a = db.insertAttention(ev(1));
      expect(db.ackAttention(a.id, 'jerome')).toBe('conflict');
      expect(db.getAttention(a.id)?.state).toBe('open');
      db.answerAttention(a.id, 'ok', 'jerome');
      expect(db.ackAttention(a.id, null)).toBe('ok');
      expect(db.getAttention(a.id)).toMatchObject({ state: 'acked', ackedBy: null });
      expect(db.getAttention(a.id)?.ackedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(db.ackAttention(a.id, 'x')).toBe('conflict');
      expect(db.answerAttention(a.id, 'late', 'x')).toBe('conflict');
    });
  });
});
