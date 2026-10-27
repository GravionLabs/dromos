import type { EventRecord } from '../db.js';
import { EVENTS_SCHEMA_VERSION } from '../events/schema.js';

/** One stored event in the wire shape of `BusEventSchema`. */
export interface ExportedEvent {
  id: number;
  type: string;
  at: string;
  source: string;
  agentId: string | null;
  issue: number | null;
  runId: string | null;
  data: unknown;
}

export interface RunExport {
  schema: number;
  issue: number;
  exportedAt: string;
  events: ExportedEvent[];
}

const toWire = (e: EventRecord): ExportedEvent => ({
  id: e.id,
  type: e.kind,
  at: e.createdAt,
  source: e.role,
  agentId: e.agentId,
  issue: e.issue,
  runId: e.runId,
  data: e.data,
});

/** Self-contained export of one issue's events, in the order given (ascending id). */
export function toJsonExport(issue: number, events: EventRecord[], now: Date): RunExport {
  return {
    schema: EVENTS_SCHEMA_VERSION,
    issue,
    exportedAt: now.toISOString(),
    events: events.map(toWire),
  };
}

interface RunNode {
  runAgentId: string;
  pane: string | null;
  parent: string | null;
  agentType: string;
  model: string | null;
  durationMs: number | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** Label text safe for a quoted Mermaid label: no quotes, brackets, braces or line breaks. */
const clean = (s: string): string =>
  s
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/["[\](){}<>&;`|\\]/g, '')
    .trim();

/** Hands out one node id per distinct key: sanitized for Mermaid, with a counter so keys never collide. */
function idAllocator() {
  const ids = new Map<string, string>();
  return (prefix: string, key: string | number): string => {
    const full = `${prefix}\u0000${key}`;
    let id = ids.get(full);
    if (id === undefined) {
      id = `${prefix}${ids.size}_${String(key)
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 24)}`;
      ids.set(full, id);
    }
    return id;
  };
}

/**
 * Mermaid `flowchart TD` of the subagent tree: pane -> depth-1 run -> depth-2 run, plus one
 * annotated node per attention. Labels carry names and numbers only, never free text.
 */
export function toMermaid(events: EventRecord[]): string {
  const runs = new Map<string, RunNode>();
  const panes = new Set<string>();
  const attentions: { id: number; pane: string | null; kind: string; pr: number | null }[] = [];

  for (const e of events) {
    const d = asRecord(e.data);
    if (e.kind === 'agent.run' && typeof d.runAgentId === 'string') {
      const prev = runs.get(d.runAgentId);
      runs.set(d.runAgentId, {
        runAgentId: d.runAgentId,
        pane: e.agentId,
        parent: typeof d.parentAgentId === 'string' ? d.parentAgentId : null,
        agentType: typeof d.agentType === 'string' ? d.agentType : (prev?.agentType ?? 'agent'),
        model: typeof d.model === 'string' ? d.model : (prev?.model ?? null),
        durationMs: typeof d.durationMs === 'number' ? d.durationMs : (prev?.durationMs ?? null),
      });
      if (e.agentId !== null) panes.add(e.agentId);
    } else if (e.kind === 'attention') {
      attentions.push({
        id: e.id,
        pane: e.agentId,
        kind: typeof d.kind === 'string' ? d.kind : 'attention',
        pr: typeof d.pr === 'number' ? d.pr : null,
      });
      if (e.agentId !== null) panes.add(e.agentId);
    }
  }

  const nodeId = idAllocator();
  const lines = ['flowchart TD'];
  for (const pane of panes) lines.push(`  ${nodeId('pane', pane)}["${clean(pane)}"]`);
  for (const r of runs.values()) {
    const time = r.durationMs === null ? 'running' : `${Math.round(r.durationMs / 1000)}s`;
    const parts = [r.agentType, r.model, time].filter((p): p is string => p !== null);
    lines.push(`  ${nodeId('run', r.runAgentId)}["${clean(parts.join(' '))}"]`);
  }
  for (const r of runs.values()) {
    const from =
      r.parent !== null && runs.has(r.parent)
        ? nodeId('run', r.parent)
        : r.pane !== null
          ? nodeId('pane', r.pane)
          : null;
    if (from !== null) lines.push(`  ${from} --> ${nodeId('run', r.runAgentId)}`);
  }
  for (const a of attentions) {
    const id = nodeId('att', a.id);
    const label = a.pr === null ? a.kind : `${a.kind} #${a.pr}`;
    lines.push(`  ${id}{{"${clean(label)}"}}`);
    if (a.pane !== null) lines.push(`  ${nodeId('pane', a.pane)} --> ${id}`);
  }
  return `${lines.join('\n')}\n`;
}
