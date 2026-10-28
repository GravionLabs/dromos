# 004 — Archive dromos, split into Claude workflows and keryx

Status: Accepted (2026-10-28)

## Context

Decision #131 (2026-10-27) made dromos own the control flow: a runner that calls one headless
harness session per step. In practice the runner rebuilt harness features: a permission engine
(`src/runner/permissions.ts`), format and setup steps, a progress display, question handling and
usage metrics. Headless sessions lose the user's settings, the status line and the ability to ask.

## Decision

- dromos is frozen at v0.4.0 and archived without renaming, so every link stays valid.
- Deterministic delivery (implement, gate, review, fix, PR, merge) is a Claude Code workflow
  started by the `deliver` skill in apm-hub (apm-hub#821). Every step is a subagent with a fresh
  context.
- Planning, refinement and task breakdown are interactive skills (`grill-me`, `issue-planning`).
- The bus, the Attention API, gate tools for model-driven harnesses (OpenCode) and the herdr
  plugin continue in the new repository [keryx](https://github.com/GravionLabs/keryx).
- OpenCode replaces Copilot CLI as the second harness.

## Rationale

The harness already has permissions, hooks, a progress UI, questions and usage data, and a Claude
Code workflow script runs loops and gates deterministically. Keeping only what no harness offers
(cross-session events, attention, gates for model-driven harnesses) removes most of the code.

## Consequences

- No own runner, permission engine or metrics; usage comes from the harness transcripts
  ([agentlens](https://github.com/GravionLabs/agentlens)).
- Copilot CLI is not supported; Copilot models are reachable through OpenCode's provider.
- Reviving the runner means unarchiving dromos, not a rewrite.
