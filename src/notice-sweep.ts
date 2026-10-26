import { recordAttention } from './attention.js';
import type { BusEvents } from './bus-events.js';
import type { Db, EventRecord } from './db.js';
import { BusEventSchema, FORBIDDEN_CHARS } from './events/schema.js';
import type { LeaseLog } from './run-lease.js';
import type { Message } from './schemas.js';

export const NOTICE_SWEEP_INTERVAL_MS = 10_000;
export const NOTICE_ATTENTION_THRESHOLD_MS = 60_000;

export interface NoticeSweepOptions {
  intervalMs?: number;
  thresholdMs?: number;
  /** Clock in epoch ms; injectable for tests. */
  now?: () => number;
}

const FORBIDDEN_GLOBAL = new RegExp(FORBIDDEN_CHARS.source, 'gu');
const MAX_SUMMARY = 2000;

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function summaryOf(message: Message): string {
  const payload = message.payload;
  const field = (name: string): string => {
    const value =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[name] : null;
    return typeof value === 'string' ? value : '';
  };
  const raw = field('reason') || field('event') || 'notice for the orchestrator';
  const cleaned = raw.replace(FORBIDDEN_GLOBAL, ' ').trim();
  return (cleaned || 'notice for the orchestrator').slice(0, MAX_SUMMARY);
}

/**
 * Raises one QUESTION attention per orchestrator notice still unacked after `thresholdMs`.
 * Notices of a run that already raised another attention (BLOCKED) are skipped, so a blocked run
 * keeps exactly one attention. The attention and the message mark commit together; the event is
 * published after commit. Never throws.
 */
export async function sweepNotices(
  db: Db,
  events: BusEvents,
  log: LeaseLog,
  opts: { thresholdMs?: number; now?: () => number; isStopped?: () => boolean } = {},
): Promise<void> {
  const { thresholdMs = NOTICE_ATTENTION_THRESHOLD_MS, now = Date.now, isStopped } = opts;
  try {
    const cutoff = new Date(now() - thresholdMs).toISOString();
    for (const message of db.listStaleOrchestratorNotices(cutoff)) {
      if (isStopped?.()) return;
      try {
        const row = raise(db, message);
        if (row) events.publishEvent(row);
      } catch (e) {
        logError(log, `notice ${message.id} attention failed: ${reason(e)}`);
      }
    }
  } catch (e) {
    logError(log, `notice sweep failed: ${reason(e)}`);
  }
}

function raise(db: Db, message: Message): EventRecord | undefined {
  const run = message.runId ? db.getRun(message.runId) : undefined;
  const checked = BusEventSchema.parse({
    id: 0,
    type: 'attention',
    at: new Date().toISOString(),
    source: 'dromos',
    agentId: null,
    issue: run?.issueNumber ?? null,
    runId: message.runId,
    data: { kind: 'QUESTION', summary: summaryOf(message), pr: null },
  });
  if (checked.type !== 'attention') return undefined;
  return db.transaction(() => {
    const { event } = recordAttention(db, checked);
    db.markNoticeAttentionRaised(message.id);
    return event;
  });
}

function logError(log: LeaseLog, text: string): void {
  try {
    log.logLine('ERROR', text);
  } catch {
    // logging is best effort
  }
}

/** Sweeps every `intervalMs` on an unref'd timer, never overlapping; returns the stop function. */
export function startNoticeSweep(
  db: Db,
  events: BusEvents,
  log: LeaseLog,
  opts: NoticeSweepOptions = {},
): () => void {
  const { intervalMs = NOTICE_SWEEP_INTERVAL_MS, thresholdMs, now } = opts;
  let stopped = false;
  let sweeping = false;
  const sweep = async () => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      await sweepNotices(db, events, log, { thresholdMs, now, isStopped: () => stopped });
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
