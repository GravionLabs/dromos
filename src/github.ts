import { execa } from 'execa';

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export async function viewIssue(repo: string, number: number): Promise<IssueInfo> {
  const { stdout } = await execa('gh', [
    'issue',
    'view',
    String(number),
    '-R',
    repo,
    '--json',
    'number,title,body,labels',
  ]);
  const raw = JSON.parse(stdout) as {
    number: number;
    title: string;
    body?: string | null;
    labels?: { name: string }[];
  };
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    labels: (raw.labels ?? []).map((l) => l.name),
  };
}

export async function repoFromPath(repoPath: string): Promise<string> {
  const { stdout } = await execa(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { cwd: repoPath },
  );
  return stdout.trim();
}
