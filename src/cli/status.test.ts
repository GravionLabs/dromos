import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { runStatusCli } from './status.js';

const ops = {
  readIssue: async (_slug: string, n: number) => ({
    number: n,
    title: '[PBI] feat: thing',
    body: '',
    labels: ['approved'],
    subIssues: [],
    blockedBy: [],
  }),
  issueState: async () => 'OPEN',
  listPrs: async () => [],
};

async function run(argv: string[], isTty: boolean) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runStatusCli(argv, {
    db: openDb(':memory:'),
    out: (t) => stdout.push(t),
    err: (l) => stderr.push(l),
    isTty,
    repoSlug: async () => 'o/r',
    ops,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('\n') };
}

describe('dromos status', () => {
  it('prints a table on a TTY', async () => {
    const res = await run(['5'], true);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^issue\s+level/);
    expect(res.stdout).toContain('#5');
  });

  it('prints JSON with --format json and off a TTY', async () => {
    for (const res of [await run(['5', '--format', 'json'], true), await run(['5'], false)]) {
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        repo: 'o/r',
        issue: 5,
        rows: [{ number: 5, level: 'PBI', state: 'open', labels: ['approved'], pr: null }],
      });
    }
  });

  it.each([
    [[], /status needs <nr>/],
    [['x'], /positive integer/],
    [['5', '--format', 'xml'], /--format must be text or json/],
    [['5', '--nope', 'x'], /unknown option --nope/],
    [['5', '--repo'], /needs a value/],
  ])('rejects %j with exit code 2', async (argv, message) => {
    const res = await run(argv, true);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(message);
    expect(res.stderr).toContain('usage: dromos status <nr>');
  });

  it('exits 3 with the error when GitHub cannot be read', async () => {
    const res = await runStatusCli(['5'], {
      db: openDb(':memory:'),
      out: () => {},
      err: (l) => {
        expect(l).toBe('dromos: gh failed');
      },
      isTty: true,
      repoSlug: async () => 'o/r',
      ops: {
        ...ops,
        readIssue: async () => {
          throw new Error('gh failed');
        },
      },
    });
    expect(res).toBe(3);
  });
});
