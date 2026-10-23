import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  describe('migration 2', () => {
    it('keeps version-1 rows and adds agents plus nullable message agent columns', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-bus-db-'));
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
      const dir = mkdtempSync(join(tmpdir(), 'agent-bus-db-'));
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
  });
});
