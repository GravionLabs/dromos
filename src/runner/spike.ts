import { join } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import type { Db } from '../db.js';
import { BusEventSchema } from '../events/schema.js';
import { assertWorktreeDirIgnored, createWorktree, slugify } from '../worktree.js';
import { loadRunnerConfig, modelFor } from './config.js';
import { CliHarness } from './harness/cli.js';
import type { Harness, HarnessName, PhaseOutput } from './harness.js';
import { type PreflightOps, runPreflight } from './preflight.js';

const SOURCE = 'dromos';
const PHASE = 'implementer';
const BASE = 'release/next';
const TIMEOUT_MS = 30 * 60 * 1000;

export interface SpikeOptions {
  issue: number;
  harness: HarnessName;
  repo: string;
  db: Db;
  /** Defaults to a {@link CliHarness} of the chosen client. */
  makeHarness?: (
    name: HarnessName,
    env?: NodeJS.ProcessEnv,
  ) => Harness & { version(): Promise<string | null> };
  /** Issue title; defaults to `gh issue view`. */
  title?: string;
  worktreeDir?: string;
  /** Replaces the git, `gh` and file system calls of the preflight. */
  preflightOps?: Partial<PreflightOps>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface SpikeResult {
  ok: boolean;
  branch: string;
  worktree: string;
  message: string;
}

async function issueTitle(repo: string, issue: number): Promise<string> {
  const res = await execa(
    'gh',
    ['issue', 'view', String(issue), '--json', 'title', '-q', '.title'],
    {
      cwd: repo,
    },
  );
  return String(res.stdout).trim();
}

async function head(dir: string): Promise<string> {
  return String((await execa('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout).trim();
}

/** Implements one Task through a harness CLI in a fresh worktree and records `phase.*` events. */
export async function runSpike(options: SpikeOptions): Promise<SpikeResult> {
  const now = options.now ?? (() => new Date());
  const config = loadRunnerConfig(options.repo);
  const model = modelFor(config, options.harness, 'implementer');
  const title = options.title ?? (await issueTitle(options.repo, options.issue));
  const branch = `spike/${String(options.issue)}-${slugify(title) || 'task'}`;
  const dir = options.worktreeDir ?? '.worktrees';
  const worktree = join(options.repo, dir, `spike-${String(options.issue)}`);

  const harness = (options.makeHarness ?? ((n, env) => new CliHarness({ name: n, env })))(
    options.harness,
    options.env,
  );
  const meta = { name: options.harness, version: await harness.version(), sdk: null };

  const record = (type: string, data: unknown): void => {
    const checked = BusEventSchema.parse({
      id: 0,
      type,
      at: now().toISOString(),
      source: SOURCE,
      agentId: null,
      issue: options.issue,
      runId: null,
      data,
    });
    options.db.insertEvent(SOURCE, checked.type, checked.data, { issue: options.issue });
  };

  await assertWorktreeDirIgnored(options.repo, dir);
  const left = await runPreflight({
    repo: options.repo,
    issue: options.issue,
    base: BASE,
    namespace: 'spike',
    worktreeDir: dir,
    worktree: `spike-${String(options.issue)}`,
    ops: options.preflightOps,
  });
  if (left.blocked !== null) return { ok: false, branch, worktree, message: left.blocked };
  await createWorktree(options.repo, BASE, branch, worktree);
  const before = await head(worktree);

  record('phase.started', { phase: PHASE, harness: meta, model });
  const started = now().getTime();
  const end = (output: PhaseOutput | null) => ({
    phase: PHASE,
    harness: meta,
    model,
    durationMs: Math.max(0, now().getTime() - started),
    usage: output?.usage ?? null,
  });

  let output: PhaseOutput | null = null;
  let failure: string | null = null;
  try {
    output = await harness.runPhase({
      prompt: `Implement GitHub issue #${String(options.issue)} (${title}) in this repository: read it with \`gh issue view ${String(options.issue)}\`, implement its acceptance criteria with tests, and commit your work on the current branch. Do not push.`,
      cwd: worktree,
      model,
      skills: config.skills.implementer,
      allow: () => ({ allow: true }),
      schema: z.string(),
      timeoutMs: TIMEOUT_MS,
    });
    if ((await head(worktree)) === before) failure = 'the phase finished without a new commit';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  record(failure === null ? 'phase.finished' : 'phase.failed', end(output));
  return {
    ok: failure === null,
    branch,
    worktree,
    message: failure ?? `committed on ${branch} in ${worktree}`,
  };
}
