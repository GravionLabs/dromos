import { basename, dirname, isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { ToolContext } from '../context.js';
import { repoFromPath, viewIssue } from '../github.js';
import type { RunState } from '../schemas.js';
import { createWorktree, slugify } from '../worktree.js';
import { errorResult, jsonResult } from './util.js';

const TERMINAL_STATES: RunState[] = ['pr_opened', 'blocked'];

export function registerRunTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'start_run',
    {
      description:
        'Orchestrator only. Fetch a GitHub issue, create an agent/<issue>-<slug> branch and git ' +
        'worktree, register a run and send the task to the implementer.',
      inputSchema: {
        repoPath: z
          .string()
          .refine((p) => isAbsolute(p), 'repoPath must be an absolute path')
          .describe('Absolute path of the local repository'),
        issue: z.number().int().positive().describe('GitHub issue number'),
        baseBranch: z.string().min(1).optional().describe('Base branch (default: config)'),
      },
    },
    async ({ repoPath, issue, baseBranch }) => {
      requireRole('start_run', ctx.role, 'orchestrator');
      const base = baseBranch ?? ctx.config.baseBranch;
      try {
        const existing = ctx.db
          .listRuns()
          .find(
            (r) =>
              r.repoPath === repoPath &&
              r.issueNumber === issue &&
              !TERMINAL_STATES.includes(r.state),
          );
        if (existing) {
          return errorResult(
            `issue #${issue} already has an active run in ${repoPath}: ${existing.id} (${existing.state})`,
          );
        }
        const repo = await repoFromPath(repoPath);
        const info = await viewIssue(repo, issue);
        const branch = `agent/${issue}-${slugify(info.title)}`;
        const worktreePath = join(dirname(repoPath), `wt-${basename(repoPath)}-${issue}`);
        await createWorktree(repoPath, base, branch, worktreePath);

        const runId = `run-${issue}-${ctx.db.listRuns().filter((r) => r.issueNumber === issue).length + 1}`;
        ctx.db.insertRun({
          id: runId,
          repo,
          repoPath,
          issueNumber: issue,
          issueTitle: info.title,
          baseBranch: base,
          branch,
          worktreePath,
          state: 'implementing',
          round: 1,
        });
        ctx.db.insertMessage({
          from: 'orchestrator',
          to: 'implementer',
          type: 'task',
          runId,
          payload: {
            runId,
            issue: { number: info.number, title: info.title, body: info.body },
            worktreePath,
            branch,
            baseBranch: base,
            instructions:
              'Implement the issue in worktreePath. Commit your work. When done call submit_implementation.',
          },
        });
        ctx.log.logLine('STATE', `${runId} started: implementing (round 1) on ${branch}`);
        ctx.log.logLine('MESSAGE', `orchestrator -> implementer [task] ${runId}`);
        ctx.events.messageFor('implementer');
        return jsonResult({ runId, branch, worktreePath });
      } catch (err) {
        return errorResult(`start_run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
