import { loadConfig } from '../config.js';

export interface AttentionCliIo {
  /** Bus base URL; defaults to the host and port from `loadConfig()`. */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

interface Row {
  id: number;
  state: string;
  kind: string;
  issue: number | null;
  summary: string;
}

const STATES = ['open', 'answered', 'acked'];
const USAGE =
  'usage: dromos attention list [--state open|answered|acked] [--issue N]\n' +
  '       dromos attention answer <id> <text> [--by NAME]  (use -- before text starting with --)\n' +
  '       dromos attention ack <id> [--by NAME]';

class UsageError extends Error {}

/** Splits argv into positionals and `--flag value` options. */
function parseArgs(args: string[], allowed: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('--')) {
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

const formatRow = (r: Row): string =>
  `${r.id} ${r.state} ${r.kind} ${r.issue === null ? '-' : r.issue} ${r.summary}`;

/** Runs `dromos attention ...`; resolves to the process exit code. */
export async function runAttentionCli(argv: string[], io: AttentionCliIo = {}): Promise<number> {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  const env = io.env ?? process.env;
  const [sub, ...rest] = argv;

  try {
    let path: string;
    let init: RequestInit | undefined;
    let list = false;
    const by = (flags: Map<string, string>): string | undefined => flags.get('by') ?? env.USER;

    if (sub === 'list') {
      const { positional, flags } = parseArgs(rest, ['state', 'issue']);
      if (positional.length > 0) throw new UsageError('list takes no arguments');
      const state = flags.get('state');
      const issue = flags.get('issue');
      if (state !== undefined && !STATES.includes(state)) {
        throw new UsageError(`--state must be one of ${STATES.join(', ')}`);
      }
      if (issue !== undefined && !/^[1-9]\d*$/.test(issue)) {
        throw new UsageError('--issue must be a positive integer');
      }
      const params = new URLSearchParams();
      if (state !== undefined) params.set('state', state);
      if (issue !== undefined) params.set('issue', issue);
      const qs = params.toString();
      path = qs ? `/attention?${qs}` : '/attention';
      list = true;
    } else if (sub === 'answer') {
      const { positional, flags } = parseArgs(rest, ['by']);
      const [id, text, ...extra] = positional;
      if (id === undefined || text === undefined || extra.length > 0) {
        throw new UsageError('answer needs <id> <text>');
      }
      if (!/^[1-9]\d*$/.test(id)) throw new UsageError('<id> must be a positive integer');
      path = `/attention/${id}/answer`;
      const who = by(flags);
      if (who === undefined || who === '') {
        throw new UsageError('answer needs --by NAME (USER is not set)');
      }
      init = { method: 'POST', body: JSON.stringify({ text, by: who }) };
    } else if (sub === 'ack') {
      const { positional, flags } = parseArgs(rest, ['by']);
      const [id, ...extra] = positional;
      if (id === undefined || extra.length > 0) throw new UsageError('ack needs <id>');
      if (!/^[1-9]\d*$/.test(id)) throw new UsageError('<id> must be a positive integer');
      path = `/attention/${id}/ack`;
      const who = by(flags);
      init = { method: 'POST', body: JSON.stringify(who === undefined ? {} : { by: who }) };
    } else {
      throw new UsageError(sub === undefined ? 'missing subcommand' : `unknown subcommand ${sub}`);
    }

    const baseUrl =
      io.baseUrl ??
      (() => {
        const c = loadConfig();
        return `http://${c.host}:${c.port}`;
      })();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: init ? { 'content-type': 'application/json' } : undefined,
      });
    } catch {
      err(`dromos: bus not running at ${baseUrl}`);
      return 1;
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
      const label =
        res.status === 404 ? 'not found' : res.status === 409 ? 'conflict' : `error ${res.status}`;
      err(`dromos: ${label}: ${detail}`);
      return 1;
    }
    if (list) {
      for (const row of (body?.attention ?? []) as Row[]) out(formatRow(row));
    } else {
      out(formatRow(body as unknown as Row));
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`dromos: ${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}
