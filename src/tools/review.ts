import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { ToolContext } from '../context.js';
import type { Finding, Review, Severity } from '../schemas.js';
import { ReviewSchema } from '../schemas.js';
import { InvalidTransitionError, isBlocking, transition } from '../state-machine.js';
import { errorResult, jsonResult, logAndWake } from './util.js';

const SEVERITIES: Severity[] = ['critical', 'important', 'suggestion'];

/** Blocking findings first, suggestions after; order within each group is kept. */
function sortFindings(findings: Finding[], blocking: Severity[]): Finding[] {
  const isBlockingFinding = (f: Finding) => blocking.includes(f.severity);
  return [...findings.filter(isBlockingFinding), ...findings.filter((f) => !isBlockingFinding(f))];
}

function countLine(runId: string, review: Review): string {
  const counts = SEVERITIES.map(
    (s) => `${s}=${review.findings.filter((f) => f.severity === s).length}`,
  ).join(' ');
  return `${runId} verdict=${review.verdict} ${counts}`;
}

export function registerReviewTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'submit_review',
    {
      description:
        'Reviewer only. Hand in the structured review of the current run. Severity of a finding: ' +
        "use 'critical' for bugs, security issues and data loss, 'important' for things that " +
        "must change before merge, 'suggestion' for optional improvements. Only critical and " +
        'important findings (or verdict changes) block: the work then goes back to the ' +
        'implementer. Otherwise the run is approved.',
      inputSchema: {
        runId: z.string().min(1).describe('Run id'),
        review: ReviewSchema.describe('The review: verdict, summary and findings'),
      },
    },
    async ({ runId, review }) => {
      requireRole('submit_review', ctx.role, 'reviewer');
      const run = ctx.db.getRun(runId);
      if (!run) return errorResult(`unknown run: ${runId}`);
      if (run.state !== 'reviewing') {
        return errorResult(
          `run ${runId} is in state '${run.state}', submit_review needs 'reviewing'`,
        );
      }
      const blocking = isBlocking(review, ctx.config.blockingSeverities);
      let out: { to: 'orchestrator' | 'implementer'; type: 'notice' | 'review_result' };
      let next: { state: string; round: number };
      try {
        const result = ctx.db.transaction(() => {
          const moved = transition(
            run,
            { type: blocking ? 'review_changes' : 'review_approved' },
            ctx.config.maxRounds,
          );
          ctx.db.updateRun(runId, {
            lastReview: review,
            state: moved.state,
            round: moved.round,
          });
          const findings = sortFindings(review.findings, ctx.config.blockingSeverities);
          if (moved.state === 'implementing') {
            ctx.db.insertMessage({
              from: 'reviewer',
              to: 'implementer',
              type: 'review_result',
              runId,
              payload: { runId, round: moved.round, findings, summary: review.summary },
            });
            return { moved, out: { to: 'implementer', type: 'review_result' } as const };
          }
          ctx.db.insertMessage({
            from: 'reviewer',
            to: 'orchestrator',
            type: 'notice',
            runId,
            payload:
              moved.state === 'approved'
                ? { runId, event: 'approved', summary: review.summary }
                : {
                    runId,
                    event: 'blocked',
                    reason: 'round limit reached',
                    summary: review.summary,
                    findings,
                  },
          });
          return { moved, out: { to: 'orchestrator', type: 'notice' } as const };
        });
        next = result.moved;
        out = result.out;
      } catch (err) {
        if (err instanceof InvalidTransitionError) return errorResult(err.message);
        throw err;
      }
      try {
        ctx.log.logLine('REVIEW', countLine(runId, review));
        ctx.log.logLine('STATE', `${runId} ${next.state} (round ${next.round})`);
      } catch {
        // The outcome is committed; logging is best effort.
      }
      logAndWake(ctx, 'reviewer', out.to, out.type, runId);
      return jsonResult({ status: next.state, round: next.round });
    },
  );
}
