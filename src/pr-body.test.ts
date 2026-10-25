import { describe, expect, it } from 'vitest';
import { buildPrBody } from './pr-body.js';
import type { GateResult, Review } from './schemas.js';

const gate: GateResult = {
  passed: true,
  steps: [
    {
      name: 'lint',
      command: 'pnpm lint',
      exitCode: 0,
      durationMs: 1234,
      outputTail: 'SECRET-LINT',
    },
    {
      name: 'test',
      command: 'pnpm test',
      exitCode: 0,
      durationMs: 20000,
      outputTail: 'SECRET-TEST',
    },
  ],
};

const review: Review = {
  verdict: 'approve',
  summary: 'Looks good.',
  findings: [
    { severity: 'suggestion', file: 'src/a.ts', line: 12, summary: 'Rename x.' },
    { severity: 'important', file: 'README.md', summary: 'Document it.' },
  ],
};

const base = {
  issueNumber: 18,
  lastSummary: 'Did the thing.',
  lastGate: gate,
  lastReview: review,
  round: 2,
};

describe('buildPrBody', () => {
  it('renders a full body', () => {
    expect(buildPrBody(base)).toMatchInlineSnapshot(`
      "Closes #18

      ## Summary

      Did the thing.

      ## Quality gate

      | Step | Command | Exit code | Duration |
      | --- | --- | --- | --- |
      | lint | \`pnpm lint\` | 0 | 1.2 s |
      | test | \`pnpm test\` | 0 | 20.0 s |

      ## Review

      Verdict: approve

      Looks good.

      ### Remaining findings

      - **suggestion** \`src/a.ts:12\` — Rename x.
      - **important** \`README.md\` — Document it.

      ## Rounds

      2

      ---
      Opened by dromos"
    `);
  });

  it('uses fallbacks for null summary, gate and review', () => {
    const body = buildPrBody({ ...base, lastSummary: null, lastGate: null, lastReview: null });
    expect(body).toContain('## Summary\n\n_No summary recorded._');
    expect(body).toContain('## Quality gate\n\n_No gate result recorded._');
    expect(body).toContain('## Review\n\n_No review recorded._');
  });

  it('omits the findings subsection when there are none', () => {
    const body = buildPrBody({ ...base, lastReview: { ...review, findings: [] } });
    expect(body).toContain('Verdict: approve\n\nLooks good.\n\n## Rounds');
    expect(body).not.toContain('Remaining findings');
  });

  it('escapes pipes in table cells', () => {
    const g: GateResult = {
      passed: true,
      steps: [
        { name: 'a|b', command: 'cat x | grep y', exitCode: 0, durationMs: 0, outputTail: '' },
      ],
    };
    expect(buildPrBody({ ...base, lastGate: g })).toContain(
      '| a\\|b | `cat x \\| grep y` | 0 | 0.0 s |',
    );
  });

  it('never includes outputTail', () => {
    const body = buildPrBody(base);
    expect(body).not.toContain('SECRET-LINT');
    expect(body).not.toContain('SECRET-TEST');
  });
});
