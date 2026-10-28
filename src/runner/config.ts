import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type HarnessName, HarnessNameSchema } from './harness.js';

/** Runner config of the *target* repository; separate from the bus server's `dromos.config.json`. */
export const RUNNER_CONFIG_PATH = join('.dromos', 'config.json');

export const ROLES = ['planner', 'implementer', 'implementerRound2', 'reviewer', 'retro'] as const;
export type Role = (typeof ROLES)[number];

const model = z.string().min(1);
const skillList = z.array(z.string().min(1));

/** One model per role; ids are passed verbatim to the harness and intentionally not validated. */
const roleModels = (defaults: Record<Role, string>) =>
  z
    .strictObject({
      planner: model.default(defaults.planner),
      implementer: model.default(defaults.implementer),
      implementerRound2: model.default(defaults.implementerRound2),
      reviewer: model.default(defaults.reviewer),
      retro: model.default(defaults.retro),
    })
    .prefault({});

const CLAUDE_MODELS: Record<Role, string> = {
  planner: 'opus',
  implementer: 'sonnet',
  implementerRound2: 'opus',
  reviewer: 'opus',
  retro: 'opus',
};
/** `auto` lets Copilot pick; a Sonnet id of Copilot is not known yet (see docs/spike.md). */
const COPILOT_MODELS: Record<Role, string> = {
  planner: 'auto',
  implementer: 'auto',
  implementerRound2: 'auto',
  reviewer: 'auto',
  retro: 'auto',
};

export const RunnerConfigSchema = z.strictObject({
  harness: HarnessNameSchema.default('claude'),
  /** Models per harness family: `claude-cli` uses `claude`; Copilot takes its own model ids or `auto`. */
  models: z
    .strictObject({
      claude: roleModels(CLAUDE_MODELS),
      copilot: roleModels(COPILOT_MODELS),
    })
    .prefault({}),
  /** Skills exposed to a role; `implementerRound2` uses the `implementer` skills. */
  skills: z
    .strictObject({
      planner: skillList.default(['planner']),
      implementer: skillList.default(['implementation']),
      reviewer: skillList.default(['code-review']),
      retro: skillList.default(['retro']),
    })
    .prefault({}),
  test: z
    .strictObject({
      /** Tests related to the change; without it the runner uses `full`. */
      related: z.string().min(1).optional(),
      full: z.string().min(1).default('npm test'),
    })
    .prefault({}),
  /** Replaces formatter detection; `{files}` is the changed-file list. `false` disables the format step. */
  format: z.union([z.string().min(1), z.literal(false)]).optional(),
  /** Replaces dependency detection in the worktree; `false` disables the setup step. */
  setup: z.union([z.string().min(1), z.literal(false)]).optional(),
  /** Integration branch for repositories without `release/next`; without it a missing `release/next` blocks the run. */
  base: z.string().min(1).optional(),
  parallel: z.number().int().positive().default(3),
  /** Fix rounds after the first review before the run is blocked; 0 blocks on the first findings. */
  maxFixRounds: z.number().int().nonnegative().default(1),
  /** Extra tools or command prefixes allowed on top of the built-in allowlist. */
  allow: z.array(z.string().min(1)).default([]),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export class RunnerConfigError extends Error {
  override name = 'RunnerConfigError';
}

/** The model of `role` for `harness`; `claude` and `claude-cli` share the Claude models. */
export function modelFor(config: RunnerConfig, harness: HarnessName, role: Role): string {
  return config.models[harness === 'copilot' ? 'copilot' : 'claude'][role];
}

/** The command that runs tests for a change: `test.related` when set, else `test.full`. */
export function testCommand(config: RunnerConfig): string {
  return config.test.related ?? config.test.full;
}

/** Loads `.dromos/config.json` from `repoDir`; a missing file yields the defaults. */
export function loadRunnerConfig(repoDir: string): RunnerConfig {
  const file = join(repoDir, RUNNER_CONFIG_PATH);
  let raw: unknown = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (error) {
      throw new RunnerConfigError(
        `invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const parsed = RunnerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RunnerConfigError(`invalid runner config ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
