import { isAbsolute, join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execa } from 'execa';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { hasDotDot } from '../config.js';
import type { ToolContext } from '../context.js';
import { repoFromPath, viewIssue } from '../github.js';
import { LeaseConflictError } from '../lease.js';
import { claimRunLease, releaseRunLease } from '../run-lease.js';
import { isTerminal } from '../state-machine.js';
import {
  assertWorktreeDirIgnored,
  createWorktree,
  ensureWorktreeParent,
  isSafeBranchName,
  slugify,
} from '../worktree.js';
import { errorResult, jsonResult } from './util.js';

/** repo_path + issue pairs whose start_run is currently in flight (guards the async gap). */
const inFlight = new Set<string>();

/** Bug issue: label `bug` (any case) or a title starting with `fix` (whole word) or `[bug]`. */
function isBugIssue(info: { title: string; labels: string[] }): boolean {
  return info.labels.some((l) => l.toLowerCase() === 'bug') || /^(fix\b|\[bug\])/i.test(info.title);
}

export function registerRunTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'start_run',
    {
      description:
        'Orchestrator only. Fetch a GitHub issue, create a <type>/<issue>-<slug> branch (type feat, or fix for bug issues; config branchPrefix overrides) and git ' +
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
      const base = baseBranch ?? ctx.config.baseBranch;
      if (!isSafeBranchName(base)) {
        return errorResult(`invalid base branch name: ${base}`);
      }
      let repoPath: string;
      try {
        const { stdout } = await execa('git', [
          '-C',
          resolve(rawPath),
          'rev-parse',
          '--show-toplevel',
        ]);
        repoPath = String(stdout).trim();
        if (!repoPath) throw new Error('empty toplevel');
      } catch {
        return errorResult(`not a git repository: ${resolve(rawPath)}`);
      }
      const key = `${repoPath}#${issue}`;
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
      let leasePath: string | undefined;
      let created: { branch: string; worktreePath: string } | undefined;
      let started: { runId: string; branch: string; worktreePath: string } | undefined;
      try {
        await assertWorktreeDirIgnored(repoPath, ctx.config.worktreeDir);
        const repo = await repoFromPath(repoPath);
        const info = await viewIssue(repo, issue);
        const slug = slugify(info.title);
        const prefix =
          ctx.config.branchPrefix === 'conventional'
            ? isBugIssue(info)
              ? 'fix'
              : 'feat'
            : ctx.config.branchPrefix;
        const branch = slug ? `${prefix}/${issue}-${slug}` : `${prefix}/${issue}`;
        if (!isSafeBranchName(branch)) {
          return errorResult(`invalid branch name: ${branch}; nothing was created`);
        }
        const worktreePath = join(repoPath, ctx.config.worktreeDir, String(issue));
        try {
          await claimRunLease({ repoPath, issue, branch, worktreePath });
          leasePath = worktreePath;
        } catch (e) {
          if (e instanceof LeaseConflictError) {
            return errorResult(`${e.message}; nothing was created`);
          }
          throw e;
        }
        await createWorktree(repoPath, base, branch, worktreePath, () =>
          ensureWorktreeParent(repoPath, worktreePath),
        );
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
          // First run tool call of this agent pins its run_id; later calls keep it.
          ctx.db.setAgentRun(ctx.agentId, id);
          return id;
        });
        started = { runId, branch, worktreePath };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (leasePath) {
          await releaseRunLease({ repoPath, worktreePath: leasePath, issueNumber: issue }, (m) =>
            ctx.log.logLine('ERROR', m),
          );
        }
        const cleanup = created
          ? ` The branch ${created.branch} and worktree ${created.worktreePath} were created and ` +
            'not removed; clean them up manually if unwanted.'
          : '';
        return errorResult(`start_run failed: ${reason}.${cleanup}`);
      } finally {
        inFlight.delete(key);
      }
      if (!started) return errorResult('start_run failed: run was not created');
      // The run is committed; notification problems must not turn it into a failure.
      try {
        ctx.log.logLine(
          'STATE',
          `${started.runId} started: implementing (round 1) on ${started.branch}`,
        );
        ctx.log.logLine('MESSAGE', `orchestrator -> implementer [task] ${started.runId}`);
        ctx.events.messageFor('implementer');
      } catch {
        // best effort
      }
      return jsonResult(started);
    },
  );
}
