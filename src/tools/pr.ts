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

/** Run ids with an open_pr in progress. */
const inFlight = new Set<string>();

function lastLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

export function registerPrTools(server: McpServer, ctx: ToolContext): void {
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
        let prUrl: string;
        try {
          await execa('git', ['-C', run.worktreePath, 'push', '-u', 'origin', run.branch], {
            timeout: EXEC_TIMEOUT_MS,
          });
          const { stdout } = await execa(
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
          prUrl = lastLine(String(stdout));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const current = ctx.db.getRun(runId);
        if (current?.state !== 'approved') {
          return errorResult(`run ${runId} is no longer approved`);
        }
        const moved = ctx.db.transaction(() => {
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
