# dromos

Local event bus for coding agents. dromos collects the events of unattended [apm-hub](https://github.com/GravionLabs/apm-hub) orchestrator loops and of the herdr plugin, keeps their history and run metrics, tracks attention (questions and gates that wait for a human) and, with the runner, drives harness sessions. Formerly `agent-bus`; the old `agent-bus.config.json` still loads with a deprecation warning for one release.

What it offers:

- **Events**: a typed event stream (`GET /events/stream`) and `POST /ingest` for producers such as apm-hub hooks. The bus works without any terminal.
- **History and metrics**: stored events with query and per-run metrics for apm-hub's retro (planned).
- **Attention**: gates and questions with an id and state that a human answers (planned).
- **Runner**: `dromos run epic|feature|pbi <nr>` owns the control flow and calls one flat harness session (Claude, Copilot) per step; apm-hub supplies only the skills and prompts (planned, see [ROADMAP.md](ROADMAP.md) Stage 4).
- **MCP tools** at `/mcp/<role>`: `ping`, `whoami` and the messaging tools `post`, `ack`, `inbox`. The pull-model tools (`start_run`, `submit_implementation`, `submit_review`, `open_pr`, `status`) are gone: the runner owns worktrees, the gate (build, tests, lint), the round limit and the pull request.

dromos does not provide its own interactive role workflow (orchestrator, implementer and reviewer terminals started by dromos): that was dropped, apm-hub's orchestrator and agents cover it. The workspace is the herdr plugin (`dromos-herdr`, primary). The Rust multiplexer `dromos-mux` is parked: the code stays in the repository but is not on the roadmap.

Architecture: dromos owns the control flow, apm-hub is content. The runner reads the issue hierarchy from GitHub, plans, selects the next approved PBI and calls harness sessions; the bus keeps events and metrics. GitHub stays the source of truth for issue state.

```
 runner (dromos run) ──► harness sessions (Claude, Copilot; skills from apm-hub)
        │                          │
        └──── events, usage ───────┤
                                   ▼
 apm-hub hooks (POST /ingest) ──► bus ──► SQLite history, metrics, attention
 herdr plugin (events, attention) ─┘
```

## Status

Early development. Implemented: project foundation and messaging (`post`, `ack`, `inbox`, `/events`, `/events/stream`, bus log) over streamable HTTP at `/mcp/<role>`, `POST /ingest`, agent instances and the workflow core. The `dromos` CLI (`serve`, `run pbi`, `run export`, `attention`) is installed as the `dromos` bin. Everything else below is **planned**, including `dromos log`. Order of work: [ROADMAP.md](ROADMAP.md); the bus core is Epic #166.

## Event stream

`GET /events/stream` is a server-sent-events stream of every stored event (hook events from `POST /events`, agent events). Each event is sent after its row is written, as one frame without an `event:` field, so `EventSource.onmessage` receives every kind:

```text
id: 42
data: {"id":42,"role":"implementer","kind":"hook:idle","data":{...},"createdAt":"..."}
```

- Resume: the `Last-Event-ID` header (sent by `EventSource` on reconnect) or `?since=<id>` replays every event with a larger id in id order, then switches to live events, without gaps or duplicates. The header wins over `?since`. Without either, only live events are sent. A value that is not a non-negative integer answers `400 { error }`; `?since=0` replays everything.
- Heartbeat: a `: heartbeat` comment every 15 seconds keeps idle connections open.
- An id beyond the newest stored event is treated as the newest id, so later live events still arrive.
- Limits: at most 64 concurrent streams (further requests get 503); a live client whose unsent backlog exceeds 1 MiB is disconnected and can resume with `Last-Event-ID`.
- Security: `Host` (and `Origin`, when sent) must name `127.0.0.1`, `localhost`, `[::1]` or the configured bind host, else 403 (DNS-rebinding guard). There is no authentication, like `POST /events`. Other methods answer 405.

## POST /ingest

`POST /ingest` lets non-MCP producers (Claude hooks, scripts, the apm-hub queue runner) report events to the bus. The body is one event or a non-empty JSON array of events. `id` and `at` are assigned by the server (client values are ignored); `source` is required.

```sh
curl -i http://127.0.0.1:4777/ingest \
  -d '{"type":"progress","source":"apm-hub/hook","agentId":null,"issue":43,"runId":null,"data":{"line":"built","agent":"orchestrator"}}'
# HTTP/1.1 202 Accepted
# {"ids":[1]}
```

The event then appears on `GET /events/stream` as `id: 1` with `data: {"id":1,"role":"apm-hub/hook","kind":"progress",...}` (`role` is the `source`, `kind` is the `type`). The envelope fields `agentId`, `issue` and `runId` are stored with the event and appear in the frame and in `Last-Event-ID` replays as `agentId`, `issue`, `runId`; they are `null` for events recorded without them (for example `POST /events`). Databases created before this are migrated in place on startup (three nullable columns, existing rows get `null`).

- Allowed `type` values: `progress`, `attention`, `usage`, `queue.item`, `agent.state`, `agent.run`. Any other type answers `403 { error }`.
- `agent.run` reports one subagent run of a client session (parent, tool call, depth). It is a client-side subagent, not a bus agent: bus agent instances use `agent.registered` / `agent.state`.
- `202 { ids }`: stored (in order), then broadcast to stream subscribers in id order right after the commit, before the reply is written. Broadcasting only queues frames, so the reply never waits on a slow subscriber.
- `Content-Type`: a request without an `Origin` header (curl, hooks, scripts) may send any or no `Content-Type`; the body is always parsed as JSON, so plain `curl -d` works. A request with an `Origin` (a browser) must pass the `Host`/`Origin` guard below and send `application/json`.
- `400 { error }`: invalid JSON, an empty array, or an item that fails the event schema (the message names only the first failing field).
- `413 { error }`: the body is over 1 MiB (`MAX_INGEST_BODY_BYTES`) or the array has more than 100 events (`MAX_INGEST_BATCH`). An over-size body is read to its end and discarded before the 413, so a keep-alive connection stays usable; a body still going after 8 MiB gets the 413 with `Connection: close`.
- `415 { error }`: a request with an allowed `Origin` whose `Content-Type` is not `application/json`.
- `403 { error }` also answers a `Host` or `Origin` that is not loopback or the configured bind host (same guard as the stream), so a web page cannot post events. This check runs before the body is read.
- A batch is all-or-nothing: if any item is disallowed (403) or invalid (400), the whole batch is rejected and nothing is stored or broadcast.
- Binds to 127.0.0.1 like the rest of the bus; no authentication. Other methods answer 405.

### Latency check

The p99 latency test (1000 sequential posts after a warm-up, must stay under 50 ms) is opt-in because wall-clock assertions are flaky on shared CI:

```sh
DROMOS_PERF=1 pnpm vitest run src/ingest.perf.test.ts
```

## GET /events

`GET /events` queries stored events, oldest first. The reply is `200 { events, next }`; each event is a stored row exactly as in an event-stream frame (`id`, `role`, `kind`, `data`, `createdAt`, `agentId`, `issue`, `runId`).

```sh
curl 'http://127.0.0.1:4777/events?issue=135&type=progress,usage&limit=500'
# {"events":[{"id":7,"role":"apm-hub/hook","kind":"progress",...}],"next":null}
```

| Parameter | Meaning |
| --- | --- |
| `issue` | Issue number (non-negative integer). |
| `type` | Event `kind`; comma-separated list matches any. |
| `source` | Event `role`; comma-separated list matches any. |
| `kind` | Progress `data.kind` (`phase`, `task`, `wave`, `fix-round`, `ruling`, `gate`, `loop`, `complete`, `subagent`, `other`); comma-separated list matches any. Only `progress` events match, ones without `data.kind` never do; an unknown value is a 400. |
| `agentId` | Exact agent id. |
| `since` | ISO-8601 date-time, inclusive lower bound on `createdAt`. |
| `until` | ISO-8601 date-time, exclusive upper bound on `createdAt`. |
| `after` | Cursor: only events with `id` greater than this. |
| `limit` | Page size, 1 to 1000 (default 100). |

- Filters combine with AND. Order is always ascending `id`.
- Pagination: when more events match, `next` is the id of the last event in the page; pass it as `after` for the next page. `next` is `null` on the last page. Pages never repeat or skip an event.
- `since` and `until` need a `YYYY-MM-DDTHH:MM` prefix (a bare number or date is invalid) and are normalized to UTC; give an explicit `Z` or offset, since a value without one is read as server local time.
- `400 { error }` names the parameter: unknown or repeated parameters, a non-integer `issue`, `after` or `limit`, `limit` outside 1..1000, empty list entries, an unknown `kind` or empty `agentId`, an invalid `since` or `until`.
- `403 { error }` for a `Host` or `Origin` that is not loopback or the configured bind host. Binds to 127.0.0.1; no authentication. Methods other than `GET` and `POST` answer 405 (`POST /events` is unchanged).

## GET /runs/{issue}/metrics and GET /runs/metrics

`GET /runs/{issue}/metrics?since=&until=` returns the `RunMetrics` of one issue (event counts, durations, usage, per-agent counts). An issue without events answers `200` with empty metrics. `GET /runs/metrics?issues=1,2,3` or `?since=[&until=]` returns `{ runs, aggregate }`: one object per issue plus sums and means. With `since` and no `issues`, the issues are the distinct issues of events in the window.

- `since` is inclusive and `until` exclusive, both ISO-8601 as for `GET /events`. `issues` is a comma-separated list of non-negative integers, at most 100. The multi route needs `issues` or `since`.
- Missing usage is reported as `usd: null, measured: false`, never estimated.
- `400 { error }` names the unknown, repeated or invalid parameter; `403` for a foreign `Host` or `Origin`; `405` for methods other than `GET`.

Latency (opt-in, 10k events for one issue plus noise, p99 must stay under 50 ms):

```sh
DROMOS_PERF=1 pnpm vitest run src/events-query.perf.test.ts
```

## Attention API

An ingested `attention` event creates an attention row (same id as the event) in state `open`. A human moves it `open -> answered -> acked`; each step emits exactly one bus event.

- `GET /attention?state=open|answered|acked&issue=<int>&since=<ISO>&limit=<1..1000>` answers `200 { attention: [...] }`, oldest first; a bad or unknown parameter answers 400.
- `POST /attention/<id>/answer` with `{ "text": "...", "by": "..." }` (`text` 1-4000, `by` 1-128 chars) emits `attention.answered { id, text, by }` and answers 200 with the updated attention.
- `POST /attention/<id>/ack` with `{ "by": "..." }` or an empty body emits `attention.acked { id, by }`; only an answered attention can be acked.
- 404 for an unknown id, 409 when the state does not allow the step (a second answer, an ack before the answer or a second ack), 400 for an invalid body, 413 for a body over 1 MiB, 405 for other methods.
- Security: same guards as `POST /ingest` (loopback bind, `Host`/`Origin` check, `application/json` for browser requests); no authentication. `by` is self-asserted by the caller and is not verified: treat it as a label, not as an identity.

## Task message payload

A `post` with `type: "task"` must carry a typed payload; an invalid one is rejected with an error and nothing is stored. `inbox` returns task payloads typed. Extra keys (for example `worktreePath`, `branch`, `baseBranch`, `instructions`) are kept. All other message types accept any JSON payload.

| Field | Type | Meaning |
| --- | --- | --- |
| `objective` | string, non-empty | What the task must achieve |
| `constraints` | string[] | Rules the work must respect |
| `ownership` | string[], at least one | Paths or globs the receiver may change |
| `outputFormat` | string, non-empty | What the receiver must deliver |
| `editsAllowed` | boolean | Whether files may be edited |
| `validation` | string[] | Commands that must pass before the work counts as done |
| `forbidden` | string[] | Actions the receiver must not take |
| `issue` | positive integer | Issue number the task belongs to |
| `runId` | string, non-empty | Run the task belongs to |

```json
{
  "objective": "Implement #12: Add export",
  "constraints": ["Work only in the worktree"],
  "ownership": ["src/export/**"],
  "outputFormat": "Commits on feat/12-export",
  "editsAllowed": true,
  "validation": ["pnpm test"],
  "forbidden": ["push to the base branch"],
  "issue": 12,
  "runId": "run-12-1"
}
```

## Repository layout

- `src/`: TypeScript MCP bus
- `crates/dromos-mux`: terminal multiplexer (daemon and client binary), parked
- `crates/dromos-mux-proto`: event and IPC types generated from the Zod schema (used by the parked dromos-mux)
- `.github/workflows/`: GitHub Actions workflows

## Event schema

The Zod `BusEvent` union in `src/events/schema.ts` is the single source of truth. Two artifacts are generated from it and checked in: `schema/events.schema.json` and `crates/dromos-mux-proto/src/generated.rs` (never edit either by hand).

To add an event type:

1. Add the variant to the Zod union in `src/events/schema.ts`.
2. `pnpm run schema` to regenerate `schema/events.schema.json`.
3. `cargo run -p dromos-schema-gen` to regenerate `generated.rs`.
4. Add one fixture per type in `schema/fixtures/` (it must parse in TypeScript and round-trip in Rust).
5. Add the type string to `KNOWN_TYPES` in `crates/dromos-mux-proto/src/event.rs`; unknown `type` values map to `Event::Unknown`. A test checks the list against the fixtures.

CI (`.github/workflows/schema.yml`) reruns both generators and fails on `git diff --exit-code`, then runs the TypeScript fixture tests. This overlaps on purpose with the generator unit test run by `cargo test`, which also fails when `generated.rs` is stale; the CI step additionally catches a stale `events.schema.json`.

## CLI install

Build and link the CLI globally, then start the bus:

```bash
pnpm build && pnpm link --global
dromos serve
```

`dromos serve` runs in the foreground and answers `GET /health` on the configured port. An occupied port prints one error line and exits 1. Bare `dromos` prints help.

## Usage (`dromos log` is planned)

Start the bus and follow its log:

```bash
dromos serve
dromos log
dromos run export <issue> --format json|mermaid [--out FILE]
dromos events --issue 135 --type progress,agent.state --limit 50 --table
```

`dromos events` queries `GET /events` with the same filters (`--issue`, `--type`, `--source`, `--kind`, `--agent-id`, `--since`, `--until`, `--after`, `--limit`) and prints JSON (`{events,next}`, default when stdout is not a TTY, or `--json`) or a table of id, createdAt, issue, source, type and agentId (`--table`, default on a TTY). `--all` follows `next` until every matching event is printed. The bus URL comes from `--url`, else `$DROMOS_URL`, else the configured host and port. A rejected query prints the server error and exits 2; an unreachable bus prints a hint and exits 1.

`dromos run export` reads one issue's events from the local store and prints a JSON export (schema version, issue, `exportedAt`, events) or a Mermaid flowchart of its subagent tree, without network access. An unknown issue prints nothing and exits 1.

```
dromos run pbi <nr> [--harness claude|claude-cli|copilot] [--repo PATH] [--format text|json] [--dry-run] [--force]
```

`dromos run pbi` claims the PBI, implements it in a worktree, reviews it (one fix round) and opens the pull request. The first line and first event is the run header (harness, versions, models per role). `--format json` streams events as JSON lines; text output is for a TTY only, so off a TTY the output is JSON lines whatever `--format` says. `--dry-run` prints the steps without starting a harness or writing to GitHub. `--force` takes over a PBI that already carries `in-progress`. Exit codes: 0 pull request opened (or dry run), 1 blocked, 2 usage error, 3 error.

```
dromos run plan <nr> [--harness claude|claude-cli|copilot] [--repo PATH] [--format text|json] [--answer <id>=<value>]... [--assume-recommended]
```

`dromos run plan` plans a `[Feature]` into PBIs or a `[PBI]` into Tasks with the planner phase and writes the plan to `.dromos/state/<nr>/plan.json` in the repository. On a TTY every planner question is a select prompt (Enter takes the recommendation). `--answer <id>=<value>` (repeatable, the value must be one of the options) answers without a prompt; `--assume-recommended` takes every remaining recommendation and writes it into the plan and into each created issue under `## Assumptions`. `phase.finished` of the planner carries `unansweredQuestions`. Without a TTY and without `--assume-recommended`, open questions create no issue: the draft plan and every open question (options and recommendation) go into one comment on the issue, the issue gets the label `needs-decision`, an `attention` event is emitted and the run exits 2. Answer with comment lines `/answer <id> <value>`; the next run reads them, removes `needs-decision` and continues. Exit codes: 0 issues created, 2 questions open (or usage error), 3 error.

The herdr plugin (Epic #98) is the workspace for interactive work; apm-hub orchestrator runs report to the bus through `$DROMOS_URL`.

Config: `dromos.config.json` in the working directory (or the file named by `DROMOS_CONFIG`), merged over defaults. See `dromos.config.example.json` for host, port, `maxRounds`, gate commands, base branch, `branchPrefix` (default `conventional`: `<type>/<issue>-<slug>`), `worktreeDir` (relative path, no `..`, default `.worktrees`).

## Workflow

`dromos run pbi <nr>` drives the workflow: it creates the worktree and branch `<type>/<issue>-<slug>` (`fix` for issues labelled `bug` or titled `fix...`/`[bug]...`, otherwise `feat`; set `branchPrefix` to a fixed string such as `agent` to get `agent/<issue>-<slug>`), runs the implementer and reviewer steps through a harness, runs the gate commands, stops as `blocked` after the round limit (default 3) and opens the pull request once the review approves. The worktree lives at `<repoPath>/<worktreeDir>/<issue>` (default `.worktrees/<issue>`). The bus never merges.

## Roadmap

[ROADMAP.md](ROADMAP.md) lists the stages and their dependencies: bus core (Epic #166: events, harness adapters and runner, CLI, validation), history and attention for unattended apm-hub loops (Epic #132), the herdr plugin (Epic #98), self-learning (Epic #159). dromos-mux (Epics #36, #56) is parked at the end.

## Tech

TypeScript 7 (strict, ESM), pnpm, Vitest, Biome (lint and format), `@modelcontextprotocol/sdk` (streamable HTTP), Zod, better-sqlite3. commander (CLI), execa. Planned: `gh` CLI. Requires Node >= 22.

Rust (edition 2024, Cargo workspace under `crates/`, toolchain pinned in `rust-toolchain.toml`) for the parked `dromos-mux`.

## Development

```bash
pnpm install
pnpm build       # tsc
pnpm test        # vitest run
pnpm lint        # biome check .
pnpm typecheck   # tsc --noEmit
pnpm dev         # tsx watch src/index.ts

cargo build --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
