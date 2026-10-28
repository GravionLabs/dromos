import { REPO_SLUG, timeParam } from './event-query.js';

export type ParsedLearningQuery =
  | { repo?: string; since?: string; until?: string }
  | { error: string };

/** Validates `GET /learning`: optional `repo` (owner/name), `since` and `until`. */
export function parseLearningQuery(params: URLSearchParams): ParsedLearningQuery {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!['repo', 'since', 'until'].includes(key)) return { error: `unknown parameter: ${key}` };
    if (seen.has(key)) return { error: `repeated parameter: ${key}` };
    seen.add(key);
  }
  const query: { repo?: string; since?: string; until?: string } = {};
  const repo = params.get('repo');
  if (repo !== null) {
    if (!REPO_SLUG.test(repo)) return { error: 'repo must be owner/name' };
    query.repo = repo;
  }
  for (const name of ['since', 'until'] as const) {
    const raw = params.get(name);
    if (raw !== null) {
      const t = timeParam(name, raw);
      if (typeof t === 'string') return { error: t };
      query[name] = t.iso;
    }
  }
  return query;
}
