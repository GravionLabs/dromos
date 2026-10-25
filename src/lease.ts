// apm-hub compatible checkout leases (Enter-Checkout.ps1: Get-LeaseKey, Write-Lease, Get-Leases, step 2 takeover).
import { createHash } from 'node:crypto';
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LEASE_TTL_MINUTES = 120;
export const LEASE_OWNER = 'dromos';
const MAX_ATTEMPTS = 5;
const YOUNG_FILE_MS = 10_000;
const RETRY_DELAY_MS = 150;

export type Lease = {
  path: string;
  issue: number;
  branch: string;
  host: string;
  started: string;
  heartbeat: string;
  owner?: string;
};

export type LeaseEntry = { file: string; raw: string; lease: Lease; live: boolean };

export type ClaimRequest = { path: string; issue: number; branch: string };

export type ClaimOptions = {
  now?: () => Date;
  ttlMinutes?: number;
  host?: string;
};

export class LeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseConflictError';
  }
}

export function leaseKey(checkoutPath: string): string {
  return createHash('sha256').update(checkoutPath, 'utf8').digest('hex').slice(0, 16);
}

export function stamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

export function isLive(
  lease: Lease,
  now: Date = new Date(),
  ttlMinutes = LEASE_TTL_MINUTES,
): boolean {
  const beat = Date.parse(lease.heartbeat);
  if (Number.isNaN(beat)) return false;
  return (now.getTime() - beat) / 60_000 < ttlMinutes;
}

export function leaseFile(leaseDir: string, checkoutPath: string): string {
  return join(leaseDir, `${leaseKey(checkoutPath)}.json`);
}

function machineName(): string {
  // .NET Environment.MachineName on Unix: gethostname() cut at the first dot
  return hostname().split('.')[0] ?? hostname();
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function errCode(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e ? String((e as NodeJS.ErrnoException).code) : undefined;
}

function trimSep(p: string): string {
  let end = p.length;
  while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  return p.slice(0, end);
}

function samePath(a: string, b: string): boolean {
  const x = trimSep(a);
  const y = trimSep(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Lease files are foreign input: no control characters, bounded length in messages. */
function clean(value: unknown): string {
  const text = String(value).slice(0, 200);
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? '?' : ch;
  }
  return out;
}

function parseLease(raw: string): Lease | null {
  const o: unknown = JSON.parse(raw);
  if (typeof o !== 'object' || o === null) return null;
  const l = o as Lease;
  if (typeof l.heartbeat !== 'string' || Number.isNaN(Date.parse(l.heartbeat))) return null;
  return l;
}

function serialize(lease: Lease): string {
  return `${JSON.stringify(lease)}\n`;
}

export function readLeases(
  leaseDir: string,
  now: Date = new Date(),
  ttlMinutes = LEASE_TTL_MINUTES,
): LeaseEntry[] {
  const out: LeaseEntry[] = [];
  for (const entry of readdirSync(leaseDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    const file = join(leaseDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlinked path: ${file}`);
    if (!entry.isFile()) continue;
    try {
      const raw = readFileSync(file, 'utf8');
      const lease = parseLease(raw);
      if (lease) out.push({ file, raw, lease, live: isLive(lease, now, ttlMinutes) });
    } catch {
      // unreadable or unparsable: ignored, as Get-Leases
    }
  }
  return out;
}

function readOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function ageMs(p: string, now: Date): number | null {
  try {
    return now.getTime() - lstatSync(p).mtimeMs;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function claimLease(
  leaseDir: string,
  req: ClaimRequest,
  opts: ClaimOptions = {},
): Promise<string> {
  const now = opts.now ?? (() => new Date());
  const ttl = opts.ttlMinutes ?? LEASE_TTL_MINUTES;
  const file = leaseFile(leaseDir, req.path);
  const stale = `${file}.${process.pid}.stale`;
  let created = false;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const leases = readLeases(leaseDir, now(), ttl);
      const conflict = leases.find(
        (l) =>
          l.live &&
          (samePath(l.lease.path, req.path) || String(l.lease.issue) === String(req.issue)),
      );
      if (conflict) {
        const c = conflict.lease;
        throw new LeaseConflictError(
          `Checkout ${clean(c.path)} is leased by issue #${clean(c.issue)} (${clean(c.owner ?? 'apm-hub')}, host ${clean(c.host)}, heartbeat ${clean(c.heartbeat)})`,
        );
      }
      const previous = leases.find((l) => l.file === file);
      const age = ageMs(file, new Date()); // file mtime is wall clock, independent of opts.now
      if (age !== null) {
        if (!previous && age < YOUNG_FILE_MS) {
          await sleep(RETRY_DELAY_MS); // being written by a concurrent claimer: look again
          continue;
        }
        // stale or unreadable: move it away first, one taker wins; a lease changed meanwhile is put back
        if (isSymlink(file)) throw new Error(`Refusing symlinked path: ${file}`);
        const before = previous?.raw ?? null;
        try {
          renameSync(file, stale);
        } catch (e) {
          if (errCode(e) === 'ENOENT') continue;
          throw e;
        }
        const after = readOrNull(stale);
        if (before !== null && after !== before) {
          try {
            linkSync(stale, file); // no-overwrite move back
          } catch {
            // a new lease took the slot meanwhile: keep it
          }
          rmSync(stale, { force: true });
          continue;
        }
        rmSync(stale, { force: true });
      }
      let fd: number;
      try {
        fd = openSync(file, 'wx');
      } catch (e) {
        if (errCode(e) === 'EEXIST') continue;
        throw e;
      }
      created = true;
      const ts = stamp(now());
      const lease: Lease = {
        path: req.path,
        issue: req.issue,
        branch: req.branch,
        host: opts.host ?? machineName(),
        started: ts,
        heartbeat: ts,
        owner: LEASE_OWNER,
      };
      try {
        writeSync(fd, serialize(lease));
      } finally {
        closeSync(fd);
      }
      return file;
    }
    throw new LeaseConflictError(
      `Could not claim lease for ${req.path} after ${MAX_ATTEMPTS} attempts (concurrent claimers)`,
    );
  } catch (e) {
    if (created) rmSync(file, { force: true });
    throw e;
  } finally {
    rmSync(stale, { force: true });
  }
}

/** The lease at the checkout's slot, only when this checkout and (if given) issue own it. */
function ownLease(file: string, checkoutPath: string, issue?: number): Lease | null {
  if (isSymlink(file)) throw new Error(`Refusing symlinked path: ${file}`);
  const raw = readOrNull(file);
  if (raw === null) return null;
  let lease: Lease | null;
  try {
    lease = parseLease(raw);
  } catch {
    return null;
  }
  if (!lease || lease.owner !== LEASE_OWNER || !samePath(String(lease.path), checkoutPath)) {
    return null;
  }
  if (issue !== undefined && String(lease.issue) !== String(issue)) return null;
  return lease;
}

/** Refreshes the heartbeat of our own lease; false when absent or held by someone else. */
export function renewLease(
  leaseDir: string,
  checkoutPath: string,
  now: Date = new Date(),
  issue?: number,
): boolean {
  const file = leaseFile(leaseDir, checkoutPath);
  const lease = ownLease(file, checkoutPath, issue);
  if (!lease) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // unlinks a planted symlink itself, never follows it
  try {
    const fd = openSync(tmp, 'wx'); // O_EXCL: no write through a link created after the rm
    try {
      writeSync(fd, serialize({ ...lease, heartbeat: stamp(now) }));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

/** Removes our own lease; a lease held by someone else (e.g. after a TTL takeover) stays. */
export function releaseLease(leaseDir: string, checkoutPath: string, issue?: number): void {
  const file = leaseFile(leaseDir, checkoutPath);
  if (!ownLease(file, checkoutPath, issue)) return;
  rmSync(file, { force: true });
}
