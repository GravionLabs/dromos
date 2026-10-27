import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.js';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const paint = (code: string, text: string): string => `${ESC}[${code}m${text}${RESET}`;

const ROLE_COLORS: Record<string, string> = {
  orchestrator: '36',
  implementer: '34',
  reviewer: '35',
};

/** Colors role names inside a line's text, then restores the line's own color. */
function colorRoles(text: string, restore: string): string {
  return text.replace(
    /\b(orchestrator|implementer|reviewer)\b/g,
    (role) => `${RESET}${paint(ROLE_COLORS[role] as string, role)}${restore}`,
  );
}

/** Colors one bus log line (`HH:MM:SS KIND text`) with ANSI escapes; unknown lines pass through. */
export function colorize(line: string): string {
  const match = /^(\S+\s+)(MESSAGE|STATE|GATE|REVIEW|HOOK|INGEST|ERROR)(\s+)(.*)$/.exec(line);
  if (!match) return line;
  const [, time = '', kind = '', gap = '', text = ''] = match;
  let code: string | undefined;
  switch (kind) {
    case 'STATE':
      code = '1;33';
      break;
    case 'GATE':
      code = text.includes('passed') ? '32' : '31';
      break;
    case 'REVIEW':
      code = '35';
      break;
    case 'HOOK':
      code = '2';
      break;
    case 'ERROR':
      code = '1;31';
      break;
  }
  if (code === undefined) return `${time}${kind}${gap}${colorRoles(text, '')}`;
  const restore = `${ESC}[${code}m`;
  return `${restore}${time}${kind}${gap}${colorRoles(text, restore)}${RESET}`;
}

/** Returns the last `n` lines of `content` (no trailing empty line). */
export function lastLines(content: string, n: number): string[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return n <= 0 ? [] : lines.slice(-n);
}

export interface FollowOptions {
  file: string;
  lines: number;
  emit: (line: string) => void;
  signal: AbortSignal;
  /** Fallback poll interval in ms (fs.watch can miss events). */
  pollMs?: number;
}

function readRange(file: string, start: number, end: number): string {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(file, 'r');
  try {
    let read = 0;
    while (read < buf.length) {
      const got = readSync(fd, buf, read, buf.length - read, start + read);
      if (got === 0) break;
      read += got;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Creates the file if missing, emits the last N lines, then emits appended lines until aborted. */
export async function followFile(opts: FollowOptions): Promise<void> {
  const { file, emit, signal } = opts;
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '');

  const size = statSync(file).size;
  for (const line of lastLines(readRange(file, 0, size), opts.lines)) emit(line);

  let offset = size;
  let partial = '';
  const check = (): void => {
    let current: number;
    try {
      current = statSync(file).size;
    } catch {
      return;
    }
    if (current < offset) {
      offset = 0;
      partial = '';
    }
    if (current === offset) return;
    const chunk = partial + readRange(file, offset, current);
    offset = current;
    const parts = chunk.split('\n');
    partial = parts.pop() ?? '';
    for (const line of parts) emit(line);
  };

  const watcher = watch(file, () => check());
  const timer = setInterval(check, opts.pollMs ?? 250);
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  clearInterval(timer);
  watcher.close();
}

export interface LogCliOptions {
  lines?: string | number;
  /** Commander sets `color: false` for `--no-color`. */
  color?: boolean;
}

export interface LogCliIo {
  file?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  signal?: AbortSignal;
}

/** Runs `dromos log`: tails `<dataDir>/bus.log` until the signal aborts (default: SIGINT). */
export async function runLogCli(opts: LogCliOptions, io: LogCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  const lines = opts.lines === undefined ? 50 : Number(opts.lines);
  if (!Number.isInteger(lines) || lines < 0) {
    err(`dromos log: --lines must be a non-negative integer, got ${opts.lines}`);
    return 1;
  }
  const useColor = opts.color !== false && !env.NO_COLOR;
  const file = io.file ?? join(loadConfig().dataDir, 'bus.log');
  let signal = io.signal;
  if (!signal) {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    signal = controller.signal;
  }
  await followFile({
    file,
    lines,
    signal,
    emit: (line) => out(useColor ? colorize(line) : line),
  });
  return 0;
}
