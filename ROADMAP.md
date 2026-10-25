# Roadmap — Dromos (formerly agent-bus)

Order of work for the open issues of `dromos` (repository renamed from `agent-bus` on 2026-10-18, code rename: see #70). Dependencies come from the `Blocked by` lines of the issues. The PBIs of Epic #1 (stages 1, 3, 6) have no such lines; their dependencies here are inferred from the titles and marked with `~`. apm-hub side: `GravionLabs/apm-hub` `ROADMAP.md` (releases 2.6.0, 2.7.0, Feature #398).

## Done

Feature #2 (project foundation) and Feature #7 (messaging: `post`, `ack`, `inbox`, `/events`, bus log).

## Stage 1 — workflow core (Epic #1, Feature #12)

| Order | Issue | Title | Depends on |
| --- | --- | --- | --- |
| 1 | #13 | run state machine (pure module) | — |
| 2 | #14 | `start_run`: fetch issue, create worktree under `<repo>/.worktrees/<issue>` (config `worktreeDir`, must be git-ignored) | ~#13 |
| 3 | #15 | deterministic gate runner | ~#13 |
| 4 | #16 | `submit_implementation` with background gate | ~#14, #15 |
| 5 | #17 | `submit_review` with verdict routing | ~#16 |
| 6 | #18 | `open_pr` (approved runs only) | ~#17 |
| 7 | #19 | `status` tool | ~#13 |

## Stage 2 — events and instances (Epic #36, Features #37 and #40)

Can start in parallel to stage 1; #44 needs #12.

| Order | Issue | Title | Depends on |
| --- | --- | --- | --- |
| 1 | #39 | event JSON Schema from Zod, Rust types, drift check | — |
| 1 | #38 | Cargo workspace with CI | — |
| 2 | #41 | agent instances instead of the role enum | #39 |
| 2 | #42 | `GET /events/stream` (SSE, resume) | #39 |
| 3 | #43 | `POST /ingest` | #42 |
| 4 | #44 | emit run, gate, review, attention events | #12, #42 |

Unblocks apm-hub 2.6.0 (#389) at #43.

## Stage 2b — history and attention for unattended apm-hub loops (Epic #132, Features #133 and #134; milestone 0.2.0)

apm-hub makes its orchestrator loops run without a human by default (GravionLabs/apm-hub#573). The bus contributes the cross-harness run history that apm-hub's retro reads and the answer channel for parked gates. The apm-hub ledger stays its source of truth; the bus holds a projection (decision candidate in #131).

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | #136 | `progress` events: optional `data.kind` and `data.fields` | S | #97 |
| 2 | #135 | `GET /events` query API: filters, time window, pagination | M | #43 |
| 3 | #138 | `attention` with id and state, `POST /attention/{id}/answer` → `attention.answered` | M | #43, #97 |
| 4 | #137 | `dromos run metrics` and `GET /runs/{issue}/metrics` | M | #135, #136, apm-hub#393 |

Unblocks apm-hub 2.8.0 (#591, #592) at #135–#137; #138 is what #103 (herdr) and #53 (dromos-mux) answer attentions through, and it settles the headless `input` question of #65 for gate answers (restart with a fresh prompt instead).

## Stage 3 — roles, CLI, idle hooks (Epic #1, Features #20 and #26)

| Issue | Title | Depends on |
| --- | --- | --- |
| #32 | CLI `serve` and `role` | — |
| #21 #22 #23 | orchestrator, implementer, reviewer agent definitions | ~#32 |
| #24 | install script and per-role MCP configs | ~#21–#23 |
| #25 | idle hooks | ~#24 |
| #28 #33 | `dromos log`, `dromos up` (print) | ~#32 |

## Stage 4 — Session API (Feature #61)

Workflow-independent executor: a driver asks the bus to run a session and restart it with a fresh start prompt. Unattended overnight runs of an apm-hub Epic build on it (apm-hub #398).

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | #62 | `session.*` event types in the schema | S | #39 |
| 2 | #63 | `sessions` table and session manager | M | #41 |
| 3 | #64 | headless executor | M | #62, #63 |
| 4 | #65 | HTTP endpoints, restart, input | M | #64, #42 |
| 5 | #66 | idle detection feeds `session.idle` | S | #25, #41, #63 |
| 6 | #67 | pane executor, bus side (request/claim via events) | M | #65, #43 |
| 7 | #68 | dromos-mux handles session requests | M | #46, #51, #67 |
| 8 | #69 | docs and driver conformance test | S | #65, #67, #68 |

Headless mode (#62–#65) works without dromos-mux and is enough for overnight runs; #66–#68 add the pane mode.

## Stage 5 — dromos-mux MVP (Epic #36, Features #45 and #50)

| Order | Issue | Title | Depends on |
| --- | --- | --- | --- |
| 1 | #46 | daemon with PTY sessions, detach/attach | #38 |
| 2 | #47 | client: tabs, splits, keybindings | #46 |
| 3 | #49 | standalone mode without a bus | #47 |
| 4 | #48 | `dromos-mux up <issue>` | #47, #41, #32 |
| 5 | #51 | SSE client, event-to-pane mapping | #42, #46 |
| 6 | #52 | sidebar | #51, #47 |
| 7 | #53 #54 | attention, click navigation | #52 |
| 8 | #55 | MVP end-to-end validation on Linux | #48, #49, #53, #54, #44 |

Gate 1: dromos-mux used daily for two weeks.

## Stage 6 — validation (Epic #1, Feature #29)

#30 integration test with mocked `gh`, #31 manual end-to-end checklist. Both after stage 1 (inferred).

## After the MVP (Epic #56)

Phase 1 #57 (Windows, macOS, SSH attach), phase 2 #58 (queue view, usage; needs apm-hub #392 and #393), phase 3 #59 (comfort). Each starts after the gate before it. PBIs are planned per phase.

## Risks

- #39 decides the event shape for everything after it; session events (#62) extend it, so plan them together.
- The pane mode relies on dromos-mux claiming `session.requested`; without it the request fails after the claim timeout instead of hanging.
- Headless `input` (stdin) is unverified for both CLIs; headless gate answers wait for that decision (#65).
