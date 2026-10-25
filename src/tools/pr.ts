import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execa } from 'execa';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { ToolContext } from '../context.js';
import { buildPrBody } from '../pr-body.js';
import { afterRunTransition } from '../run-lease.js';
import { transition } from '../state-machine.js';
import { errorResult, jsonResult, logAndWake } from './util.js';

const EXEC_TIMEOUT_MS = 120_000;

/** First line of stderr (credentials masked), or a generic message; never the command line. */
function failure(step: string, err: unknown): string {
  const e = err as { timedOut?: boolean; stderr?: unknown } | null;
  if (e?.timedOut) return `${step} timed out`;
  const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!first) return `${step} failed`;
  return `${step} failed: ${first.replace(/\/\/[^@\s/]+@/g, '//***@').slice(0, 300)}`;
}

function parsePrUrl(stdout: string): string | undefined {
  const candidate = lastLine(stdout);
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && candidate === url.href.replace(/\/$/, '')
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function lastLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

/** Run ids with an open_pr in progress, one set per bus (its db), shared by all sessions. */
const inFlightByBus = new WeakMap<object, Set<string>>();

function inFlightFor(ctx: ToolContext): Set<string> {
  let set = inFlightByBus.get(ctx.db);
  if (!set) {
    set = new Set();
    inFlightByBus.set(ctx.db, set);
  }
  return set;
}

export function registerPrTools(server: McpServer, ctx: ToolContext): void {
  const inFlight = inFlightFor(ctx);
  const logError = (text: string) => {
    try {
      ctx.log.logLine('ERROR', text);
    } catch {
      // best effort
    }
  };
  server.registerTool(
    'open_pr',
    {
      description:
        'Orchestrator only. Push the branch of an approved run and open a GitHub pull request. ' +
        'Never merges. On failure the run stays approved so the call can be retried.',
      inputSchema: {
        runId: z.string().min(1).describe('Run id'),
        draft: z.boolean().optional().describe('Open the PR as a draft (default false)'),
      },
    },
    async ({ runId, draft }) => {
      requireRole('open_pr', ctx.role, 'orchestrator');
      const run = ctx.db.getRun(runId);
      if (!run) return errorResult(`unknown run: ${runId}`);
      if (run.state !== 'approved') {
        return errorResult(`run ${runId} is ${run.state}; open_pr requires approved`);
      }
      if (inFlight.has(runId)) return errorResult(`open_pr already in progress for run ${runId}`);
      inFlight.add(runId);
      try {
        let stdout: string;
        try {
          await execa(
            'git',
            [
              '-c',
              'core.hooksPath=/dev/null',
              '-C',
              run.worktreePath,
              'push',
              '-u',
              'origin',
              '--',
              run.branch,
            ],
            { timeout: EXEC_TIMEOUT_MS },
          );
        } catch (err) {
          const message = failure('git push', err);
          logError(`${runId} open_pr: ${message}`);
          return errorResult(message);
        }
        try {
          const out = await execa(
            'gh',
            [
              'pr',
              'create',
              '-R',
              run.repo,
              '--base',
              run.baseBranch,
              '--head',
              run.branch,
              '--title',
              `${run.issueTitle} (#${run.issueNumber})`,
              '--body-file',
              '-',
              ...(draft ? ['--draft'] : []),
            ],
            { input: buildPrBody(run), timeout: EXEC_TIMEOUT_MS },
          );
          stdout = String(out.stdout);
        } catch (err) {
          const message = failure('gh pr create', err);
          logError(`${runId} open_pr: ${message}`);
          return errorResult(message);
        }
        const prUrl = parsePrUrl(stdout);
        if (!prUrl) {
          logError(`${runId} open_pr: gh printed no PR url`);
          return errorResult('gh pr create printed no https PR url; run stays approved');
        }
        const current = ctx.db.getRun(runId);
        if (current?.state !== 'approved') {
          logError(`${runId} open_pr: PR ${prUrl} created but run is ${current?.state}`);
          return errorResult(
            `PR ${prUrl} was created but run ${runId} is no longer approved (${current?.state})`,
          );
        }
        let moved: ReturnType<typeof transition>;
        try {
          moved = ctx.db.transaction(() => {
            const next = transition(current, { type: 'pr_opened' }, ctx.config.maxRounds);
            ctx.db.updateRun(runId, { prUrl, state: next.state });
            ctx.db.insertMessage({
              from: 'orchestrator',
              to: 'orchestrator',
              type: 'notice',
              runId,
              payload: { runId, event: 'pr_opened', prUrl },
            });
            return next;
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logError(`${runId} open_pr: PR ${prUrl} created but state update failed: ${reason}`);
          return errorResult(
            `PR ${prUrl} was created but recording it failed: ${reason}; run stays approved`,
          );
        }
        void afterRunTransition(ctx, { ...current, state: moved.state });
        try {
          ctx.log.logLine('STATE', `${runId} ${moved.state} (round ${moved.round})`);
        } catch {
          // The outcome is committed; logging is best effort.
        }
        try {
          logAndWake(ctx, 'orchestrator', 'orchestrator', 'notice', runId);
        } catch {
          // Best effort.
        }
        return jsonResult({ prUrl });
      } finally {
        inFlight.delete(runId);
      }
    },
  );
}
