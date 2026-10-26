# dromos

Local event bus for coding agents. dromos collects the events of unattended [apm-hub](https://github.com/GravionLabs/apm-hub) orchestrator loops and of the herdr plugin, keeps their history and run metrics, tracks attention (questions and gates that wait for a human) and runs sessions. Formerly `agent-bus`; the old `agent-bus.config.json` still loads with a deprecation warning for one release.

What it offers:

- **Events**: a typed event stream (`GET /events/stream`) and `POST /ingest` for producers such as apm-hub hooks. The bus works without any terminal.
- **History and metrics**: stored events with query and per-run metrics for apm-hub's retro (planned).
- **Attention**: gates and questions with an id and state that a human answers (planned).
- **Sessions**: a driver asks the bus to run a session headless and restart it with a fresh start prompt (planned).
- **MCP tools** as the bus API: `start_run`, `submit_implementation`, `submit_review`, `open_pr`, `status`, `post`, `ack`, `inbox`. The deterministic gate (build, tests, lint, round limit, "PR only after approval") is enforced by the bus itself.

dromos does not provide its own interactive role workflow (orchestrator, implementer and reviewer terminals started by dromos): that was dropped, apm-hub's orchestrator and agents cover it. The workspace is the herdr plugin (`dromos-herdr`, primary). The Rust multiplexer `dromos-mux` is parked: the code stays in the repository but is not on the roadmap.

```
 apm-hub loops (hooks, POST /ingest) ─┐
 herdr plugin (events, attention)    ─┼──► dromos ──► SQLite history, metrics, sessions, gate, gh
 MCP clients (start_run, submit_*)   ─┘
```

## Status

Early development. Implemented: project foundation and messaging (`post`, `ack`, `inbox`, `/events`, `/events/stream`, bus log) over streamable HTTP at `/mcp/<role>`, `POST /ingest`, agent instances and the workflow core. Everything else below is **planned**, including the `dromos` CLI (`package.json` has no `bin` yet). Order of work: [ROADMAP.md](ROADMAP.md); the bus core is Epic #166.

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
| `agentId` | Exact agent id. |
| `since` | ISO-8601 date-time, inclusive lower bound on `createdAt`. |
| `until` | ISO-8601 date-time, exclusive upper bound on `createdAt`. |
| `after` | Cursor: only events with `id` greater than this. |
| `limit` | Page size, 1 to 1000 (default 100). |

- Filters combine with AND. Order is always ascending `id`.
- Pagination: when more events match, `next` is the id of the last event in the page; pass it as `after` for the next page. `next` is `null` on the last page. Pages never repeat or skip an event.
- `since` and `until` need a `YYYY-MM-DDTHH:MM` prefix (a bare number or date is invalid) and are normalized to UTC; give an explicit `Z` or offset, since a value without one is read as server local time.
- `400 { error }` names the parameter: unknown or repeated parameters, a non-integer `issue`, `after` or `limit`, `limit` outside 1..1000, empty list entries or empty `agentId`, an invalid `since` or `until`.
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

A `post` with `type: "task"` must carry a typed payload; an invalid one is rejected with an error and nothing is stored. `inbox` returns task payloads typed. Extra keys (for example `worktreePath`, `branch`, `baseBranch`, `instructions` from `start_run`) are kept. All other message types accept any JSON payload.

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
  "outputFormat": "Commits on feat/12-export, then submit_implementation",
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

## Usage (planned)

Start the bus and follow its log:

```bash
dromos serve
dromos log
dromos run export <issue> --format json|mermaid [--out FILE]
```

`dromos run export` reads one issue's events from the local store and prints a JSON export (schema version, issue, `exportedAt`, events) or a Mermaid flowchart of its subagent tree, without network access. An unknown issue prints nothing and exits 1.

The herdr plugin (Epic #98) is the workspace for interactive work; apm-hub orchestrator runs report to the bus through `$DROMOS_URL`.

Config: `dromos.config.json` in the working directory (or the file named by `DROMOS_CONFIG`), merged over defaults. See `dromos.config.example.json` for host, port, `maxRounds`, gate commands, base branch, `branchPrefix` (default `conventional`, see `start_run`), `worktreeDir` (relative path, no `..`, default `.worktrees`).

## Workflow

The MCP tools stay as bus API.

1. `start_run(issue)`: create worktree and branch `<type>/<issue>-<slug>` (`fix` for issues labelled `bug` or titled `fix...`/`[bug]...`, otherwise `feat`; e.g. `feat/14-add-start-run`). Set `branchPrefix` to a fixed string such as `agent` to get `agent/<issue>-<slug>` instead. Post the task to the implementer role. The worktree lives at `<repoPath>/<worktreeDir>/<issue>` (default `.worktrees/<issue>`); `start_run` refuses unless `<worktreeDir>/` is git-ignored in that repository.
2. `submit_implementation`: the bus runs build, tests and lint. Red goes back to the implementer.
3. `submit_review`: schema-validated verdict. Blocking findings go back to the implementer.
4. After the round limit (default 3) the run is `blocked` and the orchestrator is notified.
5. `open_pr`: allowed only once the run is `approved`. The bus never merges.

A `status` tool reports the state of a run.

## Roadmap

[ROADMAP.md](ROADMAP.md) lists the stages and their dependencies: bus core (Epic #166: events, Session API, CLI, validation), history and attention for unattended apm-hub loops (Epic #132), the herdr plugin (Epic #98), self-learning (Epic #159). dromos-mux (Epics #36, #56) is parked at the end.

## Tech

TypeScript 7 (strict, ESM), pnpm, Vitest, Biome (lint and format), `@modelcontextprotocol/sdk` (streamable HTTP), Zod, better-sqlite3. Planned: execa, commander, `gh` CLI. Requires Node >= 22.

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
