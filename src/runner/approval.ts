import { ackAttention, answerAttention, recordAttention } from '../attention.js';
import type { AttentionRecord, Db } from '../db.js';
import { collectEvents } from '../run-metrics.js';

/** Attention kind of a created issue that waits for the `approved` label. */
export const APPROVAL_KIND = 'APPROVAL';

const SOURCE = 'dromos';
const ACKED_BY = 'dromos';

/**
 * Stores one open `APPROVAL` attention for an issue the planner created. `summary` is
 * `[Level] title`, `pr` is null. The herdr plugin shows it; it never polls GitHub (#103).
 */
export function raiseApproval(
  db: Db,
  input: { repo: string; issue: number; runId: string; level: string; title: string },
): AttentionRecord {
  return recordAttention(
    db,
    {
      id: 0,
      type: 'attention',
      at: new Date().toISOString(),
      source: SOURCE,
      agentId: null,
      issue: input.issue,
      runId: input.runId,
      data: { kind: APPROVAL_KIND, summary: `[${input.level}] ${input.title}`, pr: null },
    },
    { repo: input.repo },
  ).attention;
}

/**
 * Acks the open `APPROVAL` attentions of `issue` in `repo` (answered with `approved`, then acked).
 * Call it when the issue carries the `approved` label. Returns the number of acked attentions;
 * an issue without an open approval, or one of another repository, is left alone.
 */
export function ackApproval(db: Db, repo: string, issue: number): number {
  let acked = 0;
  for (const event of collectEvents(db, { repo, issue, types: ['attention'] })) {
    const attention = db.getAttention(event.id);
    if (attention?.kind !== APPROVAL_KIND || attention.state === 'acked') continue;
    if (attention.state === 'open') {
      const answered = answerAttention(db, attention.id, 'approved', ACKED_BY);
      if (answered.outcome !== 'ok') continue;
    }
    if (ackAttention(db, attention.id, ACKED_BY).outcome === 'ok') acked += 1;
  }
  return acked;
}
