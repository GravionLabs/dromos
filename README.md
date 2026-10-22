# dromos

Local MCP message bus that coordinates **interactive** AI coding agents (Claude Code and GitHub Copilot CLI), each running in its own terminal. Formerly `agent-bus`; the repository is renamed, the code rename is tracked in #70 (the package, config file and some internals still say `agent-bus`).

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

Early development. Implemented: project foundation and messaging (`post`, `ack`, `inbox`, `/events`, bus log) over streamable HTTP at `/mcp/<role>`. Everything else below is **planned**, including the `dromos` CLI (`package.json` has no `bin` yet). Order of work: [ROADMAP.md](ROADMAP.md).

## Repository layout

- `src/`: TypeScript MCP bus
- `crates/dromos-mux`: terminal multiplexer (daemon and client binary)
- `crates/dromos-mux-proto`: event and IPC types shared by daemon and client
- `.github/workflows/`: GitHub Actions workflows

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

Config: `agent-bus.config.json` in the working directory (name kept until the rename in #70), merged over defaults. See `agent-bus.config.example.json` for host, port, `maxRounds`, gate commands, base branch, `roles` and `layouts`.

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
