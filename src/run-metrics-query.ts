import { intParam, listParam, timeParam } from './event-query.js';

export const MAX_METRICS_ISSUES = 100;

export type MetricsWindow = { since?: string; until?: string };
export type ParsedRunMetricsQuery =
  | { issues?: number[]; window: MetricsWindow }
  | { error: string };

function parse(params: URLSearchParams, allowed: readonly string[]): ParsedRunMetricsQuery {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      return { error: `unknown parameter: ${key}` };
    }
    if (seen.has(key)) {
      return { error: `repeated parameter: ${key}` };
    }
    seen.add(key);
  }
  const window: MetricsWindow = {};
  for (const name of ['since', 'until'] as const) {
    const raw = params.get(name);
    if (raw !== null) {
      const t = timeParam(name, raw);
      if (typeof t === 'string') {
        return { error: t };
      }
      window[name] = t.iso;
    }
  }
  const rawIssues = params.get('issues');
  if (rawIssues === null) {
    return { window };
  }
  const list = listParam('issues', rawIssues);
  if (typeof list === 'string') {
    return { error: list };
  }
  if (list.length > MAX_METRICS_ISSUES) {
    return { error: `issues must list at most ${MAX_METRICS_ISSUES} issues` };
  }
  const issues: number[] = [];
  for (const item of list) {
    const n = intParam('issues', item);
    if (typeof n === 'string') {
      return { error: 'issues must be a comma-separated list of non-negative integers' };
    }
    if (!issues.includes(n)) {
      issues.push(n);
    }
  }
  return { issues, window };
}

/** Validates `GET /runs/{issue}/metrics`: only `since` and `until`. */
export function parseSingleRunMetricsQuery(params: URLSearchParams): ParsedRunMetricsQuery {
  return parse(params, ['since', 'until']);
}

/** Validates `GET /runs/metrics`: needs `issues` or `since`. */
export function parseMultiRunMetricsQuery(params: URLSearchParams): ParsedRunMetricsQuery {
  const parsed = parse(params, ['issues', 'since', 'until']);
  if ('error' in parsed) {
    return parsed;
  }
  if (parsed.issues === undefined && parsed.window.since === undefined) {
    return { error: 'issues or since is required' };
  }
  return parsed;
}
