import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execa } from 'execa';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { ToolContext } from '../context.js';
import type { Run } from '../db.js';
import { resolveGateCommands, runGate } from '../gate.js';
import type { GateResult, MessageType, Role } from '../schemas.js';
import { transition } from '../state-machine.js';
import { isSafeBranchName } from '../worktree.js';
import { errorResult, jsonResult, logAndWake } from './util.js';

/** Background gates by run id; tests await these to observe completion. */
export const pendingGates = new Map<string, Promise<void>>();

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const GIT_TIMEOUT_MS = 30_000;

async function git(worktreePath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', worktreePath, ...args], {
    timeout: GIT_TIMEOUT_MS,
  });
  return String(stdout).trim();
}

/** A failed single-step gate describing why the real gate could not produce a result. */
const failedGate = (name: string, outputTail: string): GateResult => ({
  passed: false,
  steps: [{ name, command: '', exitCode: 1, durationMs: 0, outputTail }],
});

async function evaluateGate(ctx: ToolContext, run: Run): Promise<GateResult> {
  try {
    const commands = resolveGateCommands(run.worktreePath, ctx.config.gate.commands);
    return await runGate(commands, run.worktreePath, ctx.config.gate.timeoutSeconds);
  } catch (err) {
    ctx.log.logLine('ERROR', `${run.id} gate crashed: ${errorMessage(err)}`);
    return failedGate('gate', `gate crashed: ${errorMessage(err)}`);
  }
}

/** Masks obvious credentials before gate output is stored or relayed to another agent. */
export function redact(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi,
      '$1=[redacted]',
    );
}

const redactGate = (gate: GateResult): GateResult => ({
  ...gate,
  steps: gate.steps.map((step) => ({ ...step, outputTail: redact(step.outputTail) })),
});

/** Leaves plain paths and refs untouched (spec form) and single-quotes anything else. */
const shellArg = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

type Outbound = { from: Role; to: Role; type: MessageType };

/** Persists the (already redacted) gate outcome, state change and outgoing message atomically. */
function applyGateResult(ctx: ToolContext, run: Run, summary: string, gate: GateResult): Outbound {
  const next = transition(
    run,
    { type: gate.passed ? 'gate_passed' : 'gate_failed' },
    ctx.config.maxRounds,
  );
  ctx.db.updateRun(run.id, { lastGate: gate, state: next.state, round: next.round });
  const runId = run.id;
  if (gate.passed) {
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
        diffCommand: `git -C ${shellArg(run.worktreePath)} diff origin/${run.baseBranch}...HEAD`,
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
  const failed = gate.steps.find((step) => step.exitCode !== 0) ?? gate.steps.at(-1);
  ctx.db.insertMessage({
    from: 'orchestrator',
    to: 'implementer',
    type: 'gate_result',
    runId,
    payload: {
      runId,
      round: next.round,
      failedStep: failed?.name,
      exitCode: failed?.exitCode,
      outputTail: failed?.outputTail ?? '',
    },
  });
  return { from: 'orchestrator', to: 'implementer', type: 'gate_result' };
}

function handleGateResult(ctx: ToolContext, runId: string, summary: string, raw: GateResult): void {
  const run = ctx.db.getRun(runId);
  if (run?.state !== 'gating') {
    ctx.log.logLine('ERROR', `${runId} gate result dropped: run is in state ${run?.state}`);
    return;
  }
  const gate = redactGate(raw);
  const out = ctx.db.transaction(() => applyGateResult(ctx, run, summary, gate));
  const after = ctx.db.getRun(runId);
  ctx.log.logLine('GATE', `${runId} ${gate.passed ? 'passed' : 'failed'}`);
  ctx.log.logLine('STATE', `${runId} ${after?.state} (round ${after?.round})`);
  logAndWake(ctx, out.from, out.to, out.type, runId);
}

/**
 * Last resort when even the gate_failed fallback could not be persisted: never leave the run
 * stuck in gating. Blocks it and, if the database still accepts writes, notifies the orchestrator.
 */
function blockStuckRun(ctx: ToolContext, runId: string, gate: GateResult): void {
  try {
    if (ctx.db.getRun(runId)?.state !== 'gating') return;
    const lastGate = redactGate(gate);
    try {
      ctx.db.transaction(() => {
        ctx.db.updateRun(runId, { state: 'blocked', lastGate });
        ctx.db.insertMessage({
          from: 'implementer',
          to: 'orchestrator',
          type: 'notice',
          runId,
          payload: { runId, reason: 'gate handling failed', lastGate },
        });
      });
    } catch (err) {
      ctx.log.logLine('ERROR', `${runId} could not notify the orchestrator: ${errorMessage(err)}`);
      ctx.db.updateRun(runId, { state: 'blocked' });
      ctx.log.logLine('STATE', `${runId} blocked (gate handling failed)`);
      return;
    }
    ctx.log.logLine('STATE', `${runId} blocked (gate handling failed)`);
    logAndWake(ctx, 'implementer', 'orchestrator', 'notice', runId);
  } catch (err) {
    ctx.log.logLine('ERROR', `${runId} could not block stuck run: ${errorMessage(err)}`);
  }
}

async function runInBackground(ctx: ToolContext, run: Run, summary: string): Promise<void> {
  try {
    const gate = await evaluateGate(ctx, run);
    try {
      handleGateResult(ctx, run.id, summary, gate);
    } catch (err) {
      // Spec: log every background error as ERROR and treat it as gate_failed.
      ctx.log.logLine('ERROR', `${run.id} gate handling failed: ${errorMessage(err)}`);
      const fallback = failedGate('gate', `gate handling failed: ${errorMessage(err)}`);
      try {
        handleGateResult(ctx, run.id, summary, fallback);
      } catch (fallbackErr) {
        ctx.log.logLine(
          'ERROR',
          `${run.id} gate_failed fallback failed: ${errorMessage(fallbackErr)}`,
        );
        blockStuckRun(ctx, run.id, fallback);
      }
    }
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
      if (!isSafeBranchName(run.baseBranch)) {
        return errorResult(`run ${runId} has an invalid base branch: ${run.baseBranch}`);
      }
      try {
        if ((await git(run.worktreePath, 'status', '--porcelain')) !== '') {
          return errorResult('uncommitted changes in the worktree: commit everything first');
        }
        const ahead = Number(
          await git(
            run.worktreePath,
            'rev-list',
            '--count',
            `origin/${run.baseBranch}..HEAD`,
            '--',
          ),
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
