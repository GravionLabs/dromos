# Roadmap — Dromos (formerly agent-bus)

Order of work for the open issues of `dromos` (repository renamed from `agent-bus` on 2026-10-18, code rename: see #70). Last release `v0.1.0` (2026-10-25); each later stage names its milestone. Dependencies come from the native blocked-by links of the issues. Some bus-core PBIs (Stage 3, 6) have no such lines; their dependencies here are inferred from the titles and marked with `~`.

Re-scope of 2026-10-26: the bus core is Epic #166 (Features #26, #29, #40, #61 and PBI #131), terminal-agnostic and independent of the herdr plugin and of dromos-mux. The own interactive role mode is dropped (apm-hub orchestrator and agents replace it; the MCP tools stay as bus API), the herdr plugin (Epic #98) is the primary workspace, and dromos-mux (Epics #36, #56) is parked, see the last sections. apm-hub side: `GravionLabs/apm-hub` `ROADMAP.md` (releases 2.6.0, 2.7.0, Feature #398).

## Unattended path — what apm-hub's self-learning workflow needs from dromos

apm-hub's Epic #573 (`GravionLabs/apm-hub` `ROADMAP.md`, "Unattended path") runs Features and Epics without a human and feeds a retro loop. Its steps 0–4 (releases 2.5.0–2.7.0) need nothing from dromos; the ledger stays the source of truth and the bus holds a projection. dromos is needed from step 4 on:

| apm-hub step | Needs from dromos | Issue | Milestone | Status |
| --- | --- | --- | --- | --- |
| 4 (#389, released in apm-hub 2.4.0) | `POST /ingest` for the `SubagentStop` hook | #43 | 0.1.0 | released |
| 4 (#391, 2.7.0) | `attention` with id and state, answer endpoint | #138 (Feature #134) | 0.2.0 | open |
| 5 (#591, 2.8.0) | `progress` events with `data.kind` and `data.fields` | #136 | 0.2.0 | open |
| 5 (#592, 2.8.0) | `GET /events` query API | #135 | 0.2.0 | open |
| 5 (#592, 2.8.0) | `dromos run metrics`, `GET /runs/{issue}/metrics` | #137 (also needs apm-hub#393) | 0.2.0 | open |
| 6 (#398) | `dromos run` runner with harness adapters (replaces the headless session executor #62–#65) | work plan B2–B17 | 0.2.0–0.4.0 | open |
| any | merged Task issues are closed automatically | #150 | none | open, to be scheduled |

Order inside dromos: #136 → #135 → #138 → #137 (Stage 2b), then Stage 4 (harness adapters and runner). Gate answers by `attention` (#138) and by the apm-hub `/ruling` comment (#581) are independent; the comment path works without dromos.

## Done

Feature #2 (project foundation) and Feature #7 (messaging: `post`, `ack`, `inbox`, `/events`, bus log).

`v0.1.0` (2026-10-25): Feature #12 workflow core (#13–#19), Feature #37 Rust workspace and event schema (#38, #39), agent instances #41, SSE stream #42, `POST /ingest` #43, rename #71, worktree #80, Node CI #90, release conventions #108, apm-hub compatible lease #126 and branch names #127. apm-hub consumes `/ingest` since its 2.4.0 (#389).

## Stage 2 — events and instances (Feature #40; milestone 0.2.0)

#38, #39, #41, #42 and #43 shipped in `v0.1.0`. Left: #44 emit run, gate, review and attention events from the workflow (blocked by #12, closes with it, and #42). Feature #40 closes with #44.

## Stage 2b — history and attention for unattended apm-hub loops (Epic #132, Features #133 and #134; milestone 0.2.0)

apm-hub makes its orchestrator loops run without a human by default (GravionLabs/apm-hub#573). The bus contributes the cross-harness run history that apm-hub's retro reads and the answer channel for parked gates. The apm-hub ledger stays its source of truth; the bus holds a projection (decision candidate in #131).

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | #136 | `progress` events: optional `data.kind` and `data.fields` | S | #97 |
| 2 | #135 | `GET /events` query API: filters, time window, pagination | M | #43 |
| 3 | #138 | `attention` with id and state, `POST /attention/{id}/answer` → `attention.answered` | M | #43, #97 |
| 4 | #137 | `dromos run metrics` and `GET /runs/{issue}/metrics` | M | #135, #136, apm-hub#393 |

Unblocks apm-hub 2.8.0 (#591, #592) at #135–#137; #138 is what #103 (herdr) answers attentions through, and it settles the headless `input` question of #65 for gate answers (restart with a fresh prompt instead).

## Stage 3 — bus core: CLI, task payload, decisions (Epic #166, Features #26, #40; milestone 0.2.0)

| Issue | Title | Depends on |
| --- | --- | --- |
| #130 | typed `task` message payload (Feature #40) | — |
| #131 | decision records and out-of-scope list (direct child of #166) | — |
| #113 | `dromos run export <issue> --format json|mermaid` (Feature #40) | #112, #43 (both done) |
| #32 | CLI `serve` (the `role` subcommand is dropped) | — |
| #28 | `dromos log` | ~#32 |

Pull-model tools removed (B16): the MCP tools `start_run`, `submit_implementation`, `submit_review`, `open_pr` and `status` and the old state machine are gone. The bus-side lease (`http-lease`, `run-lease`, `lease`) is gone too (B17); worktree ownership is the runner's claim, and `src/state-dir.ts` keeps only `resolveStateDir`. `post`, `ack` and `inbox` stay: `src/server.ts` registers them.

0.2.0 closes with Stage 2b, this stage and #30, #31 (Feature #29, validation, see Stage 6). #131 records the re-scope decisions: role mode closed, dromos-mux parked, herdr primary, bus core epic, self-learning #159, and the decision of 2026-10-27 that dromos owns the control flow and apm-hub is content (Stage 4).

## Stage 3b — herdr plugin (Epic #98, Feature #99; milestone 0.3.0)

The primary workspace for dromos runs; dromos-mux is parked. apm-hub's parked gates (#391 → `attention`) are answered from here through #138.

| Order | Issue | Title | Depends on |
| --- | --- | --- | --- |
| 1 | #100 | plugin skeleton: manifest, startup daemon, bus and socket clients | #42 (done) |
| 2 | #101 | `dromos up <issue> --herdr`: role panes with bus identity (owns the command builder; #33 closed) | #100, #41 (done) |
| 3 | #104 | reverse channel: herdr agent status into the bus as `agent.state` | #101, #43 (done) |
| 3 | #102 | state bridge: bus events set herdr agent state and sidebar tokens | #101, #44, #43 (done) |
| 4 | #103 | attention: notification, highlight, jump key | #102 |
| 4 | #105 | run view: runs, queue items, usage | #102 |
| 5 | #114 | run view: subagent tree from `agent.run` events | #105, #112 (done) |
| 6 | #107 | docs: herdr plugin as the primary workspace, dromos-mux parked | #103 |
| 7 | #165 | herdr end-to-end validation on Linux | #44, #101, #102, #103, #105 |

Feature #99 closes with #106 (pane executor via herdr, milestone 0.4.0; re-scoped with the runner, see Stage 4) and #165.

## Stage 4 — harness adapters and runner (Feature #61 in Epic #166; milestones 0.2.0 to 0.4.0)

Decision of 2026-10-27 (dromos#131, [simplification plan](https://github.com/GravionLabs/apm-hub/blob/release/next/docs/simplification-plan.md)): dromos owns the control flow, apm-hub is content (skills and prompts). The runner is a program: `dromos run epic|feature|pbi <nr>` reads the issue hierarchy, plans where something is missing, selects the next approved and unblocked PBI, and calls one flat harness session per step (Claude, Copilot) through one adapter interface. GitHub stays the source of truth for issue state; the bus keeps events and metrics. Order and sizes: [simplification work plan](https://github.com/GravionLabs/apm-hub/blob/release/next/docs/simplification-workplan.md) (dromos items B1 to B21; milestones 0.2.0 B1-B6b, 0.3.0 B7-B17, 0.4.0 B18-B21).

This replaces the earlier Session API (`session.*` events, `sessions` table, headless executor, HTTP endpoints with restart and input: #62-#65, #69, #106), which was a workflow-independent executor driven from outside. Pane mode stays with the herdr plugin (#106 is re-scoped to the pane harness, see Stage 3b); idle detection (#66) stays parked with dromos-mux.

## Stage 6 — validation (Epic #166, Feature #29; milestone 0.2.0)

#30 integration test with mocked `gh`, #31 headless/bus end-to-end checklist (no panes or role steps). Both can start; they close 0.2.0. The herdr workspace is validated separately by #165 (Stage 3b).

## Stage 7 — self-learning (Epic #159)

Kept by the decision of 2026-10-27; the runner (Stage 4) emits the events it learns from.

dromos supplies what a single repo's retro cannot: structured outcome data, cross-repo queries, approval of retro candidates through `attention`, and export of approved lessons. The analysis itself stays in apm-hub's retro (GravionLabs/apm-hub#576, #577); the repo-local lessons contract is GravionLabs/apm-hub#661. apm-hub works without dromos. Blocked by Epic #132 (Stage 2b); not yet planned into PBIs or milestones.

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | #160 | outcome events: review verdicts, finding fingerprints, gate failure signatures, rulings | – | #44, #136 |
| 2 | #161 | cross-repo learning queries for apm-hub retro | – | #160, #135, #137 |
| 2 | #162 | retro candidates as attention: approve lessons and candidate PBIs from the bus | – | #138, #160 |
| 3 | #163 | lesson export: write the apm-hub lessons contract into several repos via PR | – | GravionLabs/apm-hub#661, #161, #162 |

## Unscheduled

#150 (close merged Task issues automatically) and the code rename #70 (`needs-decision`).

## Parked: dromos-mux (Epic #36, #56)

Deferred by decision on 2026-10-26: the herdr plugin is the workspace and runs are mostly headless via apm-hub. Label `parked`, independent of all active epics, last if ever. Rule: no active issue is blocked by a parked one. Blocked-by links among parked issues are kept.

| Issue | Title | Depends on |
| --- | --- | --- |
| #46 | daemon with PTY sessions, detach/attach | #38 (done) |
| #47 | client: tabs, splits, keybindings | #46 |
| #49 | standalone mode without a bus | #47 |
| #54 | click navigation in the sidebar | #47 |
| #66 | idle detection feeds `session.idle` (pane only; moved from Feature #61) | #41 (done), #63 |
| #68 | dromos-mux handles session requests (moved from Feature #61) | #46 |

Features #45 (core) and #50 (sidebar and attention) hold these PBIs. Epic #56 (phases #57 Windows/macOS/SSH, #58 queue view and usage, #59 comfort) follows the former gates: dromos-mux used daily for two weeks, then stable on all three OS.

## Dropped (closed as not planned, 2026-10-26)

| Closed | Reason | Successor |
| --- | --- | --- |
| #20 (Feature), #21 #22 #23 #24 #25 #33 | own interactive role mode, superseded by the apm-hub orchestrator and agents | apm-hub orchestrator and agents |
| #32 (`role` part) | same | `serve` only |
| #48 | `dromos-mux up` | #101 |
| #51 | mux SSE client | #100, #102 |
| #52 | mux sidebar | #105 |
| #53 | mux attention | #103 |
| #67 | pane executor, bus side | #106 |
| #55 | mux MVP validation | #165 |

## Risks

- #39 decides the event shape for everything after it; session events (#62) extend it, so plan them together.
- The pane mode (#106) relies on the herdr plugin claiming `session.requested`; without it the request fails after the claim timeout instead of hanging. The earlier dromos-mux claim path is parked.
- The herdr plugin depends on the herdr 0.9.x API (verified in #100); a protocol mismatch degrades the plugin, not the bus.
- Headless `input` (stdin) is unverified for both CLIs; headless gate answers wait for that decision (#65).
- Learned content reaching prompts (injection, drift, Stage 7): human approval through `attention`, PR-only export, size caps and the apm-hub guardrails (GravionLabs/apm-hub#590).
