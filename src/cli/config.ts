import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { RUNNER_CONFIG_PATH, RunnerConfigSchema } from '../runner/config.js';
import {
  applyInit,
  type ConfigIssue,
  issuesOf,
  lineDiff,
  planInit,
  STACKS,
  type Stack,
} from '../runner/init.js';

export interface ConfigCliIo {
  out?: (text: string) => void;
  err?: (line: string) => void;
}

const INIT_USAGE =
  'usage: dromos init [--repo PATH] [--stack ts|py|dotnet|rust|ng] [--test-full <cmd>] [--dry-run] [--format text|json]';
const CHECK_USAGE = 'usage: dromos config check [--repo PATH] [--format text|json]';
const SCHEMA_USAGE = 'usage: dromos config schema';

interface Parsed {
  flags: Map<string, string>;
  bools: Set<string>;
  positional: string[];
}

/** Parses `--name value` and boolean flags; throws a message on an unknown option. */
function parseArgs(argv: string[], valued: string[], boolean: string[]): Parsed {
  const out: Parsed = { flags: new Map(), bools: new Set(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      out.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (boolean.includes(name)) {
      out.bools.add(name);
      continue;
    }
    if (!valued.includes(name)) throw new Error(`unknown option ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`option ${arg} needs a value`);
    out.flags.set(name, value);
    i++;
  }
  return out;
}

function ioOf(io: ConfigCliIo) {
  return {
    out: io.out ?? ((text: string) => process.stdout.write(text)),
    err: io.err ?? ((line: string) => process.stderr.write(`${line}\n`)),
  };
}

const jsonLine = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Runs `dromos init`; resolves to the exit code (0 ok, 1 invalid file, 2 usage error, 3 error). */
export async function runInitCli(argv: string[], io: ConfigCliIo = {}): Promise<number> {
  const { out, err } = ioOf(io);
  const usage = (message: string): number => {
    err(`dromos: ${message}\n${INIT_USAGE}`);
    return 2;
  };
  let args: Parsed;
  try {
    args = parseArgs(argv, ['repo', 'stack', 'test-full', 'format'], ['dry-run']);
  } catch (error) {
    return usage((error as Error).message);
  }
  if (args.positional.length > 0) return usage(`unexpected argument ${args.positional[0]}`);
  const stack = args.flags.get('stack');
  if (stack !== undefined && !(STACKS as readonly string[]).includes(stack)) {
    return usage(`--stack must be one of ${STACKS.join(', ')}`);
  }
  const format = args.flags.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json') return usage('--format must be text or json');
  const testFull = args.flags.get('test-full');
  if (testFull !== undefined && testFull.trim() === '') {
    return usage('--test-full must not be empty');
  }

  try {
    const result = planInit({
      repoDir: args.flags.get('repo') ?? process.cwd(),
      stack: stack as Stack | undefined,
      testFull,
    });
    if (!result.ok) {
      if (format === 'json') {
        out(jsonLine({ path: result.path, valid: false, errors: result.errors }));
      } else {
        err(`dromos: invalid runner config ${result.path}, left untouched:`);
        for (const e of result.errors) err(`  ${e.path || '(file)'}: ${e.message}`);
      }
      return 1;
    }
    const dryRun = args.bools.has('dry-run');
    if (!dryRun) applyInit(result);
    const { path, action, added, kept } = result;
    if (format === 'json') {
      out(jsonLine({ path, action, added, kept }));
      return 0;
    }
    out(`${path} ${dryRun ? 'would be' : 'was'} ${action}\n`);
    if (added.length > 0) out(`added: ${added.join(', ')}\n`);
    if (kept.length > 0) out(`kept: ${kept.join(', ')}\n`);
    if (dryRun) {
      out(`\n${result.after}`);
      const diff = lineDiff(result.before, result.after);
      if (diff !== '') out(`\n${diff}\n`);
    }
    return 0;
  } catch (error) {
    err(`dromos: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}

/** Runs `dromos config check|schema`; resolves to the exit code (0 valid, 1 invalid, 2 usage error). */
export async function runConfigCli(argv: string[], io: ConfigCliIo = {}): Promise<number> {
  const { out, err } = ioOf(io);
  const [sub, ...rest] = argv;
  const usage = (message: string, text: string): number => {
    err(`dromos: ${message}\n${text}`);
    return 2;
  };
  if (sub === 'schema') {
    if (rest.length > 0) return usage('config schema takes no arguments', SCHEMA_USAGE);
    out(jsonLine(z.toJSONSchema(RunnerConfigSchema, { io: 'input' })));
    return 0;
  }
  if (sub !== 'check') {
    return usage('config needs a subcommand: check or schema', `${CHECK_USAGE}\n${SCHEMA_USAGE}`);
  }
  let args: Parsed;
  try {
    args = parseArgs(rest, ['repo', 'format'], []);
  } catch (error) {
    return usage((error as Error).message, CHECK_USAGE);
  }
  if (args.positional.length > 0) {
    return usage(`unexpected argument ${args.positional[0]}`, CHECK_USAGE);
  }
  const format = args.flags.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    return usage('--format must be text or json', CHECK_USAGE);
  }
  const path = join(args.flags.get('repo') ?? process.cwd(), RUNNER_CONFIG_PATH);
  const found = existsSync(path);
  let errors: ConfigIssue[] = [];
  if (found) {
    try {
      const parsed = RunnerConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success) errors = issuesOf(parsed.error);
    } catch (error) {
      const message = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
      errors = [{ path: '', message }];
    }
  }
  const valid = errors.length === 0;
  if (format === 'json') {
    out(jsonLine({ path, valid, errors }));
  } else if (valid) {
    out(found ? `${path} is valid\n` : `${path} not found, defaults apply\n`);
  } else {
    err(`dromos: invalid runner config ${path}:`);
    for (const e of errors) err(`  ${e.path || '(file)'}: ${e.message}`);
  }
  return valid ? 0 : 1;
}
