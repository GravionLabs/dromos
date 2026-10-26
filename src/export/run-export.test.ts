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
        '  pane_p["p"]',
        '  run_x["a 4s"]',
        '  run_y["a running"]',
        '  pane_p --> run_x',
        '  run_x --> run_y',
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
    expect(out).toContain('pane_p --> run_y');
    expect(out).toContain('"a m 2s"');
  });

  it('returns only the header for no events', () => {
    expect(toMermaid([])).toBe('flowchart TD\n');
  });
});
