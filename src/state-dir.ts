import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  const leaseDir = join(stateDir, 'leases');
  // state dir and leases dir must be real directories, not links; created private (0700)
  for (const p of [stateDir, leaseDir]) {
    if (isSymlink(p)) throw new Error(`Refusing symlinked path: ${p}`);
    mkdirSync(p, { recursive: true, mode: 0o700 });
    if (isSymlink(p)) throw new Error(`Refusing symlinked path: ${p}`);
  }
  // no link anywhere in the resolved location, e.g. a symlinked parent of the state dir
  if (realpathSync(leaseDir) !== join(realpathSync(stateDir), 'leases')) {
    throw new Error(`Refusing path outside state directory: ${leaseDir}`);
  }
  return leaseDir;
}
