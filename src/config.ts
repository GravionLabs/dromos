import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { SeveritySchema } from './schemas.js';

export const CONFIG_FILE_NAME = 'dromos.config.json';
export const LEGACY_CONFIG_FILE_NAME = 'agent-bus.config.json';
export const CONFIG_ENV = 'DROMOS_CONFIG';

export const CliSchema = z.enum(['claude', 'copilot']);
export type Cli = z.infer<typeof CliSchema>;

function roleConfig(defaultCli: Cli) {
  return z
    .object({
      cli: CliSchema.default(defaultCli),
      /** Passed verbatim to the CLI's --model flag; intentionally not validated. */
      model: z.string().min(1).nullable().default(null),
    })
    .prefault({});
}

export const GateCommandSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
});
export type GateCommand = z.infer<typeof GateCommandSchema>;

export const ConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(4777),
  dataDir: z.string().min(1).default('.agents'),
  maxRounds: z.number().int().positive().default(3),
  inboxMaxWaitSeconds: z.number().int().positive().default(45),
  blockingSeverities: z.array(SeveritySchema).default(['critical', 'important']),
  gate: z
    .object({
      timeoutSeconds: z.number().int().positive().default(900),
      commands: z.array(GateCommandSchema).default([]),
    })
    .prefault({}),
  baseBranch: z.string().min(1).default('main'),
  roles: z
    .object({
      orchestrator: roleConfig('claude'),
      implementer: roleConfig('claude'),
      reviewer: roleConfig('copilot'),
    })
    .prefault({}),
  layouts: z
    .object({
      default: z.enum(['windows', 'print', 'wezterm']).default('windows'),
    })
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Receives deprecation warnings; defaults to writing a line to stderr. */
  warn?: (message: string) => void;
}

/**
 * Loads the dromos configuration.
 *
 * Lookup order: explicit `path`, `DROMOS_CONFIG`,
 * `./dromos.config.json`, legacy `./agent-bus.config.json` (deprecated).
 * An explicitly named file (argument or env var) must exist; the implicit default file is optional.
 * `dataDir` is resolved relative to the config file's directory, or `cwd` when there is no file.
 */
export function loadConfig(path?: string, options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warn = options.warn ?? ((message: string) => process.stderr.write(`dromos: ${message}\n`));
  const explicit = path ?? env[CONFIG_ENV];
  let file = resolve(cwd, explicit ?? CONFIG_FILE_NAME);
  if (explicit === undefined && !existsSync(file)) {
    const legacyFile = resolve(cwd, LEGACY_CONFIG_FILE_NAME);
    if (existsSync(legacyFile)) {
      warn(`${LEGACY_CONFIG_FILE_NAME} is deprecated, rename to ${CONFIG_FILE_NAME}`);
      file = legacyFile;
    }
  }

  let raw: unknown = {};
  let baseDir = cwd;
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (error) {
      throw new ConfigError(
        `invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    baseDir = dirname(file);
  } else if (explicit !== undefined) {
    throw new ConfigError(`config file not found: ${file}`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid config ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return { ...parsed.data, dataDir: resolve(baseDir, parsed.data.dataDir) };
}
