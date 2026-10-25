# Roadmap — Dromos (formerly agent-bus)

Order of work for the open issues of `dromos` (repository renamed from `agent-bus` on 2026-10-18, code rename: see #70). Last release `v0.1.0` (2026-10-25); each later stage names its milestone. Dependencies come from the native blocked-by links of the issues. The PBIs of Epic #1 (stages 1, 3, 6) have no such lines; their dependencies here are inferred from the titles and marked with `~`. apm-hub side: `GravionLabs/apm-hub` `ROADMAP.md` (releases 2.6.0, 2.7.0, Feature #398).

## Unattended path — what apm-hub's self-learning workflow needs from dromos

apm-hub's Epic #573 (`GravionLabs/apm-hub` `ROADMAP.md`, "Unattended path") runs Features and Epics without a human and feeds a retro loop. Its steps 0–4 (releases 2.5.0–2.7.0) need nothing from dromos; the ledger stays the source of truth and the bus holds a projection. dromos is needed from step 4 on:

| apm-hub step | Needs from dromos | Issue | Milestone | Status |
| --- | --- | --- | --- | --- |
| 4 (#389, released in apm-hub 2.4.0) | `POST /ingest` for the `SubagentStop` hook | #43 | 0.1.0 | released |
| 4 (#391, 2.7.0) | `attention` with id and state, answer endpoint | #138 (Feature #134) | 0.2.0 | open |
| 5 (#591, 2.8.0) | `progress` events with `data.kind` and `data.fields` | #136 | 0.2.0 | open |
| 5 (#592, 2.8.0) | `GET /events` query API | #135 | 0.2.0 | open |
| 5 (#592, 2.8.0) | `dromos run metrics`, `GET /runs/{issue}/metrics` | #137 (also needs apm-hub#393) | 0.2.0 | open |
| 6 (#398, 2.8.0) | headless session executor and HTTP endpoints | #62–#65 | 0.4.0 | open |
| 6 (#398, optional) | pane executor, dromos-mux handles session requests | #66–#68 | 0.4.0, 0.5.0 | open |
| any | merged Task issues are closed automatically | #150 | none | open, to be scheduled |

Order inside dromos: #136 → #135 → #138 → #137 (Stage 2b), then Stage 4. Gate answers by `attention` (#138) and by the apm-hub `/ruling` comment (#581) are independent; the comment path works without dromos.

## Done

Feature #2 (project foundation) and Feature #7 (messaging: `post`, `ack`, `inbox`, `/events`, bus log).

`v0.1.0` (2026-10-25): Feature #12 workflow core (#13–#19; the Feature is still open with label `merged` and can be closed), Feature #37 Rust workspace and event schema (#38, #39), agent instances #41, SSE stream #42, `POST /ingest` #43, rename #71, worktree #80, Node CI #90, release conventions #108, apm-hub compatible lease #126 and branch names #127. apm-hub consumes `/ingest` since its 2.4.0 (#389).

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

Unblocks apm-hub 2.8.0 (#591, #592) at #135–#137; #138 is what #103 (herdr) and #53 (dromos-mux) answer attentions through, and it settles the headless `input` question of #65 for gate answers (restart with a fresh prompt instead).

## Stage 3 — roles, CLI, idle hooks, decisions (Epic #1, Features #20, #26, #29; milestone 0.2.0)

| Issue | Title | Depends on |
| --- | --- | --- |
| #130 | typed `task` message payload | — |
| #131 | decision records and out-of-scope list | — |
| #113 | `dromos run export <issue> --format json|mermaid` | #112, #43 (both done) |
| #32 | CLI `serve` and `role` | — |
| #21 #22 #23 | orchestrator, implementer, reviewer agent definitions | ~#32 |
| #24 | install script and per-role MCP configs | ~#21–#23 |
| #25 | idle hooks | ~#24 |
| #28 #33 | `dromos log`, `dromos up` (print) | ~#32; #33 unblocks the herdr launcher #101 |

0.2.0 closes with Stage 2b, this stage and #30, #31 (Feature #29, validation, see Stage 6).

## Stage 3b — herdr plugin (Epic #98, Feature #99; milestone 0.3.0)

The primary workspace for dromos runs; dromos-mux (Stage 5) stays as the standalone multiplexer. apm-hub's parked gates (#391 → `attention`) are answered from here through #138.

| Order | Issue | Title | Depends on |
| --- | --- | --- | --- |
| 1 | #100 | plugin skeleton: manifest, startup daemon, bus and socket clients | #42 (done) |
| 2 | #101 | `dromos up <issue> --herdr`: role panes with bus identity | #100, #33, #41 (done) |
| 3 | #104 | reverse channel: herdr agent status into the bus as `agent.state` | #101, #43 (done) |
| 3 | #102 | state bridge: bus events set herdr agent state and sidebar tokens | #101, #44, #43 (done) |
| 4 | #103 | attention: notification, highlight, jump key | #102 |
| 4 | #105 | run view: runs, queue items, usage | #102 |
| 5 | #114 | run view: subagent tree from `agent.run` events | #105, #112 (done) |
| 6 | #107 | docs: herdr plugin as the primary workspace | #103 |

Feature #99 closes with #106 (pane executor via herdr, milestone 0.4.0, Stage 4).

## Stage 4 — Session API (Feature #61; #62–#67 and #106 in milestone 0.4.0, #68 and #69 in 0.5.0)

Workflow-independent executor: a driver asks the bus to run a session and restart it with a fresh start prompt. Unattended overnight runs of an apm-hub Epic build on it (apm-hub #398).

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | #62 | `session.*` event types in the schema | S | #39 |
| 2 | #63 | `sessions` table and session manager | M | #41 |
| 3 | #64 | headless executor | M | #62, #63 |
| 4 | #65 | HTTP endpoints, restart, input | M | #64, #42 |
| 5 | #66 | idle detection feeds `session.idle` | S | #25, #41, #63 |
| 6 | #67 | pane executor, bus side (request/claim via events) | M | #65, #43 |
| 6 | #106 | pane executor via herdr (closes Feature #99) | M | #65, #67, #101 |
| 7 | #68 | dromos-mux handles session requests | M | #46, #51, #67 |
| 8 | #69 | docs and driver conformance test | S | #65, #67, #68 |

Headless mode (#62–#65) works without dromos-mux and is enough for overnight runs; #66–#68 add the pane mode.

## Stage 5 — dromos-mux MVP (Epic #36, Features #45 and #50; milestone 0.5.0)

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

## Stage 6 — validation (Epic #1, Feature #29; milestone 0.2.0)

#30 integration test with mocked `gh`, #31 manual end-to-end checklist. Stage 1 is done, so both can start; they close 0.2.0.

## After the MVP (Epic #56)

Phase 1 #57 (Windows, macOS, SSH attach), phase 2 #58 (queue view, usage; needs apm-hub #392 and #393), phase 3 #59 (comfort). Each starts after the gate before it. PBIs are planned per phase. Unscheduled: #150 (close merged Task issues automatically) and the code rename #70 (`needs-decision`).

## Risks

- #39 decides the event shape for everything after it; session events (#62) extend it, so plan them together.
- The pane mode relies on dromos-mux claiming `session.requested`; without it the request fails after the claim timeout instead of hanging.
- Headless `input` (stdin) is unverified for both CLIs; headless gate answers wait for that decision (#65).
