# dromos

Local MCP message bus that coordinates **interactive** AI coding agents (Claude Code and GitHub Copilot CLI), each running in its own terminal. Formerly `agent-bus`; the old `agent-bus.config.json` still loads with a deprecation warning for one release.

Three roles:

- **orchestrator**: starts runs, routes work, never edits code
- **implementer**: implements a GitHub issue in an isolated git worktree
- **reviewer**: read-only quality gate that reviews the diff and returns a structured verdict

Agents talk to each other through MCP tool calls, not terminal screen-scraping. Hooks report when an agent goes idle or busy. The deterministic gate (build, tests, lint, round limit, "PR only after approval") is enforced by the bus itself, so no agent can skip it.

The bus is terminal-agnostic: plain windows, tabs, tmux, VS Code terminals and SSH all work. A WezTerm split-pane layout is optional.

```
 terminal 1: orchestrator ─┐
 terminal 2: implementer  ─┼── MCP (HTTP, 127.0.0.1) ──► dromos ──► git worktree, gate, gh
 terminal 3: reviewer     ─┘                              ▲
 terminal 4: dromos log            Claude Stop hooks ─────┘ (idle/busy events)
```

## Status

Early development. Implemented: project foundation and messaging (`post`, `ack`, `inbox`, `/events`, `/events/stream`, bus log) over streamable HTTP at `/mcp/<role>`. Everything else below is **planned**, including the `dromos` CLI (`package.json` has no `bin` yet). Order of work: [ROADMAP.md](ROADMAP.md).

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

## Repository layout

- `src/`: TypeScript MCP bus
- `crates/dromos-mux`: terminal multiplexer (daemon and client binary)
- `crates/dromos-mux-proto`: event and IPC types shared by daemon and client
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

Start each role in any terminal. The bus starts automatically if it is not running:

```bash
dromos role orchestrator
dromos role implementer --cli claude
dromos role reviewer --cli copilot --model GPT-Luna
dromos log
```

Or open all four at once with a layout:

```bash
dromos up                     # separate windows in your default terminal
dromos up --layout wezterm    # optional: one WezTerm window, 4 split panes
dromos up --layout print      # just print the commands (tmux, VS Code, SSH, ...)
dromos up --reviewer-cli copilot --reviewer-model GPT-Luna
```

`--cli` and `--model` can be set per role. Precedence: flag > `roles.<role>` in the config file > the CLI's own default. Model names are passed verbatim to `claude --model` / `copilot --model`; there is no model list and no validation.

Config: `dromos.config.json` in the working directory (or the file named by `DROMOS_CONFIG`), merged over defaults. See `dromos.config.example.json` for host, port, `maxRounds`, gate commands, base branch, `roles` and `layouts`.

## Workflow (planned)

1. `start_run(issue)`: create worktree and branch, post the task to the implementer.
2. `submit_implementation`: the bus runs build, tests and lint. Red goes back to the implementer.
3. `submit_review`: schema-validated verdict. Blocking findings go back to the implementer.
4. After the round limit (default 3) the run is `blocked` and the orchestrator is notified.
5. `open_pr`: allowed only once the run is `approved`. The bus never merges.

A `status` tool reports the state of a run.

## Roadmap

[ROADMAP.md](ROADMAP.md) lists the stages, their dependencies and the planned Session API (a driver asks the bus to run a session and restart it with a fresh start prompt, for unattended runs). Stages cover the workflow core, events and agent instances, roles/CLI/idle hooks, the Session API, the `dromos-mux` terminal multiplexer MVP and end-to-end validation.

## Tech

TypeScript 7 (strict, ESM), pnpm, Vitest, Biome (lint and format), `@modelcontextprotocol/sdk` (streamable HTTP), Zod, better-sqlite3. Planned: execa, commander, `gh` CLI, optional WezTerm CLI. Requires Node >= 22.

Rust (edition 2024, Cargo workspace under `crates/`, toolchain pinned in `rust-toolchain.toml`) for `dromos-mux`.

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
