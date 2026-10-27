import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  Agent,
  AgentState,
  GateResult,
  Message,
  MessageType,
  Review,
  Role,
  RunState,
} from './schemas.js';

/** Applied in order; the index + 1 is the schema version stored in `PRAGMA user_version`. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    state TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    last_gate_json TEXT,
    last_review_json TEXT,
    pr_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_role TEXT NOT NULL,
    to_role TEXT NOT NULL,
    type TEXT NOT NULL,
    run_id TEXT REFERENCES runs(id),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acked_at TEXT
  );
  CREATE INDEX idx_messages_inbox ON messages(to_role, acked_at);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    run_id TEXT REFERENCES runs(id),
    cli TEXT NOT NULL,
    model TEXT,
    pane_id TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_agents_role ON agents(role, state);
  ALTER TABLE messages ADD COLUMN from_agent TEXT;
  ALTER TABLE messages ADD COLUMN to_agent TEXT;
  `,
  `
  ALTER TABLE events ADD COLUMN agent_id TEXT;
  ALTER TABLE events ADD COLUMN issue INTEGER;
  ALTER TABLE events ADD COLUMN run_id TEXT;
  `,
  `
  ALTER TABLE runs ADD COLUMN last_summary TEXT;
  `,
  `
  CREATE INDEX idx_events_issue_id ON events(issue, id);
  CREATE INDEX idx_events_kind_id ON events(kind, id);
  `,
  `
  CREATE TABLE attention (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    source TEXT NOT NULL,
    agent_id TEXT,
    issue INTEGER,
    run_id TEXT,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    data_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','answered','acked')),
    created_at TEXT NOT NULL,
    answered_at TEXT,
    answer_text TEXT,
    answered_by TEXT,
    acked_at TEXT,
    acked_by TEXT
  );
  CREATE INDEX idx_attention_state_id ON attention(state, id);
  CREATE INDEX idx_attention_issue_id ON attention(issue, id);
  `,
  `
  ALTER TABLE messages ADD COLUMN attention_raised_at TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN last_output_at TEXT;
  `,
];

export interface Run {
  id: string;
  repo: string;
  repoPath: string;
  issueNumber: number;
  issueTitle: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  state: RunState;
  round: number;
  lastGate: GateResult | null;
  lastReview: Review | null;
  prUrl: string | null;
  lastSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewRun = Pick<
  Run,
  | 'id'
  | 'repo'
  | 'repoPath'
  | 'issueNumber'
  | 'issueTitle'
  | 'baseBranch'
  | 'branch'
  | 'worktreePath'
> &
  Partial<Pick<Run, 'state' | 'round'>>;

export type RunPatch = Partial<
  Pick<Run, 'state' | 'round' | 'lastGate' | 'lastReview' | 'prUrl' | 'lastSummary'>
>;

export interface NewMessage {
  from: Role;
  to: Role;
  /** Sending agent instance, when known. */
  fromAgent?: string | null;
  /** Set when the message targets one agent; `to` is then that agent's role. */
  toAgent?: string | null;
  type: MessageType;
  runId?: string | null;
  payload: unknown;
}

export interface EventRecord {
  id: number;
  role: string;
  kind: string;
  data: unknown;
  createdAt: string;
  /** Bus identity of the reporting agent; null for events recorded without one. */
  agentId: string | null;
  /** Issue number the event belongs to; null when none. */
  issue: number | null;
  /** Orchestrator run the event belongs to; null when none. */
  runId: string | null;
}

export type AttentionState = 'open' | 'answered' | 'acked';

/** One attention that needs a human; `id` equals the id of its `attention` event. */
export interface AttentionRecord {
  id: number;
  eventId: number;
  source: string;
  agentId: string | null;
  issue: number | null;
  runId: string | null;
  kind: string;
  summary: string;
  /** The attention event's full `data` payload. */
  data: unknown;
  state: AttentionState;
  createdAt: string;
  answeredAt: string | null;
  answerText: string | null;
  answeredBy: string | null;
  ackedAt: string | null;
  ackedBy: string | null;
}

/** Outcome of a compare-and-set attention state transition. */
export type AttentionTransition = 'ok' | 'not_found' | 'conflict';

/** Filters for `Db.listAttention`; absent filters match everything. */
export interface AttentionQuery {
  state?: AttentionState;
  issue?: number;
  /** Inclusive lower bound on `created_at`, normalized ISO UTC. */
  since?: string;
  limit: number;
}

/** Filters for `Db.queryEvents`; absent filters match everything. */
export interface EventQuery {
  issue?: number;
  /** Matches `kind` (the API's `type`). */
  types?: string[];
  /** Matches `role` (the API's `source`). */
  sources?: string[];
  agentId?: string;
  /** Inclusive lower bound on `created_at`, normalized ISO UTC. */
  since?: string;
  /** Exclusive upper bound on `created_at`, normalized ISO UTC. */
  until?: string;
  /** Keyset cursor: only events with id greater than this. */
  after?: number;
  limit: number;
}

export interface EventPage {
  events: EventRecord[];
  /** Id to pass as `after` for the next page; null on the last page. */
  next: number | null;
}

/** Optional envelope fields stored next to an event; omitted fields are stored as NULL. */
export interface EventContext {
  agentId?: string | null;
  issue?: number | null;
  runId?: string | null;
}

interface RunRow {
  id: string;
  repo: string;
  repo_path: string;
  issue_number: number;
  issue_title: string;
  base_branch: string;
  branch: string;
  worktree_path: string;
  state: RunState;
  round: number;
  last_gate_json: string | null;
  last_review_json: string | null;
  pr_url: string | null;
  last_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  from_role: Role;
  to_role: Role;
  from_agent: string | null;
  to_agent: string | null;
  type: MessageType;
  run_id: string | null;
  payload_json: string;
  created_at: string;
  acked_at: string | null;
  attention_raised_at: string | null;
}

interface EventRow {
  id: number;
  role: string;
  kind: string;
  data_json: string;
  created_at: string;
  agent_id: string | null;
  issue: number | null;
  run_id: string | null;
}

interface AttentionRow {
  id: number;
  event_id: number;
  source: string;
  agent_id: string | null;
  issue: number | null;
  run_id: string | null;
  kind: string;
  summary: string;
  data_json: string;
  state: AttentionState;
  created_at: string;
  answered_at: string | null;
  answer_text: string | null;
  answered_by: string | null;
  acked_at: string | null;
  acked_by: string | null;
}

const now = (): string => new Date().toISOString();

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    repo: row.repo,
    repoPath: row.repo_path,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    baseBranch: row.base_branch,
    branch: row.branch,
    worktreePath: row.worktree_path,
    state: row.state,
    round: row.round,
    lastGate: row.last_gate_json ? (JSON.parse(row.last_gate_json) as GateResult) : null,
    lastReview: row.last_review_json ? (JSON.parse(row.last_review_json) as Review) : null,
    prUrl: row.pr_url,
    lastSummary: row.last_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from: row.from_role,
    to: row.to_role,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    type: row.type,
    runId: row.run_id,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
    ackedAt: row.acked_at,
  };
}

export interface NewAgent {
  id: string;
  role: Role;
  runId?: string | null;
  cli: string;
  model?: string | null;
  paneId?: string | null;
  state?: AgentState;
}

export interface AgentFilter {
  role?: Role;
  runId?: string;
  state?: AgentState;
}

interface AgentRow {
  id: string;
  role: Role;
  run_id: string | null;
  cli: string;
  model: string | null;
  pane_id: string | null;
  state: AgentState;
  created_at: string;
  updated_at: string;
  last_output_at: string | null;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    role: row.role,
    runId: row.run_id,
    cli: row.cli,
    model: row.model,
    paneId: row.pane_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOutputAt: row.last_output_at,
  };
}

export interface Db {
  /** Throws when the id already exists. State defaults to `idle`. */
  insertAgent(agent: NewAgent): Agent;
  getAgent(id: string): Agent | undefined;
  /** Returns undefined when the agent does not exist. */
  updateAgentState(id: string, state: AgentState): Agent | undefined;
  /** Moves `last_output_at` forward to `at` (ISO); an equal or older value is ignored. */
  touchAgentOutput(id: string, at: string): void;
  /** Sets the agent's run_id only when it has none yet (first run wins). Returns the agent, or undefined when unknown. */
  setAgentRun(id: string, runId: string): Agent | undefined;
  listAgents(filter?: AgentFilter): Agent[];
  insertMessage(message: NewMessage): Message;
  /** Role-addressed messages for `role` plus, when given, messages addressed to `agentId`. */
  listUnacked(role: Role, limit?: number, agentId?: string): Message[];
  /** Returns false when the message does not exist, is already acked, or is addressed to someone else. */
  ackMessage(id: number, role: Role, agentId?: string): boolean;
  /**
   * Notices from other roles to the orchestrator (not the orchestrator's own bookkeeping, such
   * as pr_opened) created at or before `cutoff` (ISO) that are unacked, have no
   * `attention_raised_at` and whose run has no attention other than a QUESTION; ascending id.
   * Notices without a run qualify.
   */
  listStaleOrchestratorNotices(cutoff: string, limit?: number): Message[];
  /** Marks the notice as having raised its attention; false when it was already marked. */
  markNoticeAttentionRaised(id: number): boolean;
  /** Unacked message count per addressed role for one run; roles without unacked messages are absent. */
  countUnackedByRole(runId: string): Partial<Record<Role, number>>;
  insertRun(run: NewRun): Run;
  getRun(id: string): Run | undefined;
  listRuns(): Run[];
  updateRun(id: string, patch: RunPatch): Run | undefined;
  insertEvent(role: string, kind: string, data: unknown, context?: EventContext): EventRecord;
  listEvents(role?: string, limit?: number): EventRecord[];
  /** Newest `hook:%` event of each role, ordered by role. */
  lastHookEventPerRole(): EventRecord[];
  /** Events with id strictly greater than `afterId`, ascending, for stream replay. */
  listEventsSince(afterId: number, limit?: number): EventRecord[];
  /** Matching events in ascending id order, at most `limit`, with a keyset cursor. */
  queryEvents(query: EventQuery): EventPage;
  /** Stores the `attention` event as an open attention with the same id. Throws on a malformed payload or a duplicate. */
  insertAttention(event: EventRecord): AttentionRecord;
  getAttention(id: number): AttentionRecord | undefined;
  /** Matching attentions in ascending id order, at most `limit`. */
  listAttention(query: AttentionQuery): AttentionRecord[];
  /**
   * Compare-and-set `open -> answered`: `conflict` when the attention exists but is not open,
   * `not_found` when it does not exist. Never reads before writing.
   */
  answerAttention(id: number, text: string, by: string): AttentionTransition;
  /** Compare-and-set `answered -> acked`; an open or acked attention is a `conflict`. */
  ackAttention(id: number, by: string | null): AttentionTransition;
  /** Runs `fn` in one SQLite transaction; rolls back when it throws. */
  transaction<T>(fn: () => T): T;
  schemaVersion(): number;
  close(): void;
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] as string;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/** Opens (and migrates) the bus database. `file` is a path or `':memory:'`. */
export function openDb(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const insertMessage = db.prepare(
    `INSERT INTO messages (from_role, to_role, from_agent, to_agent, type, run_id, payload_json, created_at)
     VALUES (@from, @to, @fromAgent, @toAgent, @type, @runId, @payload, @createdAt)`,
  );
  const getMessage = db.prepare<[number | bigint], MessageRow>(
    'SELECT * FROM messages WHERE id = ?',
  );
  const listUnacked = db.prepare<[Role, string | null, number], MessageRow>(
    `SELECT * FROM messages
     WHERE acked_at IS NULL AND ((to_role = ? AND to_agent IS NULL) OR to_agent = ?)
     ORDER BY id LIMIT ?`,
  );
  const countUnackedByRole = db.prepare<[string], { to_role: Role; n: number }>(
    `SELECT to_role, COUNT(*) AS n FROM messages
     WHERE acked_at IS NULL AND run_id = ? GROUP BY to_role`,
  );
  const listStaleNotices = db.prepare<[string, number], MessageRow>(
    `SELECT m.* FROM messages m
     WHERE m.type = 'notice' AND m.to_role = 'orchestrator' AND m.from_role <> 'orchestrator'
       AND m.acked_at IS NULL
       AND m.attention_raised_at IS NULL AND m.created_at <= ?
       AND (m.run_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM attention a WHERE a.run_id = m.run_id AND a.kind <> 'QUESTION'))
     ORDER BY m.id LIMIT ?`,
  );
  const markNoticeRaised = db.prepare(
    'UPDATE messages SET attention_raised_at = ? WHERE id = ? AND attention_raised_at IS NULL',
  );
  const lastHookEventPerRole = db.prepare<[], EventRow>(
    `SELECT * FROM events WHERE id IN (
       SELECT MAX(id) FROM events WHERE kind LIKE 'hook:%' GROUP BY role
     ) ORDER BY role`,
  );
  const ackMessage = db.prepare(
    `UPDATE messages SET acked_at = ? WHERE id = ? AND acked_at IS NULL
       AND ((to_role = ? AND to_agent IS NULL) OR to_agent = ?)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO runs (id, repo, repo_path, issue_number, issue_title, base_branch, branch,
       worktree_path, state, round, created_at, updated_at)
     VALUES (@id, @repo, @repoPath, @issueNumber, @issueTitle, @baseBranch, @branch,
       @worktreePath, @state, @round, @createdAt, @createdAt)`,
  );
  const getRun = db.prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?');
  const listRuns = db.prepare<[], RunRow>(
    'SELECT * FROM runs ORDER BY created_at DESC, rowid DESC',
  );
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, role, run_id, cli, model, pane_id, state, created_at, updated_at)
     VALUES (@id, @role, @runId, @cli, @model, @paneId, @state, @createdAt, @createdAt)`,
  );
  const getAgent = db.prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?');
  const updateAgentState = db.prepare('UPDATE agents SET state = ?, updated_at = ? WHERE id = ?');
  const touchAgentOutput = db.prepare(
    'UPDATE agents SET last_output_at = ? WHERE id = ? AND (last_output_at IS NULL OR last_output_at < ?)',
  );
  const setAgentRun = db.prepare(
    'UPDATE agents SET run_id = ?, updated_at = ? WHERE id = ? AND run_id IS NULL',
  );
  const listAgents = db.prepare<
    [string | null, string | null, string | null, string | null, string | null, string | null],
    AgentRow
  >(
    `SELECT * FROM agents
     WHERE (? IS NULL OR role = ?) AND (? IS NULL OR run_id = ?) AND (? IS NULL OR state = ?)
     ORDER BY created_at, rowid`,
  );
  const insertEvent = db.prepare(
    'INSERT INTO events (role, kind, data_json, created_at, agent_id, issue, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const getEvent = db.prepare<[number | bigint], EventRow>('SELECT * FROM events WHERE id = ?');
  const listEvents = db.prepare<[string | null, string | null, number], EventRow>(
    `SELECT * FROM events WHERE (? IS NULL OR role = ?) ORDER BY id DESC LIMIT ?`,
  );
  const listEventsSince = db.prepare<[number, number], EventRow>(
    'SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?',
  );

  const insertAttention = db.prepare(
    `INSERT INTO attention (id, event_id, source, agent_id, issue, run_id, kind, summary, data_json, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  );
  const getAttention = db.prepare<[number], AttentionRow>('SELECT * FROM attention WHERE id = ?');
  const listAttention = db.prepare<
    [
      string | null,
      string | null,
      number | null,
      number | null,
      string | null,
      string | null,
      number,
    ],
    AttentionRow
  >(
    `SELECT * FROM attention
     WHERE (? IS NULL OR state = ?) AND (? IS NULL OR issue = ?) AND (? IS NULL OR created_at >= ?)
     ORDER BY id ASC LIMIT ?`,
  );
  const answerAttention = db.prepare<[string, string, string, number]>(
    `UPDATE attention SET state = 'answered', answered_at = ?, answer_text = ?, answered_by = ?
     WHERE id = ? AND state = 'open'`,
  );
  const ackAttention = db.prepare<[string, string | null, number]>(
    `UPDATE attention SET state = 'acked', acked_at = ?, acked_by = ?
     WHERE id = ? AND state = 'answered'`,
  );
  const transitionOutcome = (changes: number, id: number): AttentionTransition => {
    if (changes > 0) {
      return 'ok';
    }
    return getAttention.get(id) ? 'conflict' : 'not_found';
  };
  const toAttention = (row: AttentionRow): AttentionRecord => ({
    id: row.id,
    eventId: row.event_id,
    source: row.source,
    agentId: row.agent_id,
    issue: row.issue,
    runId: row.run_id,
    kind: row.kind,
    summary: row.summary,
    data: JSON.parse(row.data_json) as unknown,
    state: row.state,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    answerText: row.answer_text,
    answeredBy: row.answered_by,
    ackedAt: row.acked_at,
    ackedBy: row.acked_by,
  });

  const toEvent = (row: EventRow): EventRecord => ({
    id: row.id,
    role: row.role,
    kind: row.kind,
    data: JSON.parse(row.data_json) as unknown,
    createdAt: row.created_at,
    agentId: row.agent_id,
    issue: row.issue,
    runId: row.run_id,
  });

  return {
    insertMessage(message) {
      const info = insertMessage.run({
        from: message.from,
        to: message.to,
        fromAgent: message.fromAgent ?? null,
        toAgent: message.toAgent ?? null,
        type: message.type,
        runId: message.runId ?? null,
        payload: JSON.stringify(message.payload ?? null),
        createdAt: now(),
      });
      return toMessage(getMessage.get(info.lastInsertRowid) as MessageRow);
    },
    listUnacked(role, limit = 20, agentId) {
      return listUnacked.all(role, agentId ?? null, limit).map(toMessage);
    },
    listStaleOrchestratorNotices(cutoff, limit = 100) {
      return listStaleNotices.all(cutoff, limit).map(toMessage);
    },
    markNoticeAttentionRaised(id) {
      return markNoticeRaised.run(now(), id).changes > 0;
    },
    ackMessage(id, role, agentId) {
      return ackMessage.run(now(), id, role, agentId ?? null).changes > 0;
    },
    insertRun(run) {
      insertRun.run({
        ...run,
        state: run.state ?? 'implementing',
        round: run.round ?? 1,
        createdAt: now(),
      });
      return toRun(getRun.get(run.id) as RunRow);
    },
    getRun(id) {
      const row = getRun.get(id);
      return row ? toRun(row) : undefined;
    },
    listRuns() {
      return listRuns.all().map(toRun);
    },
    updateRun(id, patch) {
      const columns: string[] = [];
      const values: Record<string, unknown> = { id, updatedAt: now() };
      if (patch.state !== undefined) {
        columns.push('state = @state');
        values.state = patch.state;
      }
      if (patch.round !== undefined) {
        columns.push('round = @round');
        values.round = patch.round;
      }
      if (patch.lastGate !== undefined) {
        columns.push('last_gate_json = @lastGate');
        values.lastGate = patch.lastGate === null ? null : JSON.stringify(patch.lastGate);
      }
      if (patch.lastReview !== undefined) {
        columns.push('last_review_json = @lastReview');
        values.lastReview = patch.lastReview === null ? null : JSON.stringify(patch.lastReview);
      }
      if (patch.prUrl !== undefined) {
        columns.push('pr_url = @prUrl');
        values.prUrl = patch.prUrl;
      }
      if (patch.lastSummary !== undefined) {
        columns.push('last_summary = @lastSummary');
        values.lastSummary = patch.lastSummary;
      }
      columns.push('updated_at = @updatedAt');
      const info = db.prepare(`UPDATE runs SET ${columns.join(', ')} WHERE id = @id`).run(values);
      if (info.changes === 0) {
        return undefined;
      }
      return toRun(getRun.get(id) as RunRow);
    },
    insertAgent(agent) {
      insertAgent.run({
        id: agent.id,
        role: agent.role,
        runId: agent.runId ?? null,
        cli: agent.cli,
        model: agent.model ?? null,
        paneId: agent.paneId ?? null,
        state: agent.state ?? 'idle',
        createdAt: now(),
      });
      return toAgent(getAgent.get(agent.id) as AgentRow);
    },
    getAgent(id) {
      const row = getAgent.get(id);
      return row ? toAgent(row) : undefined;
    },
    updateAgentState(id, state) {
      if (updateAgentState.run(state, now(), id).changes === 0) {
        return undefined;
      }
      return toAgent(getAgent.get(id) as AgentRow);
    },
    touchAgentOutput(id, at) {
      touchAgentOutput.run(at, id, at);
    },
    setAgentRun(id, runId) {
      setAgentRun.run(runId, now(), id);
      const row = getAgent.get(id);
      return row ? toAgent(row) : undefined;
    },
    listAgents(filter = {}) {
      const { role = null, runId = null, state = null } = filter;
      return listAgents.all(role, role, runId, runId, state, state).map(toAgent);
    },
    insertEvent(role, kind, data, context) {
      const info = insertEvent.run(
        role,
        kind,
        JSON.stringify(data ?? null),
        now(),
        context?.agentId ?? null,
        context?.issue ?? null,
        context?.runId ?? null,
      );
      return toEvent(getEvent.get(info.lastInsertRowid) as EventRow);
    },
    insertAttention(event) {
      const data = event.data as { kind: string; summary: string };
      insertAttention.run(
        event.id,
        event.id,
        event.role,
        event.agentId,
        event.issue,
        event.runId,
        data.kind,
        data.summary,
        JSON.stringify(event.data ?? null),
        event.createdAt,
      );
      return toAttention(getAttention.get(event.id) as AttentionRow);
    },
    getAttention(id) {
      const row = getAttention.get(id);
      return row ? toAttention(row) : undefined;
    },
    listAttention({ state, issue, since, limit }) {
      const st = state ?? null;
      const is = issue ?? null;
      const si = since ?? null;
      return listAttention.all(st, st, is, is, si, si, limit).map(toAttention);
    },
    answerAttention(id, text, by) {
      return transitionOutcome(answerAttention.run(now(), text, by, id).changes, id);
    },
    ackAttention(id, by) {
      return transitionOutcome(ackAttention.run(now(), by, id).changes, id);
    },
    countUnackedByRole(runId) {
      const counts: Partial<Record<Role, number>> = {};
      for (const row of countUnackedByRole.all(runId)) counts[row.to_role] = row.n;
      return counts;
    },
    lastHookEventPerRole() {
      return lastHookEventPerRole.all().map(toEvent);
    },
    listEvents(role, limit = 50) {
      return listEvents.all(role ?? null, role ?? null, limit).map(toEvent);
    },
    listEventsSince(afterId, limit = 1000) {
      return listEventsSince.all(afterId, limit).map(toEvent);
    },
    queryEvents(query) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.issue !== undefined) {
        where.push('issue = ?');
        params.push(query.issue);
      }
      if (query.types !== undefined) {
        where.push(`kind IN (${query.types.map(() => '?').join(', ')})`);
        params.push(...query.types);
      }
      if (query.sources !== undefined) {
        where.push(`role IN (${query.sources.map(() => '?').join(', ')})`);
        params.push(...query.sources);
      }
      if (query.agentId !== undefined) {
        where.push('agent_id = ?');
        params.push(query.agentId);
      }
      if (query.since !== undefined) {
        where.push('created_at >= ?');
        params.push(query.since);
      }
      if (query.until !== undefined) {
        where.push('created_at < ?');
        params.push(query.until);
      }
      if (query.after !== undefined) {
        where.push('id > ?');
        params.push(query.after);
      }
      const sql = `SELECT * FROM events${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`;
      const rows = db.prepare<(string | number)[], EventRow>(sql).all(...params, query.limit + 1);
      const page = rows.slice(0, query.limit).map(toEvent);
      const last = page[page.length - 1];
      return { events: page, next: rows.length > query.limit && last ? last.id : null };
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
    schemaVersion() {
      return db.pragma('user_version', { simple: true }) as number;
    },
    close() {
      db.close();
    },
  };
}
