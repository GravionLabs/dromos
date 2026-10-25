---
name: rust-test
description: 'Write and run Rust tests: unit and tests/ integration, cargo test, mockall, proptest.'
---

## Prerequisites

- Rust toolchain via rustup, `Cargo.toml` at the project root
- Optional: `cargo install cargo-nextest`

## Test Runner

- **Run all**: `cargo test --all-features`
- **Single test**: `cargo test <name_filter>`; one integration file: `cargo test --test <file>`
- **Targeted run** (per commit): `cargo test <name>` for the changed module or `cargo test --test <file>`; unknown mapping: `cargo test --lib`, never the full suite
- **Faster runner (optional)**: `cargo nextest run` (does not run doctests; also run `cargo test --doc`)
- **Show output**: `cargo test -- --nocapture`

### Layout and Naming

- Unit tests live in the same file: `#[cfg(test)] mod tests { use super::*; ... }`
- Integration tests live in `tests/*.rs` and use only the public API of the crate
- Shared helpers in `tests/common/mod.rs`
- Name tests `<condition>_<expected>` (for example `empty_input_returns_error`)

## Writing Tests

1. Read target code: public interface, error enum, dependencies
2. Identify cases: happy path, boundaries, each error variant
3. Choose type: pure logic as unit test in-module; cross-module or I/O flows in `tests/`
4. Write one scenario per `#[test]`; assert on `Result` values, not on panics, where possible
5. Verify with `cargo test`
6. Only when `detect-techstack` reports `frameworks: ["tauri"]`: keep command logic in pure functions and test those; `tauri::test` (mock runtime) is optional for the command wiring; delegate the frontend to `ts-test`

Reference files (load when needed):
- `references/mocking-and-properties.md` - `mockall` traits, async tests, `proptest`

## Gotchas

- Tests run in parallel: no shared mutable state or fixed file paths; use `tempfile`
- Return `Result<(), Box<dyn std::error::Error>>` from tests to use `?`; use `#[should_panic(expected = "...")]` only for panics
- Async tests need `#[tokio::test]` (not `#[test]`)
- Mock only trait boundaries you own; never mock internals, test the public interface
- Never write tests that pass trivially without exercising logic
- `#[ignore]` needs a reason string and a run command in a comment
