import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execa } from 'execa';

function trimTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  return p.slice(0, end);
}

export async function resolveStateDir(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const override = env.DROMOS_STATE_DIR;
  if (override) return resolve(cwd, trimTrailingSeparators(override));
  try {
    const res = await execa('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const common = res.stdout.trim();
    if (!common) throw new Error('empty git common dir');
    return resolve(join(common, 'agents'));
  } catch {
    throw new Error('No state directory: not inside a git repository (set DROMOS_STATE_DIR)');
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function resolveLeaseDir(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const stateDir = await resolveStateDir(repoPath, env, cwd);
  const leaseDir = resolve(stateDir, 'leases');
  const rel = relative(stateDir, leaseDir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing path outside state directory: ${leaseDir}`);
  }
  for (const p of [stateDir, leaseDir]) {
    if (isSymlink(p)) throw new Error(`Refusing symlinked path: ${p}`);
  }
  mkdirSync(leaseDir, { recursive: true });
  return leaseDir;
}
