import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { type Db, openDb } from '../db.js';
import { repoFromPath } from '../github.js';
import { collectStatus, formatStatus, type StatusOps } from '../runner/status.js';

export interface StatusCliIo {
  /** Store for the last run of each issue; defaults to `<dataDir>/bus.db` from `loadConfig()`. */
  db?: Db;
  out?: (text: string) => void;
  err?: (line: string) => void;
  isTty?: boolean;
  repoSlug?: (repo: string) => Promise<string>;
  ops?: Partial<StatusOps>;
}

const USAGE = 'usage: dromos status <nr> [--repo PATH] [--format text|json]';

/** Runs `dromos status <nr>`; resolves to the exit code (0 printed, 2 usage error, 3 error). */
export async function runStatusCli(argv: string[], io: StatusCliIo = {}): Promise<number> {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  const usage = (message: string): number => {
    err(`dromos: ${message}\n${USAGE}`);
    return 2;
  };

  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name !== 'repo' && name !== 'format') return usage(`unknown option ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) return usage(`option ${arg} needs a value`);
    flags.set(name, value);
    i++;
  }
  const [nr, ...extra] = positional;
  if (nr === undefined || extra.length > 0) return usage('status needs <nr>');
  if (!/^[1-9]\d*$/.test(nr)) return usage('<nr> must be a positive integer');
  const format = flags.get('format');
  if (format !== undefined && format !== 'text' && format !== 'json') {
    return usage('--format must be text or json');
  }
  // Text is for people: without a TTY the output is JSON, whatever was asked.
  const tty = io.isTty ?? process.stdout.isTTY === true;
  const json = !tty || format === 'json';

  const db = io.db ?? openDb(join(loadConfig().dataDir, 'bus.db'));
  try {
    const slug = await (io.repoSlug ?? repoFromPath)(flags.get('repo') ?? process.cwd());
    const status = await collectStatus(slug, Number(nr), { db, ops: io.ops });
    out(json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
    return 0;
  } catch (error) {
    err(`dromos: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  } finally {
    if (io.db === undefined) db.close();
  }
}
