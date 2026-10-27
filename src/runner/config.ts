import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HarnessNameSchema } from './harness.js';

/** Runner config of the *target* repository; separate from the bus server's `dromos.config.json`. */
export const RUNNER_CONFIG_PATH = join('.dromos', 'config.json');

export const ROLES = ['planner', 'implementer', 'implementerRound2', 'reviewer', 'retro'] as const;
export type Role = (typeof ROLES)[number];

const model = z.string().min(1);
const skillList = z.array(z.string().min(1));

export const RunnerConfigSchema = z.strictObject({
  harness: HarnessNameSchema.default('claude'),
  /** Passed verbatim to the harness; intentionally not validated. */
  models: z
    .strictObject({
      planner: model.default('opus'),
      implementer: model.default('sonnet'),
      implementerRound2: model.default('opus'),
      reviewer: model.default('sonnet'),
      retro: model.default('opus'),
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
  parallel: z.number().int().positive().default(3),
  /** Extra tools or command prefixes allowed on top of the built-in allowlist. */
  allow: z.array(z.string().min(1)).default([]),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export class RunnerConfigError extends Error {
  override name = 'RunnerConfigError';
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
