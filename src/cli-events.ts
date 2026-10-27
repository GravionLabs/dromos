export interface EventsOptions {
  issue?: string;
  type?: string;
  source?: string;
  agentId?: string;
  since?: string;
  until?: string;
  after?: string;
  limit?: string;
  /** Follow `next` until the server reports no more pages. */
  all?: boolean;
  json?: boolean;
  table?: boolean;
  /** Bus base URL. */
  url: string;
}

export interface EventsDeps {
  fetch?: typeof fetch;
  stdout: (text: string) => void;
  stderr?: (text: string) => void;
  /** Whether stdout is a terminal; selects the table format unless `--json` or `--table` is given. */
  isTTY?: boolean;
}

interface EventRow {
  id: number;
  role: string;
  kind: string;
  data: unknown;
  createdAt: string;
  agentId: string | null;
  issue: number | null;
  runId: string | null;
}

interface Page {
  events: EventRow[];
  next: number | null;
}

const QUERY_PARAMS = [
  ['issue', 'issue'],
  ['type', 'type'],
  ['source', 'source'],
  ['agentId', 'agentId'],
  ['since', 'since'],
  ['until', 'until'],
  ['after', 'after'],
  ['limit', 'limit'],
] as const;

const COLUMNS = ['id', 'createdAt', 'issue', 'source', 'type', 'agentId'] as const;

/** Renders events as an aligned table with a header row; `data` is omitted. */
export function formatTable(events: EventRow[]): string {
  const rows = events.map((e) => [
    String(e.id),
    e.createdAt,
    e.issue === null ? '-' : String(e.issue),
    e.role,
    e.kind,
    e.agentId ?? '-',
  ]);
  const all = [[...COLUMNS] as string[], ...rows];
  const widths = COLUMNS.map((_, i) => Math.max(...all.map((r) => (r[i] as string).length)));
  return all
    .map((r) =>
      r
        .map((cell, i) => cell.padEnd(widths[i] as number))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** Runs `dromos events`: queries `GET /events` and prints JSON or a table; resolves to the exit code. */
export async function runEventsCommand(opts: EventsOptions, deps: EventsDeps): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const stderr = deps.stderr ?? (() => {});
  const base = opts.url.replace(/\/+$/, '');
  const table = opts.json ? false : (opts.table ?? deps.isTTY ?? false);

  const params = new URLSearchParams();
  for (const [opt, param] of QUERY_PARAMS) {
    const value = opts[opt];
    if (value !== undefined) params.set(param, value);
  }

  const events: EventRow[] = [];
  let next: number | null = null;
  for (;;) {
    const qs = params.toString();
    let res: Response;
    try {
      res = await doFetch(`${base}/events${qs ? `?${qs}` : ''}`);
    } catch {
      stderr(`dromos: bus not running at ${base} (start it with \`dromos serve\`)`);
      return 1;
    }
    const body = (await res.json().catch(() => null)) as
      | (Partial<Page> & { error?: unknown })
      | null;
    if (!res.ok || body === null || !Array.isArray(body.events)) {
      const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
      stderr(`dromos: ${detail}`);
      return res.status === 400 ? 2 : 1;
    }
    events.push(...body.events);
    next = body.next ?? null;
    if (!opts.all || next === null) break;
    params.set('after', String(next));
  }

  deps.stdout(table ? `${formatTable(events)}\n` : `${JSON.stringify({ events, next })}\n`);
  return 0;
}
