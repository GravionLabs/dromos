import { execa } from 'execa';
import { z } from 'zod';
import type { PhaseUsageSchema } from '../events/schema.js';
import { modelFor, type RunnerConfig, testCommand } from './config.js';
import type { Harness, HarnessName, PhaseInput, Usage } from './harness.js';
import {
  type RunEvent,
  type RunInput,
  type RunState,
  type Transition,
  transition,
} from './state-machine.js';

/**
 * Implementer phase of one PBI: one fresh harness session per Task (Tasks without a blocked-by link
 * between them run in parallel), or one session for a PBI without Tasks; then the related tests run
 * once and the outcome goes into the state machine. Sessions never run the tests themselves.
 */

/** Lines of failing test output kept for the PR body. */
export const FAILURE_TAIL_LINES = 50;

/** A Task sub-issue; `blockedBy` lists the numbers of other issues it waits for. */
export interface TaskSpec {
  number: number;
  title: string;
  body: string;
  blockedBy: number[];
}

export interface PbiSpec {
  number: number;
  title: string;
  /** The PBI's acceptance criteria, handed to every Task session. */
  acceptanceCriteria: string;
  /** Used as the single task when `tasks` is empty. */
  body: string;
  tasks: TaskSpec[];
}

/** What a session reports; a `failed` session blocks the run. */
export const ImplementResultSchema = z.strictObject({
  status: z.enum(['done', 'failed']),
  summary: z.string(),
});
export type ImplementResult = z.infer<typeof ImplementResultSchema>;

export interface TestOutcome {
  passed: boolean;
  /** Combined stdout and stderr. */
  output: string;
}

/** Phase events as the runner emits them; the bus adds the envelope. */
export type PhaseEventData = {
  phase: string;
  harness: { name: string; version: string | null; sdk: string | null };
  model: string;
};
export type PhaseEnd = PhaseEventData & {
  durationMs: number;
  usage: z.infer<typeof PhaseUsageSchema> | null;
};
export type ImplementerEvent =
  | RunEvent
  | { type: 'phase.started'; data: PhaseEventData }
  | { type: 'phase.finished'; data: PhaseEnd & { unansweredQuestions?: number } }
  | { type: 'phase.failed'; data: PhaseEnd };

export interface ImplementerDeps {
  harness: Harness;
  harnessInfo: PhaseEventData['harness'] & { id: HarnessName };
  config: RunnerConfig;
  /** The worktree the sessions and the tests run in. */
  cwd: string;
  skillDirs: string[];
  allow: PhaseInput['allow'];
  timeoutMs: number;
  /** Runs `command` in `cwd`; replaced in unit tests. */
  runTests?: (command: string, cwd: string) => Promise<TestOutcome>;
  emit: (event: ImplementerEvent) => void;
  now?: () => number;
}

export interface ImplementerOutcome extends Transition {
  /** Last {@link FAILURE_TAIL_LINES} lines of the failing test run, for the PR body. */
  failureTail?: string;
  usage: Usage[];
}

export async function runShell(command: string, cwd: string): Promise<TestOutcome> {
  const res = await execa(command, { cwd, shell: true, reject: false, all: true });
  return { passed: res.exitCode === 0, output: String(res.all ?? '') };
}

/** The last `lines` lines of `output`, trailing blank lines dropped. */
export function tail(output: string, lines = FAILURE_TAIL_LINES): string {
  return output.trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * Orders Tasks into waves: every Task of a wave depends only on earlier waves. Blockers that are not
 * Tasks of this PBI are ignored (they are resolved before the run starts). A cycle throws.
 */
export function planWaves(tasks: TaskSpec[]): TaskSpec[][] {
  const numbers = new Set(tasks.map((t) => t.number));
  const done = new Set<number>();
  let rest = tasks;
  const waves: TaskSpec[][] = [];
  while (rest.length > 0) {
    const wave = rest.filter((t) => t.blockedBy.every((b) => done.has(b) || !numbers.has(b)));
    if (wave.length === 0) {
      throw new Error(
        `Tasks block each other: ${rest.map((t) => `#${String(t.number)}`).join(', ')}`,
      );
    }
    for (const t of wave) done.add(t.number);
    rest = rest.filter((t) => !done.has(t.number));
    waves.push(wave);
  }
  return waves;
}

function taskPrompt(pbi: PbiSpec, task: { number: number; title: string; body: string }): string {
  return [
    `Implement #${String(task.number)}: ${task.title}`,
    `Part of PBI #${String(pbi.number)}: ${pbi.title}`,
    '## Task',
    task.body,
    '## PBI acceptance criteria',
    pbi.acceptanceCriteria,
    'Use the `implementation` skill. Change tests together with the code and commit your work. ' +
      'Do not run the full test suite; the runner runs the tests afterwards.',
  ].join('\n\n');
}

/** Runs `items` in chunks of at most `cap` at a time. */
async function inChunks<T, R>(items: T[], cap: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += cap) {
    out.push(...(await Promise.all(items.slice(i, i + cap).map(fn))));
  }
  return out;
}

/**
 * Runs the implementer phase from the `implementing` state and returns the state after the tests.
 * A failed session, a result that does not match the schema, or red tests block the run.
 */
export async function runImplementerPhase(
  deps: ImplementerDeps,
  pbi: PbiSpec,
  state: RunState & { kind: 'implementing' },
): Promise<ImplementerOutcome> {
  const { config, harnessInfo, emit } = deps;
  const now = deps.now ?? Date.now;
  const maxFixRounds = config.maxFixRounds;
  const model = modelFor(
    config,
    harnessInfo.id,
    state.round === 0 ? 'implementer' : 'implementerRound2',
  );
  const usage: Usage[] = [];
  const send = emit;
  const apply = (s: RunState, input: RunInput): Transition => {
    const t = transition(s, input, maxFixRounds);
    send(t.event);
    return t;
  };

  const sessions =
    pbi.tasks.length === 0
      ? [[{ number: pbi.number, title: pbi.title, body: pbi.body }]]
      : planWaves(pbi.tasks);

  const runSession = async (task: {
    number: number;
    title: string;
    body: string;
  }): Promise<ImplementResult> => {
    const phase = `implementer #${String(task.number)}`;
    const base = { phase, harness: harnessInfo, model };
    send({ type: 'phase.started', data: base });
    const start = now();
    const end = (u: Usage | null) => ({ ...base, durationMs: now() - start, usage: u });
    try {
      const out = await deps.harness.runPhase({
        prompt: taskPrompt(pbi, task),
        cwd: deps.cwd,
        model,
        skills: deps.skillDirs,
        allow: deps.allow,
        schema: ImplementResultSchema,
        timeoutMs: deps.timeoutMs,
      });
      const result = ImplementResultSchema.parse(out.result);
      if (out.usage) usage.push(out.usage);
      send({
        type: result.status === 'done' ? 'phase.finished' : 'phase.failed',
        data: end(out.usage),
      });
      return result;
    } catch (error) {
      send({ type: 'phase.failed', data: end(null) });
      return { status: 'failed', summary: error instanceof Error ? error.message : String(error) };
    }
  };

  for (const wave of sessions) {
    const results = await inChunks(wave, config.parallel, runSession);
    const failed = results.findIndex((r) => r.status === 'failed');
    if (failed !== -1) {
      const t = apply(state, {
        type: 'abort',
        reason: `implementer #${String(wave[failed]?.number)} failed: ${results[failed]?.summary}`,
      });
      return { ...t, usage };
    }
  }

  const implemented = apply(state, { type: 'implemented' });
  const run = deps.runTests ?? runShell;
  const outcome = await run(testCommand(config), deps.cwd);
  if (outcome.passed) {
    return { ...apply(implemented.state, { type: 'tests_passed' }), usage };
  }
  const failureTail = tail(outcome.output);
  const last = failureTail.split('\n').at(-1) ?? '';
  const t = apply(implemented.state, { type: 'tests_failed', summary: last || 'tests failed' });
  return { ...t, failureTail, usage };
}
