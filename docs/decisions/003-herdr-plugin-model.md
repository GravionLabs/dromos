# 003: herdr plugin follows the runner model

Status: accepted (2026-10-28)

## Context
The herdr plugin (Epic #98) was specified on 2026-10-23 for a launcher that opened one herdr pane per agent role. The simplification of 2026-10-27 moved the control flow into the dromos runner: a run is one process, `dromos run pbi|feature|epic|plan`, that drives headless harness sessions. The launcher (#101), the reverse channel (#104), the run view (#105, #114) and the pane executor (#106) were closed. Two gaps surfaced in the code: the runner writes SQLite directly and `GET /events/stream` pushed only in-process events live; and the planner read answers from `/answer` issue comments only, so an answer through the Attention API never reached it.

## Decision
- A run is the `dromos run …` process started in a herdr pane. The runner records `HERDR_PANE_ID` as optional `pane` in its first `run.state` event; the plugin maps the run to that pane. Runs without a pane get notifications only (#102).
- The event stream tails the database so events from other processes reach subscribers live (#295). The runner does not post to `dromos serve`.
- The planner reads answered bus attentions like `/answer` comments and acks them (#296). Neither the plugin nor the bus writes issue comments.
- The runner emits `attention` kind `APPROVAL` per `needs-approval` issue it creates (#235); the plugin never polls GitHub.
- The plugin is the subcommand `dromos herdr` under `src/herdr/` in the one package; `herdr-plugin/` holds the manifest. No pnpm workspace.
- Validation on macOS (primary workspace); milestone 0.6.0.

## Rationale
The pane the run was started in is the only pane the runner knows; mapping through its own event needs no launcher and no herdr-side detection. Tailing the database fixes live delivery for every subscriber and keeps the runner independent of `dromos serve`. Closing the answer loop in the runner keeps `gh` access where it already is and leaves the plugin bus-only (decision 002). One package avoids schema coupling across packages for a daemon of a few hundred lines.

## Consequences
`RunStateData` gains an optional `pane`; schema and generated Rust types are regenerated. `dromos serve` runs a poll timer while a stream is open. The planner's answer precedence is flags, comments, attentions. The herdr PBIs #100, #102, #103, #107, #165 were rewritten accordingly; #295, #296, #297 were added under Feature #99.
