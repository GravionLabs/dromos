---
name: rust-implementation
description: 'Rust implementation rules (clippy, rustfmt) extending `implementation`. Use when writing or changing Rust code.'
---

## Framework

- **Build**: `cargo build` (check fast with `cargo check`)
- **Lint**: `cargo clippy --all-targets --all-features -- -D warnings` is mandatory; fix warnings, never silence them blindly
- **Modules, errors, unsafe, async**: read `references/conventions.md` (relative to this skill's directory)
- **Tauri**: only when `detect-techstack` reports `frameworks: ["tauri"]`, read `references/tauri.md`

## Conventions

- Naming: `snake_case` functions/variables/modules, `PascalCase` types and traits, `SCREAMING_SNAKE_CASE` constants
- Errors: `thiserror` enums in libraries, `anyhow` at binary/app boundaries; propagate with `?`
- No `unwrap()`/`expect()` in non-test code unless the invariant is documented
- Prefer borrowing (`&str`, `&[T]`) in parameters; derive `Debug` on public types
- `unsafe` only with a `// SAFETY:` comment and a minimal scope
- File naming: `snake_case.rs`; one module per file

## Format

- Extensions: `.rs`
- Format: `cargo fmt -- {files}`
- Check (read-only): `cargo fmt -- --check {files}`
- Run after green tests, before the commit: `pwsh <implementation dir>/scripts/Format-Changed.ps1 -Language rust` (`-Check` for the check commands; not-configured, override: references/format.md of `implementation`)

## Tests

Load `rust-test` for runner, layout, mocking and property tests.

## Review rules

- 🔴 `unsafe` block without a `// SAFETY:` comment or with avoidable scope
- 🔴 `unwrap()`/`expect()`/`panic!` on fallible input in non-test code; blocking calls inside `async` code
- 🔴 Hardcoded secrets; SQL built by string formatting
- 🟡 `anyhow` in a library's public API, or stringly-typed errors instead of `thiserror`
- 🟡 `#[allow(clippy::...)]` without a justifying comment; clippy or rustfmt not clean
- 🟡 Needless `.clone()`, `String`/`Vec<T>` parameters where `&str`/`&[T]` suffice
- 🟢 Missing `Debug` derive or doc comment on public items
- Tests follow `rust-test`
