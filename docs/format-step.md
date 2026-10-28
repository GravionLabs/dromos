# Format step

After every implementer phase (all Tasks) and after every fix round, before the tests run, `dromos run pbi` formats the files changed against the base and commits the result as `style: format (#<nr>)`. No change means no commit. A formatting slip therefore never turns the tests, CI or a fix round red.

Changed files are `git diff --name-only --diff-filter=d origin/<base>...HEAD` plus uncommitted and untracked files; deleted files are skipped. The formatter runs in the worktree, outside the harness session, through the same shell helper as the tests.

## Detection

On by default. The first match in the worktree wins:

| Detection | Command |
|---|---|
| `scripts.format` in `package.json` | `<pm> run format` (pm from the lockfile; whole repo) |
| `biome.json` / `biome.jsonc` | `biome check --write <files>` |
| `.prettierrc*` / `prettier` key in `package.json` | `prettier --write <files>` |
| `pyproject.toml` with `[tool.ruff]` or `ruff.toml` | `ruff format <files>` then `ruff check --fix <files>` |
| `*.sln` / `*.slnx` / `*.csproj`, ReSharper CLI available | `jb cleanupcode <sln> --include="<files>" --profile="Built-in: Reformat Code"` |
| `*.sln` / `*.slnx` / `*.csproj`, no ReSharper CLI | `dotnet format --include <files>` |
| `Cargo.toml` | `cargo fmt` |

ReSharper CLI is available when `jetbrains.resharper.globaltools` is in `.config/dotnet-tools.json` (run as `dotnet jb …`, wins over `PATH`) or `jb` is on `PATH`. `cleanupcode` needs one solution at the repo root; with several solutions the step uses `dotnet format`. A repo `.sln.DotSettings` is honored automatically.

Only files the formatter handles are passed (`.ts .tsx .js .mjs .cjs .json` for Biome and Prettier, `.py` for ruff, `.cs` for .NET). Without a matching changed file the step is skipped.

The table is kept in sync by hand with `references/format.md` of the apm-hub `implementation` skill.

## Override

In `.dromos/config.json`:

```json
{ "format": "prettier --write {files}" }
```

- `"format": "<command>"` replaces detection. `{files}` is replaced by the space-separated (shell-quoted) file list; without `{files}` the command runs as is.
- `"format": false` disables the step.

## Events

| Event | When | Data |
|---|---|---|
| `format.finished` | formatter succeeded | `command`, `files`, `committed` |
| `format.failed` | formatter failed; the run goes on to the tests | `command`, `stderrTail` |
| `format.skipped` | nothing to do | `reason`: `no-formatter`, `no-files` or `disabled` |

The events are reported on the run output; they are not stored on the bus. `--dry-run` lists the step with the resolved command.
