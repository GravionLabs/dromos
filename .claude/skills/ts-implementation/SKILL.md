---
name: ts-implementation
description: 'TypeScript implementation and test rules (Vitest) extending `implementation`. Loaded when `implementation` dispatches to ts-implementation.'
---

## Framework

- **Tests**: Vitest — see `ts-test`
- **Format/Lint**: ESLint (flat config) + Prettier — see `setup-prettier-eslint-husky` and `## Format`
- **Runtime**: Node.js 22 LTS

## Format

- Extensions: prettier `.ts .tsx .js .mjs .cjs .json`; eslint only `.ts .tsx .js .mjs .cjs` (never json, html, scss, css)
- Format: `npx prettier --write {files}` then `npx eslint --fix {files}`
- Check (read-only): `npx prettier --check {files}` and `npx eslint {files}`
- Not configured: tool not in the project — the `-Requires` probe fails and the script prints `skipped: <tool> not configured`; note it in the report
- Run after green tests, before the commit (`-Check` for the check commands; see `implementation` `references/format.md`):
  `pwsh <implementation dir>/scripts/Format-Changed.ps1 -Language ts -Extensions .ts,.tsx,.js,.mjs,.cjs,.json -Requires 'npx --no-install prettier --version' -Command 'npx --no-install prettier --write {files}'`
  `pwsh <implementation dir>/scripts/Format-Changed.ps1 -Language ts -Extensions .ts,.tsx,.js,.mjs,.cjs -Requires 'npx --no-install eslint --version' -Command 'npx --no-install eslint --fix {files}'`
- Override: `.agents/format.json` with an entry for `ts` replaces these commands; then run the script once per mode with `-Language ts` only (it supplies extensions and commands); a missing configured tool is an error (`docs/usage/format-override.md`)

## Imports

- ES modules only — `import` not `require`
- Relative paths with `.js` extension: `import { foo } from "../foo.js"`

## Conventions

- Types: never `any`. Use explicit interfaces or type aliases.
- Async: `async/await` only, no raw `.then()`.
- File naming: `kebab-case.ts`.

## Tests

Runner config, test file naming, mocking and coverage live in `ts-test`.

## Review rules

- No `any` — use `unknown` and narrow; `strict: true` in `tsconfig.json`
- No floating promises; async functions propagate or handle errors
- ESM `import` only; `path.join`/`path.resolve` for file paths
- No `eval()`/`new Function()`; validate input before queries, paths, shell commands
- Tests isolated with specific assertions (not just `toBeTruthy()`) — rules in `ts-test`
