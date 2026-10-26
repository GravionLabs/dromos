import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { type Db, type EventRecord, openDb } from '../db.js';
import { toJsonExport, toMermaid } from '../export/run-export.js';

export interface RunCliIo {
  /** Store to read; defaults to `<dataDir>/bus.db` from `loadConfig()`. The caller keeps ownership. */
  db?: Db;
  now?: () => Date;
  out?: (text: string) => void;
  err?: (line: string) => void;
  writeFile?: (path: string, text: string) => void;
}

const FORMATS = ['json', 'mermaid'];
const PAGE = 1000;
const USAGE = 'usage: dromos run export <issue> [--format json|mermaid] [--out FILE]';

class UsageError extends Error {}

/** Splits argv into positionals and `--flag value` options. */
function parseArgs(args: string[], allowed: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = args[i + 1];
      if (!allowed.includes(name)) throw new UsageError(`unknown option ${arg}`);
      if (value === undefined) throw new UsageError(`option ${arg} needs a value`);
      flags.set(name, value);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function readAll(db: Db, issue: number): EventRecord[] {
  const events: EventRecord[] = [];
  let after: number | undefined;
  for (;;) {
    const page = db.queryEvents({ issue, limit: PAGE, after });
    events.push(...page.events);
    if (page.next === null) return events;
    after = page.next;
  }
}

/** Runs `dromos run ...`; resolves to the process exit code. */
export async function runRunCli(argv: string[], io: RunCliIo = {}): Promise<number> {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  const writeFile = io.writeFile ?? ((path, text) => writeFileSync(path, text));
  const [sub, ...rest] = argv;

  let db: Db | undefined;
  try {
    if (sub !== 'export') {
      throw new UsageError(sub === undefined ? 'missing subcommand' : `unknown subcommand ${sub}`);
    }
    const { positional, flags } = parseArgs(rest, ['format', 'out']);
    const [issueArg, ...extra] = positional;
    if (issueArg === undefined || extra.length > 0) throw new UsageError('export needs <issue>');
    if (!/^[1-9]\d*$/.test(issueArg)) throw new UsageError('<issue> must be a positive integer');
    const format = flags.get('format') ?? 'json';
    if (!FORMATS.includes(format))
      throw new UsageError(`--format must be one of ${FORMATS.join(', ')}`);
    const target = flags.get('out');
    const issue = Number(issueArg);

    db = io.db ?? openDb(join(loadConfig().dataDir, 'bus.db'));
    const events = readAll(db, issue);
    if (events.length === 0) return 1;

    const text =
      format === 'json'
        ? `${JSON.stringify(toJsonExport(issue, events, (io.now ?? (() => new Date()))()), null, 2)}\n`
        : toMermaid(events);
    if (target === undefined) out(text);
    else writeFile(target, text);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`dromos: ${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  } finally {
    if (db !== undefined && io.db === undefined) db.close();
  }
}
