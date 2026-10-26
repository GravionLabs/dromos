import { describe, expect, it } from 'vitest';
import type { EventRecord } from '../db.js';
import { toJsonExport, toMermaid } from './run-export.js';

const ev = (id: number, kind: string, data: unknown, agentId: string | null): EventRecord => ({
  id,
  role: 'apm-hub/subagent',
  kind,
  data,
  createdAt: '2026-10-23T08:12:00.000Z',
  agentId,
  issue: 5,
  runId: null,
});

describe('toJsonExport', () => {
  it('maps records to wire events under the four envelope keys', () => {
    const doc = toJsonExport(5, [ev(3, 'attention', { kind: 'GATE' }, 'p')], new Date(0));
    expect(doc).toEqual({
      schema: 1,
      issue: 5,
      exportedAt: '1970-01-01T00:00:00.000Z',
      events: [
        {
          id: 3,
          type: 'attention',
          at: '2026-10-23T08:12:00.000Z',
          source: 'apm-hub/subagent',
          agentId: 'p',
          issue: 5,
          runId: null,
          data: { kind: 'GATE' },
        },
      ],
    });
  });

  it('exports an empty event list', () => {
    expect(toJsonExport(5, [], new Date(0)).events).toEqual([]);
  });
});

describe('toMermaid', () => {
  it('merges started and stopped events into one node and nests depth 2', () => {
    const run = (id: number, rid: string, parent: string | null, ms: number | null) =>
      ev(
        id,
        'agent.run',
        { runAgentId: rid, parentAgentId: parent, agentType: 'a', model: null, durationMs: ms },
        'p',
      );
    const out = toMermaid([
      run(1, 'x', null, null),
      run(2, 'y', 'x', null),
      run(3, 'x', null, 4000),
    ]);
    expect(out).toBe(
      [
        'flowchart TD',
        '  pane0_p["p"]',
        '  run1_x["a 4s"]',
        '  run2_y["a running"]',
        '  pane0_p --> run1_x',
        '  run1_x --> run2_y',
        '',
      ].join('\n'),
    );
  });

  it('attaches a run with an unknown parent to its pane', () => {
    const out = toMermaid([
      ev(
        1,
        'agent.run',
        { runAgentId: 'y', parentAgentId: 'gone', agentType: 'a', model: 'm', durationMs: 1500 },
        'p',
      ),
    ]);
    expect(out).toContain('pane0_p --> run1_y');
    expect(out).toContain('"a m 2s"');
  });

  it('returns only the header for no events', () => {
    expect(toMermaid([])).toBe('flowchart TD\n');
  });
});

describe('toMermaid edge cases', () => {
  const run = (id: number, rid: string, parent: string | null, agentId: string | null) =>
    ev(
      id,
      'agent.run',
      { runAgentId: rid, parentAgentId: parent, agentType: 'a', model: null, durationMs: null },
      agentId,
    );

  it('keeps ids that differ only in punctuation as separate nodes', () => {
    const out = toMermaid([run(1, 'a-b', null, 'p'), run(2, 'a_b', null, 'p')]);
    const nodes = out.split('\n').filter((l) => /^ {2}run\d+_\w*\[/.test(l));
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((l) => l.trim().split('[')[0])).size).toBe(2);
    expect(out.match(/pane0_p --> run/g)).toHaveLength(2);
  });

  it('does not loop on a parent cycle', () => {
    const out = toMermaid([run(1, 'x', 'y', 'p'), run(2, 'y', 'x', 'p')]);
    expect(out).toContain('run2_y --> run1_x');
    expect(out).toContain('run1_x --> run2_y');
  });

  it('adds a run without a reporting pane as an unattached node', () => {
    const out = toMermaid([run(1, 'x', null, null)]);
    expect(out).toBe('flowchart TD\n  run0_x["a running"]\n');
  });

  it('links an attention to its pane, or leaves it unlinked without one', () => {
    const out = toMermaid([
      ev(1, 'attention', { kind: 'GATE', pr: 3 }, 'p'),
      ev(2, 'attention', { kind: 'BLOCKED', pr: null }, null),
    ]);
    expect(out).toContain('att1_1{{"GATE #3"}}');
    expect(out).toContain('pane0_p --> att1_1');
    expect(out).toContain('{{"BLOCKED"}}');
    expect(out.match(/-->/g)).toHaveLength(1);
  });

  it('ignores malformed agent.run data and unrelated events', () => {
    const out = toMermaid([ev(1, 'agent.run', 'junk', 'p'), ev(2, 'progress', { line: 'x' }, 'p')]);
    expect(out).toBe('flowchart TD\n');
  });
});
