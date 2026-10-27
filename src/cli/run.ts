import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { type Db, type EventRecord, openDb } from '../db.js';
import { toJsonExport, toMermaid } from '../export/run-export.js';
import { HarnessNameSchema } from '../runner/harness.js';
import { EXIT_ERROR, type RunPbiEvent, type RunPbiOps, runPbi } from '../runner/run-pbi.js';
import { runSpike, type SpikeOptions } from '../runner/spike.js';

export interface RunCliIo {
  /** Store to read; defaults to `<dataDir>/bus.db` from `loadConfig()`. The caller keeps ownership. */
  db?: Db;
  now?: () => Date;
  out?: (text: string) => void;
  err?: (line: string) => void;
  writeFile?: (path: string, text: string) => void;
  /** Options of `run task` beyond the arguments; tests inject a fake harness. */
  spike?: Partial<SpikeOptions>;
  /** Options of `run pbi`; tests inject fake `gh`, git and harness operations. */
  pbi?: { ops?: Partial<RunPbiOps>; isTty?: boolean };
}

const FORMATS = ['json', 'mermaid'];
const PAGE = 1000;
const USAGE =
  'usage: dromos run export <issue> [--format json|mermaid] [--out FILE]\n       dromos run task <issue> --harness claude|copilot [--repo PATH]\n       dromos run pbi <nr> [--harness claude|claude-cli|copilot] [--repo PATH] [--format text|json] [--dry-run] [--force]';

class UsageError extends Error {}

/** Splits argv into positionals and `--flag value` options. */
function parseArgs(args: string[], allowed: string[], switches: string[] = []) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (switches.includes(name)) {
        flags.set(name, 'true');
        continue;
      }
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

/** One line of text output for a run event. */
export function formatEvent(event: RunPbiEvent): string {
  switch (event.type) {
    case 'run.header': {
      const models = Object.entries(event.models)
        .map(([role, model]) => `${role}=${model}`)
        .join(' ');
      const { name, version, sdk } = event.harness;
      const versions = [version, sdk && `sdk ${sdk}`].filter(Boolean).join(', ');
      return `run ${event.runId} #${String(event.issue)} ${event.repo}${event.dryRun ? ' (dry run)' : ''}: harness ${name}${versions ? ` (${versions})` : ''}; ${models}`;
    }
    case 'run.step':
      return `step: ${event.step}`;
    case 'run.finished':
      return `${event.outcome}${event.reason ? `: ${event.reason}` : ''}${event.pr ? ` ${event.pr.url}${event.pr.draft ? ' (draft)' : ''}` : ''}`;
    case 'phase.started':
    case 'phase.finished':
    case 'phase.failed':
      return `${event.type} ${event.data.phase} (${event.data.model})`;
    default: {
      const { type, ...rest } = event;
      return Object.keys(rest).length > 0 ? `${type} ${JSON.stringify(rest)}` : type;
    }
  }
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
  const writeFile = io.writeFile ?? ((path, text) => writeFileSync(path, text, { mode: 0o600 }));
  const [sub, ...rest] = argv;

  let db: Db | undefined;
  try {
    if (sub === 'task') {
      const { positional, flags } = parseArgs(rest, ['harness', 'repo']);
      const [issueArg, ...extra] = positional;
      if (issueArg === undefined || extra.length > 0) throw new UsageError('task needs <issue>');
      if (!/^[1-9]\d*$/.test(issueArg)) throw new UsageError('<issue> must be a positive integer');
      const harness = HarnessNameSchema.safeParse(flags.get('harness'));
      if (!harness.success) throw new UsageError('--harness must be claude, claude-cli or copilot');
      db = io.db ?? openDb(join(loadConfig().dataDir, 'bus.db'));
      const result = await runSpike({
        issue: Number(issueArg),
        harness: harness.data,
        repo: flags.get('repo') ?? process.cwd(),
        db,
        ...io.spike,
      });
      if (result.ok) out(`${result.message}\n`);
      else err(result.message);
      return result.ok ? 0 : 1;
    }
    if (sub === 'pbi') {
      const { positional, flags } = parseArgs(
        rest,
        ['harness', 'repo', 'format', 'dry-run', 'force'],
        ['dry-run', 'force'],
      );
      const [nr, ...extra] = positional;
      if (nr === undefined || extra.length > 0) throw new UsageError('pbi needs <nr>');
      if (!/^[1-9]\d*$/.test(nr)) throw new UsageError('<nr> must be a positive integer');
      const harnessFlag = flags.get('harness');
      const harness =
        harnessFlag === undefined ? undefined : HarnessNameSchema.safeParse(harnessFlag);
      if (harness && !harness.success) {
        throw new UsageError('--harness must be claude, claude-cli or copilot');
      }
      const format = flags.get('format');
      if (format !== undefined && format !== 'text' && format !== 'json') {
        throw new UsageError('--format must be text or json');
      }
      // Text is for people: without a TTY the output is JSON lines, whatever was asked.
      const tty = io.pbi?.isTty ?? process.stdout.isTTY === true;
      const json = !tty || format === 'json';
      if (format === 'text' && !tty) err('dromos: stdout is not a TTY, writing JSON lines');
      db = io.db ?? openDb(join(loadConfig().dataDir, 'bus.db'));
      try {
        return await runPbi({
          issue: Number(nr),
          repo: flags.get('repo') ?? process.cwd(),
          harness: harness?.data,
          dryRun: flags.has('dry-run'),
          force: flags.has('force'),
          db,
          now: io.now,
          ops: io.pbi?.ops,
          emit: (event) => out(json ? `${JSON.stringify(event)}\n` : `${formatEvent(event)}\n`),
        });
      } catch (error) {
        err(`dromos: ${error instanceof Error ? error.message : String(error)}`);
        return EXIT_ERROR;
      }
    }
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
