# PBI runner validation

Runs of `dromos run pbi <nr> --harness <name>` on real PBIs (issue #225). Target: ten runs with `claude`, five with `copilot` (or fewer per the B6b decision). Every runner defect is an issue of its own.

## Runs

| # | PBI | Harness | Outcome | PR | Duration | Cost | Defects |
|---|-----|---------|---------|----|----------|------|---------|
| 1 | #230 | claude | `blocked` (blocked by #229) | none | 1 s | 0 | none; the runner correctly refused a blocked PBI |
| 2 | #231 | claude | `pr_opened`, no fix round | [#264](https://github.com/GravionLabs/dromos/pull/264), merged | 120 s | 0.46 USD (implementer 0.35, reviewer 0.11) | #265, #266, #267 |
| 3 | #232 | claude | `pr_opened`, no fix round | [#268](https://github.com/GravionLabs/dromos/pull/268) | 123 s | 0.37 USD (implementer 0.26, reviewer 0.11) | #267 again |
| 4 | #226 | claude | `pr_opened`, no fix round | [#269](https://github.com/GravionLabs/dromos/pull/269) | 139 s | 0.52 USD (implementer 0.41, reviewer 0.11) | #267 again, #270 |
| 5 | #226 (rerun) | claude | `pr_opened`, no fix round | [#272](https://github.com/GravionLabs/dromos/pull/272) | 143 s | 0.37 USD (implementer 0.27, reviewer 0.10) | #267 again |

## Notes

- **Run 2, #231:** 20 files, +18/-4523 lines; CI green. The reviewer returned `review.clean` in round 0, yet the PR deleted `run-events.integration.test.ts` whole and dropped a coverage gate (#266), left out the `grep` evidence the acceptance criteria demand (#265) and said "Not delivered: Nothing" next to six open notes (#267).
- Candidates are chosen from open PBIs whose blockers are closed; the runner refuses blocked ones.
- **Run 3, #232:** 10 files, +8/-1152 lines; matches the acceptance criteria, no scope creep. Again "Not delivered: Nothing" next to four open review notes (#267). One note says the agent did not run build or tests, while the PR body reports `npm test: passed` (the runner's own result).
- **Run 4, #226:** 5 files, +547/-0 lines. CI `lint` failed on the unformatted generated `schema/plan.schema.json` because the runner verifies with `npm test` only (#270). Further open points from the agent's own notes, none caught by the reviewer (`review.clean`): the label `needs-approval` does not exist in the repo (only `planned`), `createIssues` has no resume and duplicates on retry, `runPlannerPhase`/`createIssues` are not wired in anywhere, the `planner` skill is not present in the repo. "Not delivered: Nothing" again (#267).
- **Run 4 closed:** PR #269 was closed unmerged; #226 was rerun after #270 was fixed (`.dromos/config.json` sets `test.full` to build, typecheck, lint and test, PR #271).
- **Run 5, #226 rerun:** 4 files, +456/-1 lines, CI green. The agent excluded the generated `schema/plan.schema.json` from Biome, as `schema/events.schema.json` already is. Same open notes as run 4 (no `needs-approval` label, no resume in `createPlanIssues`, planner not wired in), again under "Not delivered: Nothing" (#267).
