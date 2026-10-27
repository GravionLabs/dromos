# Who closes Task issues

`[Task]` sub-issues of a PBI stay open when the PBI is merged into `release/next`, because `Closes #<pbi>` only fires on the default branch. Two actors close them, in this order:

1. **Orchestrator (first line).** After the PR phase of a PBI, and when the PR is seen merged, it applies the "Task merged" rule of `github-issue` (`references/task-issues.md`, apm-hub) to the PBI's Task sub-issues and closes the hits with `Merged into <branch> in <sha>`.
2. **CI (safety net).** `release-branch.yml` runs `GravionLabs/ci/.github/workflows/release-branch.yml` on every push to `release/**`. Its `mark-merged-issues` step closes each open issue labelled `task` that a pushed commit names with `Refs #<n>`, with the same comment. It is idempotent (closed issues are skipped, so a re-run changes nothing), never fails the job, and needs `issues: write` (granted).

Only issues labelled `task` are closed. PBIs, Features and Epics keep the `merged` label flow, closed by `release.yml` at release time.

## Known gap

A squash merge that drops the `Refs #<task>` footers leaves the Tasks open: neither the orchestrator rule nor the CI step finds a commit to match. The `merged` label step has the same limit. Close those Tasks by hand.
