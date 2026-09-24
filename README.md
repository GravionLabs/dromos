# agent-bus

Local MCP message bus that coordinates **interactive** AI coding agents — Claude Code and GitHub Copilot CLI — running side by side in WezTerm panes:

- **orchestrator** – starts runs, routes work, never edits code
- **implementer** – implements a GitHub issue in an isolated git worktree
- **reviewer** – read-only quality gate that reviews the diff and returns a structured verdict

Agents talk to each other through MCP tool calls (not terminal screen-scraping). Hooks report when an agent goes idle. The deterministic gate (build, tests, lint, round limit, "PR only after approval") is enforced by the bus itself, so no agent can skip it.

```
┌─────────── WezTerm tab "agents #123" ───────────┐
│ orchestrator (claude, interactive) │ implementer │
│                                    │ (claude)    │
├────────────────────────────────────┼─────────────┤
│ bus log / status (tail)            │ reviewer    │
│                                    │ (copilot)   │
└────────────────────────────────────┴─────────────┘
        all three ──MCP (HTTP, localhost)──► agent-bus
        Stop hooks ──────────────────────────► agent-bus /events
```

## Workflow

1. `start_run(issue)` – create worktree + branch, post the task to the implementer.
2. `submit_implementation` – the bus runs build/test/lint. Red → back to the implementer.
3. `submit_review` – schema-validated verdict. Blocking findings → back to the implementer.
4. After the round limit (default 3) the run is `blocked` and the orchestrator is notified.
5. `open_pr` – allowed only once the run is `approved`. The bus never merges.

## Status

Planning. See the issues (Epic → Feature → PBI) for the implementation backlog.

## Tech

TypeScript (strict, ESM), pnpm, Vitest, `@modelcontextprotocol/sdk` (streamable HTTP), Zod, better-sqlite3, execa, gh CLI, WezTerm CLI.
