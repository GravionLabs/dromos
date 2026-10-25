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
  writeFileSync,
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
        throw new LeaseConflictError(
          `Checkout ${conflict.lease.path} is leased by issue #${conflict.lease.issue} (${conflict.lease.owner ?? 'apm-hub'}, host ${conflict.lease.host}, heartbeat ${conflict.lease.heartbeat})`,
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

export function renewLease(
  leaseDir: string,
  checkoutPath: string,
  now: Date = new Date(),
): boolean {
  const file = leaseFile(leaseDir, checkoutPath);
  if (isSymlink(file)) throw new Error(`Refusing symlinked path: ${file}`);
  const raw = readOrNull(file);
  if (raw === null) return false;
  let lease: Lease | null;
  try {
    lease = parseLease(raw);
  } catch {
    lease = null;
  }
  if (!lease) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  if (isSymlink(tmp)) throw new Error(`Refusing symlinked path: ${tmp}`);
  try {
    writeFileSync(tmp, serialize({ ...lease, heartbeat: stamp(now) }));
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

export function releaseLease(leaseDir: string, checkoutPath: string): void {
  rmSync(leaseFile(leaseDir, checkoutPath), { force: true });
}
