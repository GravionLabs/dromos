import { execa } from 'execa';
import { z } from 'zod';
import { modelFor, stepTimeoutMs, testCommand } from './config.js';
import { type CreatePrInput, comment, createPr, type PullRequest } from './github.js';
import type { Usage } from './harness.js';
import {
  formatChanged,
  type ImplementerDeps,
  type ImplementerEvent,
  type PbiSpec,
  runShell,
  type TestOutcome,
  tail,
} from './implementer.js';
import { findingFingerprint, parseTestSummary } from './outcome.js';
import { type RunInput, type RunState, type Transition, transition } from './state-machine.js';

/**
 * Reviewer phase of one PBI: one reviewer session over `git diff <base>...HEAD`; blocking findings
 * start one fix round (an implementer session with the round-2 model), the tests run again, and the
 * PR is opened. Red tests after the last round still open a draft PR so the work is not lost.
 */

export const FindingSchema = z.strictObject({
  file: z.string(),
  /** The code-review rule or category; part of the finding's fingerprint. */
  rule: z.string().optional(),
  line: z.number().int().nonnegative(),
  title: z.string().min(1),
  why: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** What the reviewer reports; `blocking` findings start a fix round, `notes` go to a PR comment. */
export const ReviewResultSchema = z.strictObject({
  blocking: z.array(FindingSchema),
  notes: z.array(z.string()),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** The fix session reports like an implementer session. */
const FixResultSchema = z.strictObject({
  status: z.enum(['done', 'failed']),
  summary: z.string(),
});

/** A commit of the PBI branch. */
export interface Commit {
  sha: string;
  subject: string;
}

export interface GithubOps {
  createPr: (repo: string, input: CreatePrInput) => Promise<PullRequest>;
  /** Comments on the pull request (`gh issue comment` accepts PR numbers). */
  comment: (repo: string, number: number, body: string) => Promise<void>;
}

export interface ReviewDeps extends ImplementerDeps {
  repo: string;
  /** The integration branch the PR targets. */
  base: string;
  /** The PBI branch. */
  branch: string;
  github?: GithubOps;
  /** Commits of `<base>..HEAD`, oldest first; replaced in unit tests. */
  listCommits?: (base: string, cwd: string) => Promise<Commit[]>;
}

export interface ReviewOutcome extends Transition {
  review?: ReviewResult;
  /** Set when a PR was opened (ready, or draft after red tests). */
  pr?: PullRequest & { draft: boolean };
  failureTail?: string;
  usage: Usage[];
}

export async function gitCommits(base: string, cwd: string): Promise<Commit[]> {
  const res = await execa(
    'git',
    ['-C', cwd, 'log', '--reverse', '--format=%H%x09%s', `origin/${base}..HEAD`],
    { reject: false },
  );
  return String(res.stdout)
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [sha = '', ...subject] = l.split('\t');
      return { sha, subject: subject.join('\t') };
    });
}

function reviewPrompt(pbi: PbiSpec, base: string): string {
  return [
    `Review the implementation of PBI #${String(pbi.number)}: ${pbi.title}`,
    `Run \`git diff origin/${base}...HEAD\` and review that diff with the \`code-review\` skill.`,
    '## Issue',
    pbi.body,
    '## Acceptance criteria',
    pbi.acceptanceCriteria,
    'Every requirement of the issue counts like an acceptance criterion, Technical Notes included ' +
      '(for example "put X in the PR body"). ' +
      'Check names, shapes and claims in the diff against the code that emits or consumes them, ' +
      'not only against the tests in the diff. ' +
      'A claim about another repository or about CI that you cannot verify from this repository is blocking.',
    'Report as `blocking` only what must be fixed before merge: correctness bugs, security problems ' +
      'and unmet requirements. Everything else goes into `notes`. Do not change files.',
  ].join('\n\n');
}

function fixPrompt(pbi: PbiSpec, findings: Finding[]): string {
  const list = findings.map((f) => `- ${f.file}:${String(f.line)} ${f.title}: ${f.why}`).join('\n');
  return [
    `Fix the blocking review findings of PBI #${String(pbi.number)}: ${pbi.title}`,
    '## Findings',
    list,
    '## PBI acceptance criteria',
    pbi.acceptanceCriteria,
    'Use the `implementation` skill. Change tests together with the code and commit your work. ' +
      'Do not run the full test suite; the runner runs the tests afterwards.',
  ].join('\n\n');
}

/** Task list with the commit SHA of each Task; a Task without a commit is not delivered. */
export function taskLines(pbi: PbiSpec, commits: Commit[]): { list: string[]; missing: string[] } {
  const list: string[] = [];
  const missing: string[] = [];
  for (const t of pbi.tasks) {
    const tag = `#${String(t.number)}`;
    const shas = commits
      .filter((c) => new RegExp(`${tag}(?!\\d)`).test(c.subject))
      .map((c) => c.sha.slice(0, 7));
    if (shas.length === 0) missing.push(`${tag} ${t.title}`);
    list.push(
      `- [${shas.length > 0 ? 'x' : ' '}] ${tag} ${t.title}${shas.length ? ` (${shas.join(', ')})` : ''}`,
    );
  }
  return { list, missing };
}

export interface PrBodyInput {
  pbi: PbiSpec;
  commits: Commit[];
  /** Blocking findings still open when the run ended. */
  unresolved: Finding[];
  notes: string[];
  testsPassed: boolean;
  testCommand: string;
  failureTail?: string;
}

export function buildPrBody(input: PrBodyInput): string {
  const { pbi } = input;
  const { list, missing } = taskLines(pbi, input.commits);
  const notDelivered = [
    ...missing.map((m) => `- Task ${m}: no commit`),
    ...input.unresolved.map((f) => `- Unresolved finding ${f.file}:${String(f.line)} ${f.title}`),
  ];
  const result = input.testsPassed
    ? `\`${input.testCommand}\`: passed`
    : `\`${input.testCommand}\`: **failed**\n\n\`\`\`\n${input.failureTail ?? ''}\n\`\`\``;
  return [
    `Closes #${String(pbi.number)}`,
    pbi.tasks.length > 0 ? `## Tasks\n\n${list.join('\n')}` : '',
    `## Not delivered\n\n${notDelivered.length > 0 ? notDelivered.join('\n') : 'Nothing.'}`,
    `## Review notes\n\n${input.notes.length > 0 ? input.notes.map((n) => `- ${n}`).join('\n') : 'None.'}`,
    `## Test result\n\n${result}`,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

/**
 * Runs the reviewer phase from the `reviewing` state, the fix round when needed, and opens the PR.
 * The outcome state is `pr_opened`, or `blocked` when the reviewer or fix session failed or the
 * findings remain. Red tests after a fix round open a draft PR and end `blocked`.
 */
export async function runReviewPhase(
  deps: ReviewDeps,
  pbi: PbiSpec,
  state: RunState & { kind: 'reviewing' },
): Promise<ReviewOutcome> {
  const { config, harnessInfo, emit } = deps;
  const now = deps.now ?? Date.now;
  const usage: Usage[] = [];
  const github = deps.github ?? { createPr, comment };
  const apply = (s: RunState, input: RunInput): Transition => {
    const t = transition(s, input, config.maxFixRounds);
    emit(t.event);
    return t;
  };

  const session = async <T>(
    role: 'reviewer' | 'implementerRound2',
    phase: string,
    prompt: string,
    schema: z.ZodType<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
    const model = modelFor(config, harnessInfo.id, role);
    const base = { phase, harness: harnessInfo, model };
    emit({ type: 'phase.started', data: base });
    const start = now();
    const end = (u: Usage | null) => ({ ...base, durationMs: now() - start, usage: u });
    try {
      const out = await deps.harness.runPhase({
        prompt,
        cwd: deps.cwd,
        model,
        skills: deps.skillDirs,
        allow: deps.allow,
        schema,
        timeoutMs: deps.timeoutMs,
      });
      const value = schema.parse(out.result);
      if (out.usage) usage.push(out.usage);
      emit({ type: 'phase.finished', data: end(out.usage) });
      return { ok: true, value };
    } catch (error) {
      emit({ type: 'phase.failed', data: end(null) });
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const reportFindings = (findings: Finding[], fixed: boolean): void => {
    for (const f of findings) {
      emit({
        type: 'outcome.finding',
        data: { fingerprint: findingFingerprint(f), blocking: true, fixed },
      });
    }
  };

  const runTests = deps.runTests ?? runShell;
  const listCommits = deps.listCommits ?? gitCommits;
  const command = testCommand(config);
  const title = `${pbi.title} (#${String(pbi.number)})`;

  const openPr = async (
    body: PrBodyInput,
    draft: boolean,
  ): Promise<PullRequest & { draft: boolean }> => {
    const pr = await github.createPr(deps.repo, {
      base: deps.base,
      head: deps.branch,
      title,
      body: buildPrBody(body),
      draft,
    });
    if (body.notes.length > 0) {
      await github.comment(
        deps.repo,
        pr.number,
        `## Review notes\n\n${body.notes.map((n) => `- ${n}`).join('\n')}`,
      );
    }
    return { ...pr, draft };
  };

  const review = await session(
    'reviewer',
    `reviewer #${String(pbi.number)}`,
    reviewPrompt(pbi, deps.base),
    ReviewResultSchema,
  );
  if (!review.ok) {
    const t = apply(state, { type: 'abort', reason: `reviewer failed: ${review.reason}` });
    return { ...t, usage };
  }
  const result = review.value;
  const { notes } = result;

  if (result.blocking.length === 0) {
    const t = apply(state, { type: 'review_clean' });
    const commits = await listCommits(deps.base, deps.cwd);
    const pr = await openPr(
      { pbi, commits, unresolved: [], notes, testsPassed: true, testCommand: command },
      false,
    );
    return { ...t, review: result, pr, usage };
  }

  // One fix round: the state machine decides whether findings still fit into a round.
  const findings = apply(state, { type: 'review_findings', count: result.blocking.length });
  if (findings.state.kind === 'blocked') {
    reportFindings(result.blocking, false);
    return { ...findings, review: result, usage };
  }

  emit({ type: 'outcome.fixRound', data: { cause: 'review_findings' } });
  const fix = await session(
    'implementerRound2',
    `fixer #${String(pbi.number)}`,
    fixPrompt(pbi, result.blocking),
    FixResultSchema,
  );
  if (!fix.ok || fix.value.status === 'failed') {
    const reason = fix.ok ? fix.value.summary : fix.reason;
    reportFindings(result.blocking, false);
    const t = apply(findings.state, { type: 'abort', reason: `fix round failed: ${reason}` });
    return { ...t, review: result, usage };
  }

  const fixed = apply(findings.state, { type: 'fixed' });
  await formatChanged(deps, pbi.number);
  const tests: TestOutcome = await runTests(command, deps.cwd, stepTimeoutMs(config, 'test'));
  emit(parseTestSummary(tests.output));
  reportFindings(result.blocking, tests.passed);
  const commits = await listCommits(deps.base, deps.cwd);
  if (tests.passed) {
    const t = apply(fixed.state, { type: 'tests_passed' });
    if (t.state.kind !== 'pr_opened') {
      // maxFixRounds > 1 would review again; this phase runs exactly one fix round.
      return {
        ...apply(t.state, { type: 'abort', reason: 'only one fix round is supported' }),
        usage,
      };
    }
    const pr = await openPr(
      { pbi, commits, unresolved: [], notes, testsPassed: true, testCommand: command },
      false,
    );
    return { ...t, review: result, pr, usage };
  }

  const failureTail = tail(tests.output);
  const t = apply(fixed.state, {
    type: 'tests_failed',
    summary: failureTail.split('\n').at(-1) || 'tests failed',
  });
  const pr = await openPr(
    {
      pbi,
      commits,
      unresolved: result.blocking,
      notes,
      testsPassed: false,
      testCommand: command,
      failureTail,
    },
    true,
  );
  return { ...t, review: result, pr, failureTail, usage };
}

export type { ImplementerEvent };
