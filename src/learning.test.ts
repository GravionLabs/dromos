import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { collectLearning } from './learning.js';
import { parseLearningQuery } from './learning-query.js';

const FP_A = 'a'.repeat(40);
const FP_B = 'b'.repeat(40);

function seed() {
  const db = openDb(':memory:');
  const finding = (repo: string | null, issue: number, fingerprint: string) =>
    db.insertEvent('dromos', 'outcome.finding', { fingerprint }, { repo, issue, runId: 'r' });
  const cause = (repo: string, issue: number, kind: string, cause: string) =>
    db.insertEvent('dromos', kind, { cause }, { repo, issue, runId: 'r' });
  finding('acme/one', 1, FP_A);
  finding('acme/one', 1, FP_A);
  finding('acme/two', 7, FP_A);
  finding('acme/two', 7, FP_B);
  finding(null, 3, FP_B);
  cause('acme/one', 1, 'attempt.started', 'gate_failed');
  cause('acme/two', 7, 'attempt.started', 'gate_failed');
  cause('acme/two', 7, 'outcome.fixRound', 'review_findings');
  return db;
}

describe('collectLearning', () => {
  it('counts fingerprints and causes across repositories', () => {
    const result = collectLearning(seed(), {});
    expect(result.fingerprints).toEqual([
      {
        fingerprint: FP_A,
        count: 3,
        runs: ['acme/one#1', 'acme/two#7'],
        repos: { 'acme/one': 2, 'acme/two': 1 },
      },
      {
        fingerprint: FP_B,
        count: 2,
        runs: ['acme/two#7', 'unknown#3'],
        repos: { 'acme/two': 1, unknown: 1 },
      },
    ]);
    expect(result.causes).toEqual([
      { cause: 'gate_failed', count: 2, repos: { 'acme/one': 1, 'acme/two': 1 } },
      { cause: 'review_findings', count: 1, repos: { 'acme/two': 1 } },
    ]);
  });

  it('narrows to one repository', () => {
    const result = collectLearning(seed(), { repo: 'acme/two' });
    expect(result.fingerprints.map((f) => [f.fingerprint, f.count])).toEqual([
      [FP_A, 1],
      [FP_B, 1],
    ]);
    expect(result.causes.map((c) => c.cause)).toEqual(['gate_failed', 'review_findings']);
  });

  it('is empty without events', () => {
    expect(collectLearning(openDb(':memory:'), {})).toEqual({ fingerprints: [], causes: [] });
  });
});

describe('parseLearningQuery', () => {
  it('accepts repo, since and until', () => {
    const p = new URLSearchParams('repo=acme/one&since=2026-10-01T00:00:00Z');
    expect(parseLearningQuery(p)).toEqual({ repo: 'acme/one', since: '2026-10-01T00:00:00.000Z' });
  });

  it.each([
    ['repo=nope', 'repo must be owner/name'],
    ['x=1', 'unknown parameter: x'],
    ['repo=a/b&repo=c/d', 'repeated parameter: repo'],
    ['since=yesterday', 'since must be an ISO-8601 date-time (YYYY-MM-DDTHH:MM...)'],
  ])('rejects %s', (qs, error) => {
    expect(parseLearningQuery(new URLSearchParams(qs))).toEqual({ error });
  });
});
