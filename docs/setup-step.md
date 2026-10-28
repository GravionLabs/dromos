# Setup step

Right after the worktree is created, before the implementer, the format step and the tests, `dromos run pbi` installs the dependencies in the worktree. It is a real install, not a link to the main checkout: pnpm checks the dependency state before every `pnpm run` and fails in a worktree that shares another project's `node_modules` (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, found in the run of #303), and a pull request that changes dependencies has to be tested against its own lockfile.

The commands run in the worktree, outside the harness session, through the same shell helper as the tests and without a TTY. A fresh worktree has no modules directory, so no package manager asks before purging one. With the package manager's shared store the install takes seconds.

## Detection

On by default. Per ecosystem, the first matching lockfile in the worktree wins; matches of several ecosystems all run, in table order.

| Lockfile | Command |
|---|---|
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile --prefer-offline` |
| `yarn.lock` with `.yarnrc.yml` (Yarn 2+) | `yarn install --immutable` |
| `yarn.lock` (Yarn 1) | `yarn install --frozen-lockfile --prefer-offline` |
| `package-lock.json` | `npm ci --prefer-offline` |
| `uv.lock` | `uv sync --frozen` |
| `poetry.lock` | `poetry sync` (Poetry 2) |

The Python commands create the worktree's own virtual environment; uv and Poetry share their package cache, so this is fast. For Poetry 1 set `"setup": "poetry install --sync"`. Without a matching lockfile the step is skipped. Cargo, Go, Gradle and Maven need no step: their dependencies come from a global cache every worktree shares. Rust still compiles everything once in a worktree, because each worktree has its own empty `target/`; sharing one `target/` between parallel runs is not safe, [sccache](https://github.com/mozilla/sccache) is the remedy for slow cold builds.

## Override

In `.dromos/config.json`:

```json
{ "setup": "pnpm install --frozen-lockfile && cargo fetch --locked" }
```

- `"setup": "<command>"` replaces detection; the command runs as is.
- `"setup": false` disables the step.

## Failure

A failing command ends the run `blocked` with the reason `setup failed: <command>`, before the implementer starts, so it is never reported as failing tests and uses no fix round. The claim is released and the worktree is kept for inspection.

## Events

| Event | When | Data |
|---|---|---|
| `setup.started` | before each command | `command` |
| `setup.finished` | command succeeded | `command`, `durationMs` |
| `setup.failed` | command failed; the run is blocked | `command`, `stderrTail` |
| `setup.skipped` | nothing to do | `reason`: `no-lockfile` or `disabled` |

The events are reported on the run output; they are not stored on the bus. `--dry-run` lists the step with the resolved commands.
