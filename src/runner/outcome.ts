import { createHash } from 'node:crypto';
import { MAX_TEST_FAILURES } from '../events/schema.js';

/**
 * Outcome events of a run: facts about what the reviewer, the tests and the planner found, reported
 * as data (counts, fingerprints, test names) and never as free text. The bus adds the envelope.
 */
export type OutcomeEvent =
  | {
      type: 'outcome.finding';
      data: { fingerprint: string; blocking: boolean; fixed: boolean };
    }
  | { type: 'outcome.tests'; data: { passed: number; failed: number; failures: string[] } }
  | { type: 'outcome.fixRound'; data: { cause: 'review_findings' } }
  | { type: 'outcome.questions'; data: { count: number; assumed: number } };

/** Stable identity of a finding across runs: sha1 over file, rule and title. Line numbers drift. */
export function findingFingerprint(finding: {
  file: string;
  rule?: string | undefined;
  title: string;
}): string {
  return createHash('sha1')
    .update(JSON.stringify([finding.file, finding.rule ?? '', finding.title]))
    .digest('hex');
}

/**
 * Counts and failing test names from the output of a Vitest run (`Tests  2 failed | 10 passed (12)`,
 * ` FAIL  file > test`). Output of another runner yields zero counts and no names; the pass/fail
 * verdict stays the exit code's.
 */
export function parseTestSummary(output: string): OutcomeEvent & { type: 'outcome.tests' } {
  const line = /^\s*Tests\s+(.+)$/m.exec(output)?.[1] ?? '';
  const count = (word: string): number => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  const failures = [
    ...new Set(
      [...output.matchAll(/^\s*FAIL\s+(\S.*?)\s*$/gm)].flatMap((m) => (m[1] ? [m[1]] : [])),
    ),
  ]
    .map((f) => f.slice(0, 256))
    .slice(0, MAX_TEST_FAILURES);
  return {
    type: 'outcome.tests',
    data: { passed: count('passed'), failed: count('failed'), failures },
  };
}
