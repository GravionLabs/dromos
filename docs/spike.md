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

Per run: outcome (`finished` or `failed`), `durationMs`, `usage` (Claude reports tokens and cost;
Copilot reports tokens but no dollars, so its `costUsd` is `null`, and `usage` is `null` when it
reports no token counts), then review the commit in the worktree against the
Acceptance Criteria. Repeat per Task size (S, M) and note flakiness.

## Harness names

`claude` is the Claude Agent SDK adapter (`src/runner/harness/claude.ts`): it applies the TypeScript
permission callback per tool call and validates the JSON output against the phase schema. `claude-cli`
is the headless-CLI fallback (`CliHarness`), and `copilot` is the Copilot CLI. The spike command
measures the headless CLIs, so `dromos run task --harness claude` still drives the `claude` binary
as in the measurements below; the SDK adapter has its own opt-in live test
(`DROMOS_LIVE=claude pnpm test`).

## How the allowlist is applied

The headless CLIs cannot call the TypeScript permission callback, so `CliHarness` hands the allowlist
(`ALLOWED_COMMANDS` of `src/runner/permissions.ts`) over as flags: `--allowedTools "Bash(<prefix>:*)"` for
Claude, `--allow-tool "shell(<prefix>)"` and `--allow-tool write` for Copilot (which also gets
`--output-format json`, see Usage). The git guardrails
(no push to `main` or `release/*`) therefore do **not** apply in the spike; run it on a repository
where that is acceptable.

## Versions used

| Client | Version | Flags checked with `--help` |
|---|---|---|
| Claude Code | 2.1.311 | `-p`, `--output-format json`, `--model`, `--allowedTools` |
| Copilot CLI | 1.0.104 | `-p`, `--model`, `--output-format json`, `--allow-tool` (verified with `copilot --help` and a live run, 2026-10-27) |

The unit tests use a fake binary on `PATH` and recorded output fixtures
(`src/runner/harness/fixtures/`) and never call a real client. The opt-in live test of the Copilot
adapter is `DROMOS_LIVE=copilot pnpm test` (`src/runner/harness/cli.live.test.ts`).

## Results

Measured 2026-10-27 against a throwaway repository (private, plain Node, `node --test`) with two
Tasks: **S** (add `subtract` plus a test) and **M** (new `stats.js` with `mean`, `median`, `mode`,
error case and tests). Claude Code 2.1.311 with `sonnet` (Sonnet 5.5), Copilot CLI 1.0.104 with
`--model auto`; the model Copilot picked is not reported, so times are only roughly comparable.
`npm test` was green in every worktree and every run produced exactly one commit.

| Harness | Task | Run | Wall time | Commit + tests | Usage |
|---|---|---|---|---|---|
| claude | S | 1 | 20 s | yes | 14 in / 1145 out tokens, $0.086 |
| claude | S | 2 | 35 s | yes | 14 in / 1166 out, $0.086 |
| claude | S | 3 | 23 s | yes | 14 in / 1147 out, $0.035 |
| claude | M | 1 | 44 s | yes | 16 in / 2977 out, $0.108 |
| copilot | S | 1 | 57 s | yes | `null` |
| copilot | S | 2 | 112 s | yes | `null` |
| copilot | S | 3 | 43 s | yes | `null` |
| copilot | M | 1 | 85 s | yes | `null` |

- **JSON validity:** Claude's `--output-format json` parsed in all 4 runs. Copilot has no JSON
  result in the spike (`text` output is taken as is), so there is nothing to validate; its
  `--output-format json` (JSONL) was not tried.
- **Permission stalls:** none in either harness (8/8 runs finished without a prompt). The allowlist
  flags were sufficient for these Tasks; they only used file edits and `npm test`.
- **Usage:** Claude reports tokens and cost. Copilot's adapter records `null`, but its text output
  ends with a footer (`AI Credits`, `Tokens ↑ … ↓ …`), so token counts are available by parsing it
  or via JSONL output.
- **Flags:** `-p`, `--model` and `--allow-tool` exist in Copilot 1.0.104. `claude-sonnet-4.5` is
  rejected ("not available"), so the config model must be a Copilot model id or `auto`.
- **Flakiness:** Copilot's wall time varied 2.6x on the same S Task (43 s to 112 s); Claude 1.7x.
  Copilot was roughly 2x slower on average.
- Not covered: git guardrails (do not apply in the spike), failure paths, larger Tasks.

## Decision

**Copilot via the CLI adapter only for 0.4.0** (decided 2026-10-27). Both harnesses finished 4 of 4
runs with a commit and green tests and without permission stalls, so the SDK adapter (B5 as
written) is not needed now. The SDK stays an option if per-call permission callbacks for Copilot
become necessary; the CLI can only apply the flag allowlist.

Follow-ups that B5 (#219) covered instead of the SDK adapter:

- **Models per harness:** `models` in `.dromos/config.json` is keyed by harness family, then role:
  `models.claude.implementer` (default `sonnet`) and `models.copilot.implementer` (default `auto`);
  `claude-cli` uses the `claude` models. A Copilot run needs a Copilot model id or `auto` (`sonnet`
  and `claude-sonnet-4.5` are rejected). The id of a Sonnet 5.5 model in Copilot is still unknown
  (`claude-sonnet-5.5` and `claude-sonnet-5-5` are rejected by 1.0.104); until then use `auto`.
- **Usage:** `CliHarness` runs Copilot with `--output-format json` (JSONL). The text is the last
  `assistant.message` without tool requests; the usage is the sum of `inputTokens` and `outputTokens`
  over `accountingSnapshot.modelMetrics` of the last `session.usage_checkpoint`. The text footer
  (`Tokens ↑ 14.2k`) is on stderr and rounded, so it is not used. Copilot reports credits, not
  dollars (`costUsd` is `null`); without a checkpoint `usage` is `null`, never an estimate.
