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

      > Did the thing.

      ## Quality gate

      | Step | Command | Exit code | Duration |
      | --- | --- | --- | --- |
      | lint | \`pnpm lint\` | 0 | 1.2 s |
      | test | \`pnpm test\` | 0 | 20.0 s |

      ## Review

      Verdict: approve

      > Looks good.

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
    expect(body).toContain('Verdict: approve\n\n> Looks good.\n\n## Rounds');
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

  it('neutralizes closing keywords, mentions, headings and issue refs in agent text', () => {
    const evil = 'Fixes #99 and closes o/r#5\n## Quality gate\ncc @octocat';
    const body = buildPrBody({
      ...base,
      lastSummary: evil,
      lastReview: {
        verdict: 'approve',
        summary: evil,
        findings: [{ severity: 'important', file: 'a.ts', summary: 'Resolves #7 @bob\n## Rounds' }],
      },
    });
    expect(body.slice(body.indexOf('\n'))).not.toMatch(/(fixes|closes|resolves) (#|o\/r#)\d/i);
    expect(body).not.toMatch(/@(?!\u200b)\w/);
    expect(body.match(/^## /gm)).toHaveLength(4);
    expect(body.match(/^Closes #/gm)).toHaveLength(1);
    expect(body).toContain('> ## Quality gate');
  });

  const summaryOf = (lastSummary: string) =>
    buildPrBody({ ...base, lastSummary, lastReview: null, lastGate: null });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['lone CR', '\r'],
    ['vertical tab', '\v'],
    ['form feed', '\f'],
    ['NEL', '\u0085'],
    ['line separator', ' '],
    ['paragraph separator', ' '],
  ])('quotes every line after a %s so no heading can be forged', (_n, sep) => {
    const body = summaryOf(`intro${sep}## Rounds${sep}x`);
    expect(body).toContain('## Summary\n\n> intro\n> ## Rounds\n> x\n\n## Quality gate');
    expect(body.match(/^## /gm)).toHaveLength(4);
  });

  it.each([['\r'], [' '], ['\v']])('replaces line break %j in table cells with a space', (sep) => {
    const g: GateResult = {
      passed: true,
      steps: [
        { name: `a${sep}## x`, command: `b${sep}c`, exitCode: 1, durationMs: 0, outputTail: '' },
      ],
    };
    expect(buildPrBody({ ...base, lastGate: g })).toContain('| a ## x | `b c` | 1 | 0.0 s |');
  });

  it.each([
    'close',
    'closes',
    'closed',
    'closing',
    'fix',
    'fixes',
    'fixed',
    'fixing',
    'resolve',
    'resolves',
    'resolved',
    'RESOLVING',
  ])('breaks the closing keyword %s', (kw) => {
    const body = summaryOf(`${kw} #42`);
    expect(body).toContain(`> ${kw[0]}​${kw.slice(1)} #​42`);
  });

  it('leaves words that only contain a keyword untouched', () => {
    expect(summaryOf('prefix enclosed unresolved')).toContain('> prefix enclosed unresolved');
  });

  it('breaks @mentions and bare or cross-repo issue refs', () => {
    expect(summaryOf('cc @octocat see o/r#5 and #6')).toContain('> cc @​octocat see o/r#​5 and #​6');
  });

  it('keeps a finding on one line and replaces backticks in its location', () => {
    const body = buildPrBody({
      ...base,
      lastReview: {
        verdict: 'approve',
        summary: 's',
        findings: [{ severity: 'important', file: 'a`b.ts', line: 3, summary: 'one\rtwo' }],
      },
    });
    expect(body).toContain("- **important** `a'b.ts:3` — one two");
  });

  it.each([
    ['a single backtick', 'echo `x`', '`` echo `x` ``'],
    ['a double backtick run', 'a ``b`` c', '``` a ``b`` c ```'],
  ])('fences a command with %s in a longer code span', (_n, command, cellText) => {
    const g: GateResult = {
      passed: true,
      steps: [{ name: 'n', command, exitCode: 0, durationMs: 0, outputTail: '' }],
    };
    expect(buildPrBody({ ...base, lastGate: g })).toContain(`| n | ${cellText} | 0 | 0.0 s |`);
  });
});
