import { describe, expect, it } from 'vitest';
import { findingFingerprint, parseTestSummary } from './outcome.js';

describe('findingFingerprint', () => {
  const f = { file: 'a.ts', rule: 'null-check', title: 'bug' };

  it('is a sha1 hex digest that ignores the line and the explanation', () => {
    expect(findingFingerprint(f)).toMatch(/^[0-9a-f]{40}$/);
    expect(findingFingerprint({ ...f, line: 9, why: 'other' } as typeof f)).toBe(
      findingFingerprint(f),
    );
  });

  it('changes with file, rule and title', () => {
    const base = findingFingerprint(f);
    expect(findingFingerprint({ ...f, file: 'b.ts' })).not.toBe(base);
    expect(findingFingerprint({ ...f, rule: 'other' })).not.toBe(base);
    expect(findingFingerprint({ ...f, title: 'other' })).not.toBe(base);
  });

  it('does not confuse fields that concatenate to the same text', () => {
    expect(findingFingerprint({ file: 'ab', rule: 'c', title: 't' })).not.toBe(
      findingFingerprint({ file: 'a', rule: 'bc', title: 't' }),
    );
  });

  it('treats a missing rule as empty', () => {
    expect(findingFingerprint({ file: 'a.ts', title: 'bug' })).toBe(
      findingFingerprint({ file: 'a.ts', rule: '', title: 'bug' }),
    );
  });
});

describe('parseTestSummary', () => {
  it('reads counts and failing test names from Vitest output', () => {
    const out = [
      ' FAIL  src/a.test.ts > a > fails',
      ' FAIL  src/a.test.ts > a > fails',
      ' FAIL  src/b.test.ts > b > also fails',
      '      Tests  2 failed | 10 passed (12)',
    ].join('\n');
    expect(parseTestSummary(out)).toEqual({
      type: 'outcome.tests',
      data: {
        passed: 10,
        failed: 2,
        failures: ['src/a.test.ts > a > fails', 'src/b.test.ts > b > also fails'],
      },
    });
  });

  it('reads an all-green summary', () => {
    expect(parseTestSummary('      Tests  7 passed (7)').data).toEqual({
      passed: 7,
      failed: 0,
      failures: [],
    });
  });

  it('yields zero counts for output it does not know', () => {
    expect(parseTestSummary('ok').data).toEqual({ passed: 0, failed: 0, failures: [] });
  });

  it('caps the failure list at the schema limit', () => {
    const out = Array.from({ length: 80 }, (_, i) => ` FAIL  t${String(i)}`).join('\n');
    expect(parseTestSummary(out).data.failures).toHaveLength(50);
  });
});
