import type { Finding, GateResult, Review } from './schemas.js';

export type PrBodyInput = {
  issueNumber: number;
  lastSummary: string | null;
  lastGate: GateResult | null;
  lastReview: Review | null;
  round: number;
};

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function gateSection(gate: GateResult | null): string {
  if (!gate) return '_No gate result recorded._';
  const rows = gate.steps.map(
    (s) =>
      `| ${cell(s.name)} | \`${cell(s.command)}\` | ${s.exitCode} | ${seconds(s.durationMs)} |`,
  );
  return ['| Step | Command | Exit code | Duration |', '| --- | --- | --- | --- |', ...rows].join(
    '\n',
  );
}

function findingItem(f: Finding): string {
  const loc = f.line === undefined ? f.file : `${f.file}:${f.line}`;
  return `- **${f.severity}** \`${loc}\` — ${f.summary}`;
}

function reviewSection(review: Review | null): string {
  if (!review) return '_No review recorded._';
  const parts = [`Verdict: ${review.verdict}`, review.summary];
  if (review.findings.length > 0) {
    parts.push(['### Remaining findings', '', ...review.findings.map(findingItem)].join('\n'));
  }
  return parts.join('\n\n');
}

/** Renders the pull request body for an approved run. Pure; no I/O. */
export function buildPrBody(input: PrBodyInput): string {
  return [
    `Closes #${input.issueNumber}`,
    `## Summary\n\n${input.lastSummary ?? '_No summary recorded._'}`,
    `## Quality gate\n\n${gateSection(input.lastGate)}`,
    `## Review\n\n${reviewSection(input.lastReview)}`,
    `## Rounds\n\n${input.round}`,
    '---\nOpened by dromos',
  ].join('\n\n');
}
