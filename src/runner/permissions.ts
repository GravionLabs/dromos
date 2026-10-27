import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Decision, RunEvent } from './harness.js';

// Ported from apm-hub v2.5.4: `allowed-commands.ps1` (allowlist) and `git-guardrails.sh` (guardrails).
// Like the hook this is a guardrail against accidents, not a sandbox: a command built to evade it gets
// through (variable forms such as `g${x}it`, unwrapped runners such as ssh or `find -exec`).

/**
 * Command prefixes the narrow permission set allows. `git` is limited to the subcommands the
 * pipeline uses. `gh` is not allowed: the runner owns all GitHub access (`github.ts`). `git push` also matches a
 * forced push (the guardrails below deny those to `main` and `release/*`); pwsh and the build tools run arbitrary code.
 */
export const ALLOWED_COMMANDS: readonly string[] = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git add',
  'git commit',
  'git checkout',
  'git switch',
  'git branch',
  'git fetch',
  'git push',
  'git rev-parse',
  'git rev-list',
  'git merge-base',
  'git ls-files',
  'git remote',
  'pwsh',
  'pnpm',
  'npm',
  'npx',
  'node',
  'dotnet',
  'uv',
  'python',
  'ng',
];

/** Tool names (lower case) whose input is a shell command; every other tool passes untouched. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'run_shell_command']);

const UNKNOWN_BRANCH = '(unknown branch)';
const MAX_DEPTH = 24;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

export interface PermissionOptions {
  /** The worktree the phase runs in. */
  cwd: string;
  /** Extra command prefixes (`allow` of the runner config), on top of {@link ALLOWED_COMMANDS}. */
  allow?: readonly string[];
  /** Current branch of the repository at `dir`, `null` when it cannot be read. */
  currentBranch?: (dir: string) => string | null;
  /** Uncommitted changes in `dir`; an unreadable repository must report `true`. */
  isDirty?: (dir: string) => boolean;
  now?: () => Date;
}

export interface Permissions {
  /** Pass as `PhaseInput.allow`. */
  allow: (tool: string, input: unknown) => Decision;
  /** One `permission_denied` event per deny, in order; the harness appends them to its trace. */
  denied: RunEvent[];
}

/** Builds the permission callback for one phase. Config `allow` extends the list, guardrails always apply. */
export function createPermissions(options: PermissionOptions): Permissions {
  const prefixes = [...ALLOWED_COMMANDS, ...(options.allow ?? [])].map(splitPrefix);
  const denied: RunEvent[] = [];
  const now = options.now ?? (() => new Date());
  const env: Env = {
    cwd: options.cwd,
    currentBranch: options.currentBranch ?? gitBranch,
    isDirty: options.isDirty ?? gitDirty,
  };

  const deny = (tool: string, reason: string): Decision => {
    denied.push({
      at: now().toISOString(),
      kind: 'permission_denied',
      summary: `${tool}: ${reason}`.slice(0, 500),
    });
    return { allow: false, reason };
  };

  return {
    denied,
    allow(tool, input) {
      if (!SHELL_TOOLS.has(tool.toLowerCase())) return { allow: true };
      const command = commandOf(input);
      if (command === null) return deny(tool, 'shell call without a command');
      const scan: Scan = { commands: [], reason: null, moved: false };
      try {
        analyze(env, scan, command, 0);
      } catch (e) {
        if (!(e instanceof Guard)) throw e;
        return deny(tool, e.message);
      }
      if (scan.reason !== null) return deny(tool, scan.reason);
      for (const words of scan.commands) {
        if (!prefixes.some((p) => startsWith(words, p))) {
          return deny(tool, `command not in the allowlist: ${words.join(' ').slice(0, 120)}`);
        }
      }
      return { allow: true };
    },
  };
}

function splitPrefix(entry: string): string[] {
  return entry.trim().split(/\s+/);
}

function startsWith(words: string[], prefix: string[]): boolean {
  return prefix.every((p, i) => words[i] === p);
}

/** The command of a shell tool call: Claude `{command}`, Copilot `{toolArgs}` as JSON string or object. */
function commandOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.command === 'string') return o.command;
  let args = o.toolArgs ?? o.tool_input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (typeof args === 'object' && args !== null) {
    const c = (args as Record<string, unknown>).command;
    if (typeof c === 'string') return c;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Git state

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        dir,
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
    );
  } catch {
    return null;
  }
}

function gitBranch(dir: string): string | null {
  const out = git(dir, ['symbolic-ref', '--short', 'HEAD']);
  return out === null ? null : out.trim() || null;
}

function gitDirty(dir: string): boolean {
  const out = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  return out === null || out.trim() !== '';
}

// ---------------------------------------------------------------------------------------------
// Guardrails: tokenizer and checks

interface Env {
  cwd: string;
  currentBranch: (dir: string) => string | null;
  isDirty: (dir: string) => boolean;
}

interface Scan {
  /** Every simple command found, words unquoted, assignments stripped; the allowlist applies to these. */
  commands: string[][];
  reason: string | null;
  /** A `cd` was seen: later `checkout .` is judged against an unknown directory. */
  moved: boolean;
}

class Guard extends Error {}

/** A parsed simple command plus the text it can feed into a following shell. */
interface Segment {
  words: string[];
  heredocs: { delim: string; quoted: boolean; strip: boolean }[];
  herestr: string[];
  /** The command on the left of the pipe into this one. */
  pipedFrom: Segment | null;
  /** Heredoc body, once read (after the segment is closed). */
  body: string | null;
  procSubsts: string[];
}

function analyze(
  env: Env,
  scan: Scan,
  script: string,
  depth: number,
  mode: 'plain' | 'dq' = 'plain',
): void {
  if (depth > MAX_DEPTH)
    throw new Guard('the command nests deeper than 24 levels and is not inspected');
  const segments = parse(env, scan, script, depth, mode);
  for (const seg of segments.list) handle(env, scan, seg, depth);
}

/** echo/printf text or heredoc body that a following shell would run. */
function feedText(seg: Segment): string | null {
  const w = seg.words;
  if (w[0] === 'echo') return w.slice(1).join(' ');
  if (w[0] === 'printf') return w.slice(1).join(' ').replace(/\\n/g, '\n');
  if (w[0] === 'cat') return seg.body;
  return null;
}

interface Parsed {
  list: Segment[];
}

const OPERATORS = new Set([';', '&', '|', '(', ')', '{', '}', '\n']);

function parse(env: Env, scan: Scan, s: string, depth: number, mode: 'plain' | 'dq'): Parsed {
  const list: Segment[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let heredocs: Segment['heredocs'] = [];
  let herestr: string[] = [];
  let procSubsts: string[] = [];
  let skipNext = false; // next word is a redirect target
  let herestrNext = false;
  let heredocPending: { quoted: boolean; strip: boolean } | null = null;
  let pipedFrom: Segment | null = null;
  let dq = mode === 'dq';
  let sq = false;
  const pendingBodies: { delim: string; quoted: boolean; strip: boolean; seg: Segment }[] = [];
  let i = 0;

  const flushWord = () => {
    if (!inWord) return;
    if (heredocPending) {
      heredocs.push({ delim: word, quoted: heredocPending.quoted, strip: heredocPending.strip });
      heredocPending = null;
    } else if (herestrNext) {
      herestr.push(word);
      herestrNext = false;
    } else if (skipNext) {
      skipNext = false;
    } else {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = (pipe: boolean) => {
    flushWord();
    if (
      words.length === 0 &&
      heredocs.length === 0 &&
      herestr.length === 0 &&
      procSubsts.length === 0
    )
      return;
    const seg: Segment = { words, heredocs, herestr, pipedFrom, body: null, procSubsts };
    list.push(seg);
    for (const h of heredocs) pendingBodies.push({ ...h, seg });
    pipedFrom = pipe ? seg : null;
    words = [];
    heredocs = [];
    herestr = [];
    procSubsts = [];
  };

  while (i < s.length) {
    const c = s[i] as string;
    if (sq) {
      if (c === "'") sq = false;
      else word += c;
      i++;
      continue;
    }
    if (c === '\\') {
      const nx = s[i + 1] ?? '';
      if (dq && !'"\\$`\n'.includes(nx)) word += c;
      else if (nx !== '\n') word += nx;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
      const end = matchParen(s, i + 2);
      analyze(env, scan, s.slice(i + 2, end), depth + 1);
      word += 'X';
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
      const end = matchParen(s, i + 2);
      word += 'X';
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      const stop = end === -1 ? s.length : end;
      analyze(env, scan, s.slice(i + 1, stop), depth + 1);
      word += 'X';
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (dq) {
      if (c === '"' && mode !== 'dq') dq = false;
      else word += c;
      i++;
      continue;
    }
    if (c === "'") {
      sq = true;
      inWord = true;
      i++;
      continue;
    }
    if (c === '"') {
      dq = true;
      inWord = true;
      i++;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // $'...': backslash escapes the next character
      let j = i + 2;
      while (j < s.length && s[j] !== "'") {
        word += s[j] === '\\' ? (s[++j] ?? '') : s[j];
        j++;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      flushWord();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '(' && s[i + 1] === '(' && !inWord) {
      i = matchParen(s, i + 2) + 1;
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      const end = matchParen(s, i + 2);
      const inner = s.slice(i + 2, end);
      analyze(env, scan, inner, depth + 1);
      if (c === '<') {
        const first = parse(
          env,
          { commands: [], reason: null, moved: false },
          inner,
          depth + 1,
          'plain',
        ).list[0];
        const text = first ? feedText(first) : null;
        if (text !== null) procSubsts.push(text);
      }
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '<' || c === '>') {
      // a lone digit before the redirect is a file descriptor, not an argument
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else flushWord();
      if (c === '<' && s.startsWith('<<<', i)) {
        herestrNext = true;
        i += 3;
        continue;
      }
      if (c === '<' && s[i + 1] === '<') {
        const strip = s[i + 2] === '-';
        i += strip ? 3 : 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
        // delimiter word; quoting it makes the body plain text
        let j = i;
        let quoted = false;
        let d = '';
        while (j < s.length && !' \t\n;|&()<>'.includes(s[j] as string)) {
          const ch = s[j] as string;
          if (ch === "'" || ch === '"' || ch === '\\') quoted = true;
          else d += ch;
          j++;
        }
        heredocs.push({ delim: d, quoted, strip });
        i = j;
        continue;
      }
      i++;
      if (s[i] === '>' || s[i] === '|') i++;
      if (s[i] === '&') i++;
      skipNext = true;
      continue;
    }
    if (c === '\n') {
      endSegment(false);
      i++;
      // read the bodies of the pending heredocs
      while (pendingBodies.length > 0) {
        const hd = pendingBodies.shift() as (typeof pendingBodies)[number];
        let body = '';
        while (i < s.length) {
          let eol = s.indexOf('\n', i);
          if (eol === -1) eol = s.length;
          const line = s.slice(i, eol);
          i = Math.min(eol + 1, s.length);
          if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) break;
          body += `${line}\n`;
        }
        scanHeredoc(env, scan, hd.seg, hd, body, depth);
      }
      continue;
    }
    if (OPERATORS.has(c)) {
      if (c === '{' || c === '}') {
        if (inWord) {
          word += c;
          i++;
          continue;
        }
      }
      const pipe = c === '|' && s[i + 1] !== '|';
      if (c === '|' && s[i + 1] === '|') i++;
      if (c === '&' && s[i + 1] === '&') i++;
      if (pipe && s[i + 1] === '&') i++;
      endSegment(pipe);
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endSegment(false);
  // heredoc bodies of the last segment: none left, the delimiter line was missing
  return { list };
}

/** A heredoc body is plain text unless a shell consumes it; an unquoted delimiter still expands `$(...)`. */
function scanHeredoc(
  env: Env,
  scan: Scan,
  seg: Segment,
  hd: { quoted: boolean },
  body: string,
  depth: number,
): void {
  const consumer = unwrapShell(seg.words);
  if (consumer.isShell && !consumer.hasScript) analyze(env, scan, body, depth + 1);
  else if (!hd.quoted) analyze(env, scan, body, depth + 1, 'dq');
  seg.body = body;
}

function matchParen(s: string, from: number): number {
  let level = 1;
  let q = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i] as string;
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === '\\') i++;
    else if (c === '(') level++;
    else if (c === ')' && --level === 0) return i;
  }
  return s.length;
}

function unwrapShell(words: string[]): { isShell: boolean; hasScript: boolean } {
  const name = baseName(words[0] ?? '');
  if (!SHELLS.has(name)) return { isShell: false, hasScript: false };
  for (const a of words.slice(1)) {
    if (a === '-' || a === '-s') continue;
    if (a.startsWith('-')) {
      if (/^-[a-zA-Z]*c/.test(a)) return { isShell: true, hasScript: true };
      continue;
    }
    return { isShell: true, hasScript: true }; // a script file
  }
  return { isShell: true, hasScript: false };
}

function baseName(w: string): string {
  return w.slice(w.lastIndexOf('/') + 1);
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Wrappers run their last argument group as a command; value says how many leading arguments take a value. */
const OPT_WITH_VALUE: Record<string, string[]> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  stdbuf: ['-i', '-o', '-e'],
  flock: ['-w', '-E', '--timeout', '--conflict-exit-code'],
  chronic: [],
  unbuffer: [],
  time: [],
  command: [],
  exec: ['-a'],
  builtin: [],
};

function handle(env: Env, scan: Scan, seg: Segment, depth: number): void {
  let words = [...seg.words];
  let foreignEnv = false;
  while (words.length > 0 && ASSIGN.test(words[0] as string)) {
    if (/^(GIT_DIR|GIT_WORK_TREE)=/.test(words[0] as string)) foreignEnv = true;
    words.shift();
  }
  if (words.length === 0) return;
  scan.commands.push(words);

  // follow wrappers down to the command they run
  for (let guard = 0; guard < MAX_DEPTH && words.length > 0; guard++) {
    while (words.length > 0 && ASSIGN.test(words[0] as string)) {
      if (/^(GIT_DIR|GIT_WORK_TREE)=/.test(words[0] as string)) foreignEnv = true;
      words.shift();
    }
    const name = baseName(words[0] as string);
    const rest = words.slice(1);

    if (name === 'cd' || name === 'pushd') {
      scan.moved = true;
      return;
    }
    if (SHELLS.has(name)) {
      shellArgs(env, scan, name, rest, seg, depth);
      return;
    }
    if (name === 'eval') {
      analyze(env, scan, rest.join(' '), depth + 1);
      return;
    }
    if (name === 'source' || name === '.') {
      for (const t of seg.procSubsts) analyze(env, scan, t, depth + 1);
      return;
    }
    if (name === 'su') {
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k] as string;
        if (a === '-c' || a === '--command') analyze(env, scan, rest[k + 1] ?? '', depth + 1);
        else if (/^-[a-zA-Z]*c$/.test(a)) analyze(env, scan, rest[k + 1] ?? '', depth + 1);
      }
      return;
    }
    if (name === 'script') {
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k] as string;
        if (a.startsWith('--command=')) analyze(env, scan, a.slice('--command='.length), depth + 1);
        else if (/^-[a-zA-Z]*c$/.test(a)) analyze(env, scan, rest[k + 1] ?? '', depth + 1);
      }
      return;
    }
    if (name === 'flock') {
      const i = rest.indexOf('-c');
      if (i >= 0) {
        analyze(env, scan, rest[i + 1] ?? '', depth + 1);
        return;
      }
    }
    if (name in OPT_WITH_VALUE) {
      const valued = OPT_WITH_VALUE[name] as string[];
      let k = 0;
      while (k < rest.length) {
        const a = rest[k] as string;
        if (ASSIGN.test(a) && name === 'env') {
          if (/^(GIT_DIR|GIT_WORK_TREE)=/.test(a)) foreignEnv = true;
          k++;
        } else if (valued.includes(a)) k += 2;
        else if (a.startsWith('-') && a !== '-') k++;
        else break;
      }
      if (name === 'timeout' || name === 'flock') k++; // duration / lock file
      if (name === 'nice' && /^\d+$/.test(rest[k] ?? '')) k++;
      words = rest.slice(k);
      continue;
    }
    if (name === 'git') {
      checkGit(env, scan, rest, foreignEnv);
    }
    return;
  }
}

function shellArgs(
  env: Env,
  scan: Scan,
  _name: string,
  args: string[],
  seg: Segment,
  depth: number,
): void {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a.startsWith('-') && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) {
      analyze(env, scan, args[k + 1] ?? '', depth + 1);
      return;
    }
    if (!a.startsWith('-')) break;
  }
  const state = unwrapShell(['bash', ...args]);
  // a shell with no script reads stdin: here-strings and echo/printf text piped into it are commands
  if (!state.hasScript) {
    for (const t of seg.herestr) analyze(env, scan, t, depth + 1);
    const fed = seg.pipedFrom ? feedText(seg.pipedFrom) : null;
    if (fed !== null) analyze(env, scan, fed, depth + 1);
  } else {
    for (const t of seg.procSubsts) analyze(env, scan, t, depth + 1);
  }
}

function isProtected(branch: string): boolean {
  const r = branch.replace(/^refs\/heads\//, '');
  return r === 'main' || r.startsWith('release/') || r === UNKNOWN_BRANCH;
}

function hasShort(opts: string[], letter: string): boolean {
  return opts.some((a) => !a.startsWith('--') && a.startsWith('-') && a.includes(letter));
}

function checkGit(env: Env, scan: Scan, tokens: string[], foreignEnv: boolean): void {
  let wd = env.cwd;
  let cflag = false;
  let foreign = foreignEnv;
  const aliases: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const a = tokens[i] as string;
    if (a === '-C') {
      if (i + 1 < tokens.length) {
        wd = resolve(wd, tokens[i + 1] as string);
        cflag = true;
        i++;
      }
    } else if (a === '-c') {
      const v = tokens[i + 1];
      if (v !== undefined && /^alias\..+=/i.test(v)) aliases.push(v);
      i++;
    } else if (a === '--git-dir' || a === '--work-tree') {
      foreign = true;
      i++;
    } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) foreign = true;
    else if (a === '--namespace') i++;
    else if (a.startsWith('-')) continue;
    else break;
  }
  if (i >= tokens.length) return;
  const sub = tokens[i] as string;
  const args = tokens.slice(i + 1);
  const dd = args.indexOf('--');
  const opts = dd === -1 ? args : args.slice(0, dd); // options end at --

  for (const al of aliases) {
    const eq = al.indexOf('=');
    const name = al.slice(0, eq).slice(al.indexOf('.') + 1);
    const value = al.slice(eq + 1);
    const tail =
      name.toLowerCase() === sub.toLowerCase() ? ` ${args.map(shellQuote).join(' ')}` : '';
    if (value.startsWith('!')) analyze(env, scan, `${value.slice(1)}${tail}`, 1);
    else analyze(env, scan, `git ${value}${tail}`, 1);
  }

  // a repository other than the session's is never inspected with git
  const inOwn = !foreign && (!cflag || insideRepo(env.cwd, wd));
  const branch = (): string => {
    if (foreign || !inOwn) return UNKNOWN_BRANCH;
    return env.currentBranch(wd) ?? UNKNOWN_BRANCH;
  };

  switch (sub) {
    case 'push': {
      let force = false;
      let del = false;
      let skip = false;
      let repo = false;
      const refs: string[] = [];
      for (const a of args) {
        if (skip) {
          skip = false;
          continue;
        }
        if (
          ['--force', '--force-with-lease', '--force-if-includes'].includes(a) ||
          a.startsWith('--force-with-lease=')
        )
          force = true;
        else if (a === '--delete') del = true;
        else if (a === '--repo') {
          skip = true;
          repo = true;
        } else if (['--push-option', '--receive-pack', '--exec'].includes(a)) skip = true;
        else if (a.startsWith('--')) continue;
        else if (a.startsWith('-')) {
          if (a.includes('f')) force = true;
          if (a.includes('d')) del = true;
          if (a.endsWith('o')) skip = true;
        } else refs.push(a);
      }
      const specs = repo ? refs : refs.slice(1); // refs[0] is the remote
      for (const a of specs) {
        if (a.startsWith('+')) force = true;
        else if (a.startsWith(':')) del = true;
      }
      if (!force && !del) return;
      const cur = branch();
      if (specs.length === 0) {
        if (force && isProtected(cur))
          throw new Guard(`git guardrails: force push of ${cur} is blocked`);
        return;
      }
      for (const a of specs) {
        let pf = force;
        let isDel = false;
        let d = a;
        if (d.startsWith('+')) {
          pf = true;
          d = d.slice(1);
        }
        let dst = d;
        if (d.includes(':')) {
          dst = d.slice(d.lastIndexOf(':') + 1);
          if (d.startsWith(':')) isDel = true;
        }
        dst = dst.replace(/^refs\/heads\//, '');
        if (dst === 'HEAD' || dst === '@') dst = cur;
        if (!isProtected(dst)) continue;
        if ((isDel || del) && dst !== 'release/next') {
          throw new Guard(`git guardrails: deleting ${dst} on the remote is blocked`);
        }
        if (pf) throw new Guard(`git guardrails: force push to ${dst} is blocked`);
      }
      return;
    }
    case 'reset':
      if (opts.includes('--hard'))
        throw new Guard('git guardrails: git reset --hard discards uncommitted work');
      return;
    case 'clean':
      if (hasShort(opts, 'n') || opts.includes('--dry-run')) return;
      if (hasShort(opts, 'f') || opts.includes('--force'))
        throw new Guard('git guardrails: git clean -f deletes untracked files');
      return;
    case 'branch': {
      let del = false;
      let force = false;
      for (const a of opts) {
        if (a === '--delete') del = true;
        else if (a === '--force') force = true;
        else if (a.startsWith('--')) continue;
        else if (a.startsWith('-')) {
          if (a.includes('D')) {
            del = true;
            force = true;
          }
          if (a.includes('d')) del = true;
          if (a.includes('f')) force = true;
        }
      }
      if (del && force) throw new Guard('git guardrails: git branch -D force-deletes a branch');
      return;
    }
    case 'checkout':
    case 'restore': {
      let all = false;
      let staged = false;
      let worktree = false;
      for (const a of args) {
        if (a === '--staged' || a === '-S') staged = true;
        else if (a === '--worktree' || a === '-W') worktree = true;
        else if ([':/', ':/.', ':(top)', '*'].includes(a) || /^\.\.?(\/+\.\.?)*\/*$/.test(a))
          all = true;
      }
      if (!all) return;
      if (sub === 'restore' && staged && !worktree) return;
      const dirty = scan.moved || foreign || !inOwn || env.isDirty(wd);
      if (dirty) throw new Guard(`git guardrails: git ${sub} . discards uncommitted changes`);
      return;
    }
  }
}

/** `wd` lies in the repository of `root` with no nested repository (a `.git` entry) on the way up. */
function insideRepo(root: string, wd: string): boolean {
  let d = resolve(wd);
  const top = resolve(root);
  for (;;) {
    if (d === top) return true;
    if (!d.startsWith(`${top}/`) && !d.startsWith(`${top}\\`)) return false;
    if (existsSync(join(d, '.git'))) return false;
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

function shellQuote(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`;
}
