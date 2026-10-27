# Spike: one Task through the harness CLIs

`dromos run task` implements one Task with a headless CLI (`claude` or `copilot`) in a fresh
worktree. It measures how far the CLIs get on their own, before the SDK adapters exist. It is a
measurement tool, not the runner.

## Run

```sh
dromos run task <nr> --harness claude [--repo <path>]
dromos run task <nr> --harness copilot [--repo <path>]
```

`<nr>` is the issue number in the repository at `--repo` (default: the current directory). The
repository needs an `origin/release/next`, a git-ignored `.worktrees/`
and an authenticated `gh`. The command

1. reads the issue title with `gh issue view` and creates the branch `spike/<nr>-<slug>` as the
   worktree `.worktrees/spike-<nr>` from `origin/release/next`,
2. runs one `implementer` phase (model from `.dromos/config.json`, default `sonnet`) with the prompt
   "implement this Task and commit" and a 30 minute timeout,
3. checks that `HEAD` moved, and
4. writes `phase.started` and `phase.finished` (or `phase.failed`) to `<dataDir>/bus.db`, with the
   harness name and version, model, duration and usage.

Exit code 0 when the phase finished with a new commit, 1 otherwise (the reason is on stderr), 2 on a
usage error. The worktree is kept for inspection; remove it with `git worktree remove`.

## Measure

Run the same Task with both clients, then compare:

```sh
dromos events --issue <nr> --type phase.started,phase.finished,phase.failed --json
```

Per run: outcome (`finished` or `failed`), `durationMs`, `usage` (Claude reports tokens and cost,
Copilot reports none, so its `usage` is `null`), then review the commit in the worktree against the
Acceptance Criteria. Repeat per Task size (S, M) and note flakiness.

## How the allowlist is applied

The headless CLIs cannot call the TypeScript permission callback, so `CliHarness` hands the allowlist
(`ALLOWED_COMMANDS` of `src/runner/permissions.ts`) over as flags: `--allowedTools "Bash(<prefix>:*)"` for
Claude, `--allow-tool "shell(<prefix>)"` and `--allow-tool write` for Copilot. The git guardrails
(no push to `main` or `release/*`) therefore do **not** apply in the spike; run it on a repository
where that is acceptable.

## Versions used

| Client | Version | Flags checked with `--help` |
|---|---|---|
| Claude Code | 2.1.311 | `-p`, `--output-format json`, `--model`, `--allowedTools` |
| Copilot CLI | not installed on the development machine | `-p`, `--model`, `--allow-tool` taken from its documentation, **not verified**; check `copilot --help` before the first run and adjust `buildArgs` in `src/runner/harness/cli.ts` |

The unit tests use a fake binary on `PATH` and never call a real client. A live run is manual.
