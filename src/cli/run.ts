import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { type Db, type EventRecord, openDb } from '../db.js';
import { toJsonExport, toMermaid } from '../export/run-export.js';
import { collectRunsMetrics, formatMetricsTable } from '../run-metrics.js';
import { parseMultiRunMetricsQuery } from '../run-metrics-query.js';
import { type CleanOps, describeClean, runClean } from '../runner/clean.js';
import { HarnessNameSchema } from '../runner/harness.js';
import { parseAnswerFlags, ttySelectPrompt } from '../runner/questions.js';
import {
  EXIT_INTERRUPTED,
  type GroupLevel,
  type RunGroupEvent,
  type RunGroupOps,
  releaseClaim,
  runGroup,
} from '../runner/run-group.js';
import { EXIT_ERROR, type RunPbiEvent, type RunPbiOps, runPbi } from '../runner/run-pbi.js';
import { type RunPlanEvent, type RunPlanOps, runPlan } from '../runner/run-plan.js';
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
  /** Options of `run clean`; tests inject fake git and `gh` operations. */
  clean?: { ops?: Partial<CleanOps> };
  /** Options of `run plan`; tests inject fake operations and a fake TTY. */
  plan?: {
    ops?: Partial<RunPlanOps>;
    isTty?: boolean;
    readLine?: () => Promise<string>;
  };
  /** Options of `run feature|epic`; tests inject fake operations and a fake interrupt source. */
  group?: {
    ops?: Partial<RunGroupOps>;
    isTty?: boolean;
    /** Ctrl-C source; defaults to `process`. */
    signals?: InterruptSource;
    /** Removes the claim of the running PBI on the second Ctrl-C. */
    releaseClaim?: (repo: string, issue: number) => Promise<void>;
    /** Called on the second Ctrl-C after the claim is released; defaults to `process.exit`. */
    exit?: (code: number) => void;
  };
}

/** The part of `process` that delivers Ctrl-C. */
export interface InterruptSource {
  on: (event: 'SIGINT', listener: () => void) => unknown;
  off: (event: 'SIGINT', listener: () => void) => unknown;
}

const FORMATS = ['json', 'mermaid'];
const PAGE = 1000;
const USAGE =
  'usage: dromos run export <issue> [--format json|mermaid] [--out FILE]\n       dromos run task <issue> --harness claude|copilot [--repo PATH]\n       dromos run pbi <nr> [--harness claude|claude-cli|copilot] [--repo PATH] [--format text|json] [--dry-run] [--force]\n       dromos run plan <nr> [--harness claude|claude-cli|copilot] [--repo PATH] [--format text|json] [--answer <id>=<value>]... [--assume-recommended]\n       dromos run feature|epic <nr> [--harness claude|claude-cli|copilot] [--repo PATH] [--format text|json] [--force]\n       dromos run clean [<nr>] [--repo PATH] [--dry-run]\n       dromos run metrics [--issues <n,…>] [--since <date>] [--format json|table]';

const PLAN_USAGE =
  'usage: dromos plan feature|pbi <nr> [--harness claude|claude-cli|copilot] [--repo PATH] [--format text|json] [--answer <id>=<value>]... [--assume-recommended]';

class UsageError extends Error {}

/** Splits argv into positionals and `--flag value` options; `repeated` flags collect every value. */
function parseArgs(
  args: string[],
  allowed: string[],
  switches: string[] = [],
  repeated: string[] = [],
) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const lists = new Map<string, string[]>();
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
      if (repeated.includes(name)) lists.set(name, [...(lists.get(name) ?? []), value]);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, lists };
}

/** One line of text output for a plan event. */
export function formatPlanEvent(event: RunPlanEvent): string {
  switch (event.type) {
    case 'run.finished': {
      const issues = (event.issues ?? []).map((i) => `#${String(i.number)}`).join(', ');
      return `${event.outcome}${event.reason ? `: ${event.reason}` : ''}${event.plan ? ` (plan ${event.plan})` : ''}${issues ? ` created ${issues}` : ''}`;
    }
    case 'attention':
      return `attention ${event.data.kind}: ${event.data.summary}`;
    case 'outcome.finding':
    case 'outcome.tests':
    case 'outcome.fixRound':
    case 'outcome.questions':
      return `${event.type} ${JSON.stringify(event.data)}`;
    case 'phase.started':
    case 'phase.failed':
      return `${event.type} ${event.data.phase} (${event.data.model})`;
    case 'phase.finished':
      return `${event.type} ${event.data.phase} (${event.data.model}), ${String(event.data.unansweredQuestions)} unanswered question(s)`;
  }
}

/** One line of text output for a Feature or Epic run event. */
export function formatGroupEvent(event: RunGroupEvent): string {
  if (event.type === 'group.step') return `group: ${event.step}`;
  const lines = [`group ${event.outcome}${event.reason ? `: ${event.reason}` : ''}`];
  for (const r of event.ran)
    lines.push(`  ran #${String(r.issue)} exit ${String(r.code)}: ${r.title}`);
  for (const s of event.skipped)
    lines.push(`  skipped #${String(s.issue)} ${s.reason}: ${s.title}`);
  return lines.join('\n');
}

/** Reads one line of stdin per call, for the select prompt on a TTY. */
function stdinLines(): { readLine: () => Promise<string>; close: () => void } {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  return { readLine: () => rl.question(''), close: () => rl.close() };
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
      return `run ${event.runId} #${String(event.issue)} ${event.repo}${event.dryRun ? ' (dry run)' : ''}: dromos ${event.dromos ?? 'unknown'}; base ${event.base ?? 'none'}; harness ${name}${versions ? ` (${versions})` : ''}; ${models}`;
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
export function runRunCli(argv: string[], io: RunCliIo = {}): Promise<number> {
  return runCommand(argv, io);
}

/** Runs `dromos plan feature|pbi <nr> ...`, the planning half of `dromos run plan`. */
export function runPlanCli(argv: string[], io: RunCliIo = {}): Promise<number> {
  const [kind, ...rest] = argv;
  if (kind !== 'feature' && kind !== 'pbi') {
    const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
    err(
      `dromos: ${kind === undefined ? 'missing' : `unknown`} kind${kind === undefined ? '' : ` ${kind}`}, expected feature or pbi\n${PLAN_USAGE}`,
    );
    return Promise.resolve(2);
  }
  return runCommand(['plan', ...rest], io, kind === 'feature' ? 'Feature' : 'PBI');
}

async function runCommand(
  argv: string[],
  io: RunCliIo,
  planKind?: 'Feature' | 'PBI',
): Promise<number> {
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
    if (sub === 'plan') {
      const { positional, flags, lists } = parseArgs(
        rest,
        ['harness', 'repo', 'format', 'answer', 'assume-recommended'],
        ['assume-recommended'],
        ['answer'],
      );
      const [nr, ...extra] = positional;
      if (nr === undefined || extra.length > 0) {
        throw new UsageError(
          planKind ? `plan ${planKind.toLowerCase()} needs <nr>` : 'plan needs <nr>',
        );
      }
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
      let answers: Map<string, string>;
      try {
        answers = parseAnswerFlags(lists.get('answer') ?? []);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      // Questions are asked only when a person sits at both ends of the terminal.
      const tty = io.plan?.isTty ?? (process.stdout.isTTY === true && process.stdin.isTTY === true);
      const json = !tty || format === 'json';
      const lines = tty && io.plan?.readLine === undefined ? stdinLines() : undefined;
      const readLine = io.plan?.readLine ?? lines?.readLine;
      // With JSON lines on stdout the prompt goes to stderr so the stream stays parseable.
      const promptOut = json ? { write: (t: string) => process.stderr.write(t) } : { write: out };
      const prompt = tty && readLine ? ttySelectPrompt(promptOut, readLine) : undefined;
      db = io.db ?? openDb(join(loadConfig().dataDir, 'bus.db'));
      try {
        return await runPlan({
          issue: Number(nr),
          repo: flags.get('repo') ?? process.cwd(),
          harness: harness?.data,
          kind: planKind,
          resolve: {
            answers,
            assumeRecommended: flags.has('assume-recommended'),
            prompt,
          },
          db,
          now: io.now,
          ops: io.plan?.ops,
          emit: (event) => out(json ? `${JSON.stringify(event)}\n` : `${formatPlanEvent(event)}\n`),
        });
      } finally {
        lines?.close();
      }
    }
    if (sub === 'feature' || sub === 'epic') {
      const level: GroupLevel = sub;
      const { positional, flags } = parseArgs(
        rest,
        ['harness', 'repo', 'format', 'force'],
        ['force'],
      );
      const [nr, ...extra] = positional;
      if (nr === undefined || extra.length > 0) throw new UsageError(`${sub} needs <nr>`);
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
      const tty = io.group?.isTty ?? process.stdout.isTTY === true;
      const json = !tty || format === 'json';
      if (format === 'text' && !tty) err('dromos: stdout is not a TTY, writing JSON lines');
      const line =
        <E>(fmt: (e: E) => string) =>
        (event: E) =>
          out(json ? `${JSON.stringify(event)}\n` : `${fmt(event)}\n`);
      const repo = flags.get('repo') ?? process.cwd();

      // First Ctrl-C: the running PBI unwinds (its claim is released, its worktree kept) and no
      // further PBI starts. Second Ctrl-C: release the claim of the running PBI and exit at once.
      const controller = new AbortController();
      const signals = io.group?.signals ?? process;
      const exit = io.group?.exit ?? ((code: number) => process.exit(code));
      let current: number | null = null;
      const onInterrupt = (): void => {
        if (!controller.signal.aborted) {
          controller.abort();
          err(
            `dromos: interrupted${current === null ? '' : `, finishing #${String(current)}`}; Ctrl-C again to stop now`,
          );
          return;
        }
        const pending = current;
        const release =
          pending === null
            ? Promise.resolve()
            : (io.group?.releaseClaim ?? releaseClaim)(repo, pending).catch(() => undefined);
        void release.then(() => exit(EXIT_INTERRUPTED));
      };
      signals.on('SIGINT', onInterrupt);
      db = io.db ?? openDb(join(loadConfig().dataDir, 'bus.db'));
      try {
        return await runGroup({
          level,
          issue: Number(nr),
          repo,
          harness: harness?.data,
          force: flags.has('force'),
          db,
          now: io.now,
          signal: controller.signal,
          onCurrent: (issue) => {
            current = issue;
          },
          ops: io.group?.ops,
          emit: line(formatGroupEvent),
          emitPbi: line(formatEvent),
          emitPlan: line(formatPlanEvent),
        });
      } finally {
        signals.off('SIGINT', onInterrupt);
      }
    }
    if (sub === 'clean') {
      const { positional, flags } = parseArgs(rest, ['repo'], ['dry-run']);
      const [nr, ...extra] = positional;
      if (extra.length > 0) throw new UsageError('clean takes at most one <nr>');
      if (nr !== undefined && !/^[1-9]\d*$/.test(nr)) {
        throw new UsageError('<nr> must be a positive integer');
      }
      const dryRun = flags.has('dry-run');
      try {
        const result = await runClean({
          repo: flags.get('repo') ?? process.cwd(),
          issue: nr === undefined ? undefined : Number(nr),
          dryRun,
          ops: io.clean?.ops,
        });
        out(`${describeClean(result, dryRun).join('\n')}\n`);
        return 0;
      } catch (error) {
        err(`dromos: ${error instanceof Error ? error.message : String(error)}`);
        return EXIT_ERROR;
      }
    }
    if (sub === 'metrics') {
      const { positional, flags } = parseArgs(rest, ['issues', 'since', 'format']);
      if (positional.length > 0) throw new UsageError('metrics takes no positional arguments');
      const format = flags.get('format') ?? 'json';
      if (format !== 'json' && format !== 'table') {
        throw new UsageError('--format must be json or table');
      }
      const params = new URLSearchParams();
      for (const name of ['issues', 'since'] as const) {
        const value = flags.get(name);
        if (value !== undefined) params.set(name, value);
      }
      const parsed = parseMultiRunMetricsQuery(params);
      if ('error' in parsed) throw new UsageError(parsed.error);
      db = io.db ?? openDb(join(loadConfig().dataDir, 'bus.db'));
      const result = collectRunsMetrics(db, parsed);
      out(format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : formatMetricsTable(result));
      return 0;
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
      err(`dromos: ${error.message}\n${planKind ? PLAN_USAGE : USAGE}`);
      return 2;
    }
    throw error;
  } finally {
    if (db !== undefined && io.db === undefined) db.close();
  }
}
