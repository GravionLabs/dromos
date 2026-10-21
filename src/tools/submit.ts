import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execa } from 'execa';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { ToolContext } from '../context.js';
import type { Run } from '../db.js';
import { resolveGateCommands, runGate } from '../gate.js';
import type { GateResult, MessageType, Role } from '../schemas.js';
import { transition } from '../state-machine.js';
import { errorResult, jsonResult } from './util.js';

/** Background gates by run id; tests await these to observe completion. */
export const pendingGates = new Map<string, Promise<void>>();

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function git(worktreePath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', worktreePath, ...args]);
  return String(stdout).trim();
}

function notify(ctx: ToolContext, from: Role, to: Role, type: MessageType, runId: string): void {
  try {
    ctx.log.logLine('MESSAGE', `${from} -> ${to} [${type}] ${runId}`);
    ctx.events.messageFor(to);
  } catch {
    // best effort
  }
}

async function evaluateGate(ctx: ToolContext, run: Run): Promise<GateResult> {
  try {
    const commands = resolveGateCommands(run.worktreePath, ctx.config.gate.commands);
    return await runGate(commands, run.worktreePath, ctx.config.gate.timeoutSeconds);
  } catch (err) {
    ctx.log.logLine('ERROR', `${run.id} gate crashed: ${errorMessage(err)}`);
    return {
      passed: false,
      steps: [
        {
          name: 'gate',
          command: '',
          exitCode: 1,
          durationMs: 0,
          outputTail: `gate crashed: ${errorMessage(err)}`,
        },
      ],
    };
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type Outbound = { from: Role; to: Role; type: MessageType };

/** Persists the gate outcome, state change and outgoing message atomically. */
function applyGateResult(
  ctx: ToolContext,
  run: Run,
  summary: string,
  gate: GateResult,
): Outbound | undefined {
  const next = transition(
    run,
    { type: gate.passed ? 'gate_passed' : 'gate_failed' },
    ctx.config.maxRounds,
  );
  ctx.db.updateRun(run.id, { lastGate: gate, state: next.state, round: next.round });
  const runId = run.id;
  if (gate.passed) {
    const diffCommand = `git -C ${shellQuote(run.worktreePath)} diff ${shellQuote(`origin/${run.baseBranch}`)}...HEAD`;
    ctx.db.insertMessage({
      from: 'implementer',
      to: 'reviewer',
      type: 'review_request',
      runId,
      payload: {
        runId,
        worktreePath: run.worktreePath,
        branch: run.branch,
        baseBranch: run.baseBranch,
        issue: { number: run.issueNumber, title: run.issueTitle },
        implementationSummary: summary,
        diffCommand,
        instructions: 'Review the diff read-only. Call submit_review.',
      },
    });
    return { from: 'implementer', to: 'reviewer', type: 'review_request' };
  }
  if (next.state === 'blocked') {
    ctx.db.insertMessage({
      from: 'implementer',
      to: 'orchestrator',
      type: 'notice',
      runId,
      payload: { runId, reason: 'round limit reached', lastGate: gate },
    });
    return { from: 'implementer', to: 'orchestrator', type: 'notice' };
  }
  const failed = gate.steps.find((s) => s.exitCode !== 0) ?? gate.steps[gate.steps.length - 1];
  ctx.db.insertMessage({
    from: 'orchestrator',
    to: 'implementer',
    type: 'gate_result',
    runId,
    payload: {
      runId,
      round: next.round,
      passed: false,
      failedStep: failed?.name,
      exitCode: failed?.exitCode,
      outputTail: failed?.outputTail ?? '',
      steps: gate.steps.map((s) => ({ name: s.name, exitCode: s.exitCode })),
    },
  });
  return { from: 'orchestrator', to: 'implementer', type: 'gate_result' };
}

function handleGateResult(
  ctx: ToolContext,
  runId: string,
  summary: string,
  gate: GateResult,
): void {
  const run = ctx.db.getRun(runId);
  if (run?.state !== 'gating') {
    ctx.log.logLine('ERROR', `${runId} gate result dropped: run is in state ${run?.state}`);
    return;
  }
  const out = ctx.db.transaction(() => applyGateResult(ctx, run, summary, gate));
  const after = ctx.db.getRun(runId);
  ctx.log.logLine('GATE', `${runId} ${gate.passed ? 'passed' : 'failed'}`);
  ctx.log.logLine('STATE', `${runId} ${after?.state} (round ${after?.round})`);
  if (out) notify(ctx, out.from, out.to, out.type, runId);
}

async function runInBackground(ctx: ToolContext, run: Run, summary: string): Promise<void> {
  try {
    const gate = await evaluateGate(ctx, run);
    handleGateResult(ctx, run.id, summary, gate);
  } catch (err) {
    ctx.log.logLine('ERROR', `${run.id} gate handling failed: ${errorMessage(err)}`);
  } finally {
    pendingGates.delete(run.id);
  }
}

export function registerSubmitTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'submit_implementation',
    {
      description:
        'Implementer only. Hand in committed work. The bus runs the build/test/lint gate in the ' +
        'background and sends the result as a message; returns immediately with gate_started.',
      inputSchema: {
        runId: z.string().min(1).describe('Run id'),
        summary: z.string().min(1).max(5000).describe('What was implemented'),
      },
    },
    async ({ runId, summary }) => {
      requireRole('submit_implementation', ctx.role, 'implementer');
      const run = ctx.db.getRun(runId);
      if (!run) return errorResult(`unknown run: ${runId}`);
      if (run.state !== 'implementing') {
        return errorResult(
          `run ${runId} is in state '${run.state}', submit_implementation needs 'implementing'`,
        );
      }
      try {
        if ((await git(run.worktreePath, 'status', '--porcelain')) !== '') {
          return errorResult('uncommitted changes in the worktree: commit everything first');
        }
        const ahead = Number(
          await git(run.worktreePath, 'rev-list', '--count', `origin/${run.baseBranch}..HEAD`),
        );
        if (!(ahead > 0)) {
          return errorResult(
            `no commits ahead of origin/${run.baseBranch}: commit your work first`,
          );
        }
      } catch (err) {
        return errorResult(`could not inspect the worktree: ${errorMessage(err)}`);
      }
      // Re-read: the run may have moved while git was running.
      const fresh = ctx.db.getRun(runId);
      if (fresh?.state !== 'implementing' || pendingGates.has(runId)) {
        return errorResult(`run ${runId} is no longer in state 'implementing'`);
      }
      const next = transition(fresh, { type: 'implementation_submitted' }, ctx.config.maxRounds);
      ctx.db.updateRun(runId, { state: next.state, round: next.round });
      ctx.log.logLine('STATE', `${runId} ${next.state} (round ${next.round})`);
      pendingGates.set(runId, runInBackground(ctx, fresh, summary));
      return jsonResult({ status: 'gate_started' });
    },
  );
}
