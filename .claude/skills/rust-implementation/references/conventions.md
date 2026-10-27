# Rust conventions

## Module layout

- Binary crate: `src/main.rs` thin, logic in `src/lib.rs` so it is testable
- One module per file (`src/foo.rs`); a directory module uses `src/foo/mod.rs` or `src/foo.rs` plus `src/foo/`
- Re-export the public API from `lib.rs`; keep everything else `pub(crate)`
- Workspaces: shared dependency versions in `[workspace.dependencies]`

## Errors

- Library: one `thiserror` enum per module or crate

```rust
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read {path}")]
    Read { path: String, #[source] source: std::io::Error },
    #[error("invalid value for {0}")]
    Invalid(&'static str),
}
```

- Binary/app boundary: `anyhow::Result` with `.context("what failed")`
- Never return `Box<dyn Error>` from a library API

## Clippy and rustfmt

- `cargo clippy --all-targets --all-features -- -D warnings` must pass before commit
- `cargo fmt --all` before commit; configure through `rustfmt.toml` only when needed
- Crate-wide lint policy belongs in `[lints]` of `Cargo.toml`; a local `#[allow]` needs a comment

## unsafe

- Avoid it; prefer safe abstractions
- Keep the block minimal, wrap it in a safe function and document the invariant with `// SAFETY:`
- Add `#![forbid(unsafe_code)]` to crates that need none

## async (tokio)

- `#[tokio::main]` only in binaries; libraries expose `async fn` and stay runtime-agnostic where possible
- Never block in async code: use `tokio::fs`, `tokio::time::sleep`, or `tokio::task::spawn_blocking`
- Do not hold a `std::sync::Mutex` guard across `.await`
- Spawned tasks need an owner: keep the `JoinHandle` or use a `JoinSet`
