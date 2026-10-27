# PBI runner validation

Runs of `dromos run pbi <nr> --harness <name>` on real PBIs (issue #225). Target: ten runs with `claude`, five with `copilot` (or fewer per the B6b decision). Every runner defect is an issue of its own.

## Runs

| # | PBI | Harness | Outcome | PR | Duration | Cost | Defects |
|---|-----|---------|---------|----|----------|------|---------|
| 1 | #230 | claude | `blocked` (blocked by #229) | none | 1 s | 0 | none; the runner correctly refused a blocked PBI |
| 2 | #231 | claude | `pr_opened`, no fix round | [#264](https://github.com/GravionLabs/dromos/pull/264), merged | 120 s | 0.46 USD (implementer 0.35, reviewer 0.11) | #265, #266, #267 |

## Notes

- **Run 2, #231:** 20 files, +18/-4523 lines; CI green. The reviewer returned `review.clean` in round 0, yet the PR deleted `run-events.integration.test.ts` whole and dropped a coverage gate (#266), left out the `grep` evidence the acceptance criteria demand (#265) and said "Not delivered: Nothing" next to six open notes (#267).
- Candidates are chosen from open PBIs whose blockers are closed; the runner refuses blocked ones.
