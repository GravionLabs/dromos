import type { Finding, GateResult, Review } from './schemas.js';

export interface PrBodyInput {
  issueNumber: number;
  lastSummary: string | null;
  lastGate: GateResult | null;
  lastReview: Review | null;
  round: number;
}

const ZWSP = '\u200b';

/**
 * Neutralizes agent-written text: no live closing keywords, no @mentions, and every line is
 * quoted so it cannot forge a section heading.
 */
function untrusted(text: string): string {
  return text
    .replace(/\b(clos|fix|resolv)(e[sd]?|ing)?\b/gi, (m) => `${m[0]}${ZWSP}${m.slice(1)}`)
    .replace(/@/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .split(/\r?\n/)
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
}

function inline(text: string): string {
  return untrusted(text).replace(/\n> ?/g, ' ').replace(/^> ?/, '');
}

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
  return `- **${f.severity}** \`${inline(loc).replace(/`/g, "'")}\` — ${inline(f.summary)}`;
}

function reviewSection(review: Review | null): string {
  if (!review) return '_No review recorded._';
  const parts = [`Verdict: ${review.verdict}`, untrusted(review.summary)];
  if (review.findings.length > 0) {
    parts.push(['### Remaining findings', '', ...review.findings.map(findingItem)].join('\n'));
  }
  return parts.join('\n\n');
}

/** Renders the pull request body for an approved run. Pure; no I/O. */
export function buildPrBody(input: PrBodyInput): string {
  return [
    `Closes #${input.issueNumber}`,
    `## Summary\n\n${input.lastSummary === null ? '_No summary recorded._' : untrusted(input.lastSummary)}`,
    `## Quality gate\n\n${gateSection(input.lastGate)}`,
    `## Review\n\n${reviewSection(input.lastReview)}`,
    `## Rounds\n\n${input.round}`,
    '---\nOpened by dromos',
  ].join('\n\n');
}
