# Roadmap — Dromos (formerly agent-bus)

Order of work for the open issues of `dromos` (repository renamed from `agent-bus` on 2026-10-18, code rename: see #70). Last release `v0.4.0` (2026-10-28); each later stage names its milestone. Dependencies come from the native blocked-by links of the issues. Some bus-core PBIs (Stage 3, 6) have no such lines; their dependencies here are inferred from the titles and marked with `~`.

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

Unblocks apm-hub 2.8.0 (#591, #592) at #135–#137; the Attention API (shipped; #138 closed) is what #103 (herdr) answers attentions through, and it settles the headless `input` question of #65 for gate answers (restart with a fresh prompt instead).

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

## Stage 3b — herdr plugin (Epic #98, Feature #99; milestone 0.7.0)

Moved from 0.6.0 to 0.7.0 on 2026-10-28: the runner hardening (Stage 4b) comes first, because its bugs hit every run on a target repository today.

The primary workspace for dromos runs; dromos-mux is parked. Refined on 2026-10-28 for the runner model (Epic #98, "Decisions 2026-10-28"; decision record 003): a run is `dromos run …` started in a herdr pane, the runner records `HERDR_PANE_ID` on the first `run.state` of a PBI run, the first `phase.started` of a plan run and on every `attention`, the plugin maps run to pane. Planner questions are answered from herdr through the Attention API and taken by the next run.

| Order | Issue | Title | Depends on |
| --- | --- | --- | --- |
| 1 | #100 | plugin skeleton: manifest, `dromos herdr` daemon, bus and socket clients | – |
| 1 | #295 | event stream tails SQLite so runner events reach live subscribers | – |
| 1 | #296 | the planner reads an answered bus attention like a `/answer` comment | – |
| 2 | #102 | state bridge: run events set herdr agent state and sidebar tokens | #100, #295 |
| 3 | #103 | attention: notification, jump key, answer composer | #102, #296 |
| 4 | #107 | docs: herdr plugin as the primary workspace | #103 |
| 5 | #165 | end-to-end validation on macOS | #100, #295, #296, #102, #103 |
| 6 | #297 | release 0.7.0 | #107, #165, #340 |

Closed as not planned on 2026-10-27 (simplification triage): #101 launcher, #104 reverse channel, #105 and #114 run view, #106 pane executor. Feature #99 closes with #165 and #297.

## Stage 4 — harness adapters and runner (Feature #61 in Epic #166; milestones 0.2.0 to 0.4.0)

Decision of 2026-10-27 (dromos#131, [simplification plan](https://github.com/GravionLabs/apm-hub/blob/release/next/docs/simplification-plan.md)): dromos owns the control flow, apm-hub is content (skills and prompts). The runner is a program: `dromos run epic|feature|pbi <nr>` reads the issue hierarchy, plans where something is missing, selects the next approved and unblocked PBI, and calls one flat harness session per step (Claude, Copilot) through one adapter interface. GitHub stays the source of truth for issue state; the bus keeps events and metrics. Order and sizes: [simplification work plan](https://github.com/GravionLabs/apm-hub/blob/release/next/docs/simplification-workplan.md) (dromos items B1 to B21; milestones 0.2.0 B1-B6b, 0.3.0 B7-B17, 0.4.0 B18-B21).

This replaces the earlier Session API (`session.*` events, `sessions` table, headless executor, HTTP endpoints with restart and input: #62-#65, #69, #106), which was a workflow-independent executor driven from outside. The pane executor #106 was closed on 2026-10-27 without successor; idle detection (#66) stays parked with dromos-mux.

B1-B21 shipped in `v0.3.0` and `v0.4.0` (2026-10-28), together with the validation fixes #299, #304, #305, npm publishing #303 and the setup step that installs dependencies in the worktree (Feature #310: #311, #312, #313).

## Stage 4a — runner config for target repositories (Feature #289; milestone 0.5.0)

`dromos init` and `dromos config check|schema` (#288) are done; the release #290 is the only open item.

## Stage 4b — runner hardening (Features #321, #319; milestone 0.6.0)

Found while running agentlens PBIs on the runner (2026-10-28). A PBI cannot be run again once a run left a worktree or a branch (#255, analysis there), the runner knows the ecosystems of a target repository in five places that have drifted apart (setup, format, the `npm test` default, the allowlist, the unused `src/gate.ts`), and setup, format and test commands run without a timeout. Release PBI #340.

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | #322 | preflight before the claim finds leftovers of earlier runs | M | – |
| 1 | #331 | setup, format and test commands run without a timeout | S | – |
| 1 | #326 | ecosystem registry for setup, format and allowlist | M | – |
| 2 | #323 | clean up worktree and branch after every outcome, `dromos run clean` | M | #322 |
| 2 | #324 | `--restart` keeps the old attempt as a branch and starts over | S | #322 |
| 2 | #325 | `--resume` continues a blocked run in its kept worktree | M | #322 |
| 2 | #327 | detect the test command, with Rust and Go | M | #326 |
| 3 | #330 | dependencies changed by the implementer are not installed before the tests | S | ~#326 |
| 3 | #328 | `dromos config check` shows detected ecosystems and resulting commands | S | #327 |
| 4 | #340 | release 0.6.0 | S | all above, #290 |

#255 closes with the last of #324 and #325. #322 fixes the rerun of the runner itself and runs in a session, not through `dromos run pbi`. [rtk](https://github.com/rtk-ai/rtk) is the reference for the registry's shape (`src/discover/rules.rs`, one module per ecosystem in `src/cmds/`), not a code source.

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

Runner bugs without a milestone, to be triaged into 0.6.0 or later:

- from the runner validation (#225): #252, #265, #266, #267, #273, #274, #276, #278, #282, #284 (#282 and #284 are probably fixed by #304)
- from the analysis of #255 (found by reading the code, not yet observed): #332 ignored files the tests need, #333 submodules and LFS, #334 moved integration branch, #335 git hooks (`needs-decision`), #336 `gh` auth and rate limit (preflight #322), #337 stale claim after a killed run, #338 concurrent claim, #339 cold Cargo build per worktree
- Feature #263 (format step from `.dromos/config.json`) is open although its PBI #287 is done; to be closed or refined

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
| #48 | `dromos-mux up` | #101 (closed 2026-10-27: runs start as `dromos run …` in a herdr pane, #102) |
| #51 | mux SSE client | #100, #102 |
| #52 | mux sidebar | #105 (closed 2026-10-27, run view dropped); tokens in #102 |
| #53 | mux attention | #103 |
| #67 | pane executor, bus side | #106 (closed 2026-10-27, no successor) |
| #55 | mux MVP validation | #165 |

## Risks

- #39 decides the event shape for everything after it; session events (#62) extend it, so plan them together.
- The herdr plugin depends on the herdr 0.9.5 socket protocol (verified and recorded in #100); a protocol mismatch degrades the plugin to notifications, not the bus.
- The herdr plugin sees runner events only through the stream tail of #295; the runner writes SQLite directly and never depends on `dromos serve`.
- Headless `input` (stdin) is unverified for both CLIs; headless gate answers wait for that decision (#65).
- Learned content reaching prompts (injection, drift, Stage 7): human approval through `attention`, PR-only export, size caps and the apm-hub guardrails (GravionLabs/apm-hub#590).
