# agent-bus

Local MCP message bus that coordinates **interactive** AI coding agents — Claude Code and GitHub Copilot CLI — each running in its own terminal:

- **orchestrator** – starts runs, routes work, never edits code
- **implementer** – implements a GitHub issue in an isolated git worktree
- **reviewer** – read-only quality gate that reviews the diff and returns a structured verdict

Agents talk to each other through MCP tool calls (not terminal screen-scraping). Hooks report when an agent goes idle. The deterministic gate (build, tests, lint, round limit, "PR only after approval") is enforced by the bus itself, so no agent can skip it.

The bus does not care which terminal you use: normal windows, tabs, tmux, VS Code terminals or SSH all work. WezTerm split panes are an **optional** layout.

```
 terminal 1: orchestrator ─┐
 terminal 2: implementer  ─┼── MCP (HTTP, 127.0.0.1) ──► agent-bus ──► git worktree, gate, gh
 terminal 3: reviewer     ─┘                              ▲
 terminal 4: agent-bus log         Claude Stop hooks ─────┘ (idle/busy events)
```

## Usage (planned)

Start each role in any terminal. The bus starts automatically if it is not running:

```bash
agent-bus role orchestrator
agent-bus role implementer --cli claude
agent-bus role reviewer --cli copilot --model GPT-Luna
agent-bus log
```

Or open all four at once with a layout:

```bash
agent-bus up                     # separate windows in your default terminal
agent-bus up --layout wezterm    # optional: one WezTerm window, 4 split panes
agent-bus up --layout print      # just print the commands (tmux, VS Code, SSH, …)
agent-bus up --reviewer-cli copilot --reviewer-model GPT-Luna
```

`--cli` and `--model` can be set per role. The precedence is: flag > `roles.<role>` in `agent-bus.config.json` > the CLI's own default. Model names are passed verbatim to `claude --model` / `copilot --model`; agent-bus keeps no list of models and does not validate them.

## Workflow

1. `start_run(issue)` – create worktree + branch, post the task to the implementer.
2. `submit_implementation` – the bus runs build/test/lint. Red → back to the implementer.
3. `submit_review` – schema-validated verdict. Blocking findings → back to the implementer.
4. After the round limit (default 3) the run is `blocked` and the orchestrator is notified.
5. `open_pr` – allowed only once the run is `approved`. The bus never merges.

## Status

Planning. See the issues (Epic #1 → Features → PBIs) for the implementation backlog.

## Tech

TypeScript 7 (strict, ESM), pnpm, Vitest, Biome (lint + format), `@modelcontextprotocol/sdk` (streamable HTTP), Zod, better-sqlite3, execa, commander, gh CLI. Optional: WezTerm CLI.
