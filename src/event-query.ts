import type { AttentionQuery, AttentionState, EventQuery } from './db.js';

const ALLOWED_KEYS = new Set([
  'issue',
  'type',
  'source',
  'agentId',
  'since',
  'until',
  'after',
  'limit',
]);
const NON_NEGATIVE_INT = /^\d+$/;
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;

export type ParsedEventQuery = { query: EventQuery } | { error: string };

function intParam(name: string, value: string): number | string {
  const n = Number(value);
  if (!NON_NEGATIVE_INT.test(value) || !Number.isSafeInteger(n)) {
    return `${name} must be a non-negative integer`;
  }
  return n;
}

function listParam(name: string, value: string): string[] | string {
  const items = value.split(',');
  return items.some((i) => i === '')
    ? `${name} must be a comma-separated list without empty entries`
    : items;
}

function timeParam(name: string, value: string): string | { iso: string } {
  const ms = Date.parse(value);
  if (!ISO_PREFIX.test(value) || Number.isNaN(ms)) {
    return `${name} must be an ISO-8601 date-time (YYYY-MM-DDTHH:MM...)`;
  }
  return { iso: new Date(ms).toISOString() };
}

function rejectUnknownOrRepeated(
  params: URLSearchParams,
  allowed: Set<string>,
): string | undefined {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      return `unknown parameter: ${key}`;
    }
    if (seen.has(key)) {
      return `repeated parameter: ${key}`;
    }
    seen.add(key);
  }
  return undefined;
}

function limitParam(raw: string | null): number | string {
  if (raw === null) {
    return DEFAULT_QUERY_LIMIT;
  }
  const n = intParam('limit', raw);
  if (typeof n === 'number' && (n < 1 || n > MAX_QUERY_LIMIT)) {
    return `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`;
  }
  return n;
}

/** Validates the `GET /events` query string; the error text names the offending parameter. */
export function parseEventQuery(params: URLSearchParams): ParsedEventQuery {
  const keyError = rejectUnknownOrRepeated(params, ALLOWED_KEYS);
  if (keyError !== undefined) {
    return { error: keyError };
  }
  const query: EventQuery = { limit: DEFAULT_QUERY_LIMIT };

  for (const name of ['issue', 'after', 'limit'] as const) {
    const raw = params.get(name);
    if (raw === null) {
      continue;
    }
    const n = intParam(name, raw);
    if (typeof n === 'string') {
      return { error: n };
    }
    if (name === 'limit') {
      if (n < 1 || n > MAX_QUERY_LIMIT) {
        return { error: `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}` };
      }
      query.limit = n;
    } else {
      query[name] = n;
    }
  }
  for (const [name, field] of [
    ['type', 'types'],
    ['source', 'sources'],
  ] as const) {
    const raw = params.get(name);
    if (raw !== null) {
      const list = listParam(name, raw);
      if (typeof list === 'string') {
        return { error: list };
      }
      query[field] = list;
    }
  }
  const agentId = params.get('agentId');
  if (agentId !== null) {
    if (agentId === '') {
      return { error: 'agentId must not be empty' };
    }
    query.agentId = agentId;
  }
  for (const name of ['since', 'until'] as const) {
    const raw = params.get(name);
    if (raw !== null) {
      const t = timeParam(name, raw);
      if (typeof t === 'string') {
        return { error: t };
      }
      query[name] = t.iso;
    }
  }
  return { query };
}

const ATTENTION_KEYS = new Set(['state', 'issue', 'since', 'limit']);
const ATTENTION_STATES: readonly AttentionState[] = ['open', 'answered', 'acked'];

export type ParsedAttentionQuery = { query: AttentionQuery } | { error: string };

/** Validates the `GET /attention` query string; the error text names the offending parameter. */
export function parseAttentionQuery(params: URLSearchParams): ParsedAttentionQuery {
  const keyError = rejectUnknownOrRepeated(params, ATTENTION_KEYS);
  if (keyError !== undefined) {
    return { error: keyError };
  }
  const limit = limitParam(params.get('limit'));
  if (typeof limit === 'string') {
    return { error: limit };
  }
  const query: AttentionQuery = { limit };
  const state = params.get('state');
  if (state !== null) {
    const match = ATTENTION_STATES.find((s) => s === state);
    if (match === undefined) {
      return { error: `state must be one of ${ATTENTION_STATES.join(', ')}` };
    }
    query.state = match;
  }
  const issue = params.get('issue');
  if (issue !== null) {
    const n = intParam('issue', issue);
    if (typeof n === 'string') {
      return { error: n };
    }
    query.issue = n;
  }
  const since = params.get('since');
  if (since !== null) {
    const t = timeParam('since', since);
    if (typeof t === 'string') {
      return { error: t };
    }
    query.since = t.iso;
  }
  return { query };
}
