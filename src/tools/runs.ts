import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execa } from 'execa';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { ToolContext } from '../context.js';
import { repoFromPath, viewIssue } from '../github.js';
import { isTerminal } from '../state-machine.js';
import { createWorktree, isSafeBranchName, slugify } from '../worktree.js';
import { errorResult, jsonResult } from './util.js';

/** repo_path + issue pairs whose start_run is currently in flight (guards the async gap). */
const inFlight = new Set<string>();

const hasDotDot = (p: string) => p.split(/[\\/]/).includes('..');

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
          .refine((p) => !hasDotDot(p), "repoPath must not contain '..' segments")
          .describe('Absolute path of the local git repository'),
        issue: z.number().int().positive().describe('GitHub issue number'),
        baseBranch: z
          .string()
          .refine(isSafeBranchName, 'baseBranch is not a valid branch name')
          .optional()
          .describe('Base branch (default: config)'),
      },
    },
    async ({ repoPath: rawPath, issue, baseBranch }) => {
      requireRole('start_run', ctx.role, 'orchestrator');
      const repoPath = resolve(rawPath);
      const base = baseBranch ?? ctx.config.baseBranch;
      const key = `${repoPath}#${issue}`;
      if (!isSafeBranchName(base)) {
        return errorResult(`invalid base branch name: ${base}`);
      }
      const existing = ctx.db
        .listRuns()
        .find((r) => r.repoPath === repoPath && r.issueNumber === issue && !isTerminal(r.state));
      if (existing || inFlight.has(key)) {
        return errorResult(
          `issue #${issue} already has an active run in ${repoPath}` +
            (existing ? `: ${existing.id} (${existing.state})` : ' (start in progress)'),
        );
      }
      inFlight.add(key);
      let created: { branch: string; worktreePath: string } | undefined;
      try {
        await execa('git', ['-C', repoPath, 'rev-parse', '--show-toplevel']).catch(() => {
          throw new Error(`not a git repository: ${repoPath}`);
        });
        const repo = await repoFromPath(repoPath);
        const info = await viewIssue(repo, issue);
        const slug = slugify(info.title);
        const branch = slug ? `agent/${issue}-${slug}` : `agent/${issue}`;
        const worktreePath = join(dirname(repoPath), `wt-${basename(repoPath)}-${issue}`);
        await createWorktree(repoPath, base, branch, worktreePath);
        created = { branch, worktreePath };

        const runId = ctx.db.transaction(() => {
          const id = `run-${issue}-${ctx.db.listRuns().filter((r) => r.issueNumber === issue).length + 1}`;
          ctx.db.insertRun({
            id,
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
            runId: id,
            payload: {
              runId: id,
              issue: { number: info.number, title: info.title, body: info.body },
              worktreePath,
              branch,
              baseBranch: base,
              instructions:
                'Implement the issue in worktreePath. Commit your work. When done call submit_implementation.',
            },
          });
          return id;
        });
        ctx.log.logLine('STATE', `${runId} started: implementing (round 1) on ${branch}`);
        ctx.log.logLine('MESSAGE', `orchestrator -> implementer [task] ${runId}`);
        ctx.events.messageFor('implementer');
        return jsonResult({ runId, branch, worktreePath });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const cleanup = created
          ? ` The branch ${created.branch} and worktree ${created.worktreePath} were created and ` +
            'not removed; clean them up manually if unwanted.'
          : '';
        return errorResult(`start_run failed: ${reason}.${cleanup}`);
      } finally {
        inFlight.delete(key);
      }
    },
  );
}
