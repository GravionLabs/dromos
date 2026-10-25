# Tauri conventions

Load only when `detect-techstack` reports `frameworks: ["tauri"]`. Default is Tauri 2; see the last section for Tauri 1.

## Layout and separation

- Backend is Rust in `src-tauri/` (`Cargo.toml`, `tauri.conf.json`, `capabilities/`); the frontend is plain JS/TS and follows `ts-implementation` or `ng-implementation`
- Keep business logic in plain modules or a library crate; `#[tauri::command]` functions are thin adapters that parse input, call the logic and map errors
- The frontend reaches the filesystem, shell and network only through your commands or granted plugin APIs; everything crosses the IPC boundary as a command or event
- Treat every command argument as untrusted input: validate paths (no traversal outside an allowed root), never build shell commands from strings, and keep a strict CSP in `tauri.conf.json`
- Run cargo commands in `src-tauri/`; `pnpm tauri dev` and `pnpm tauri build` run from the project root

## Commands

- Annotate with `#[tauri::command]`, register all in one `tauri::generate_handler![...]` call
- Arguments and return types must be `serde` types (`Deserialize` in, `Serialize` out); arguments arrive as camelCase from JS
- Errors: return `Result<T, E>` where `E: Serialize`. Define a `thiserror` enum and implement `Serialize` (usually as a user-safe message; log internals instead of leaking them); never return `anyhow::Error` or `String` ad hoc
- Shared state: `app.manage(state)` in `setup`, read it with `tauri::State<'_, T>`; state must be `Send + Sync + 'static`; use `Mutex` (or `tokio::sync::Mutex` across `.await`) for mutation
- Async commands for I/O; they cannot take borrowed arguments such as `&str` (use `String`) unless they return `Result`; never block the main thread with long synchronous work
- No `unwrap()`/`expect()` in commands: a panic aborts the command's task and surfaces as an opaque failure; return a typed error instead

## Events vs commands

- Command: request/response from the frontend, returns a typed result or error
- Event (`emit`, `listen`): fire-and-forget notifications, backend-to-frontend progress and streaming, no return value
- Use commands for anything that needs an answer; use events for push updates; unlisten on component teardown

## Capabilities and permissions (Tauri 2)

- Every command and plugin API the frontend may call is granted in `src-tauri/capabilities/*.json` via `permissions`, scoped per window
- Grant the narrowest permission (for example `fs:allow-read-text-file` with a path scope) instead of broad defaults
- Commands registered in `generate_handler!` are callable from every window unless restricted; define an app manifest (`tauri_build::Attributes` with `AppManifest::commands`) and grant them per window in a capability
- Never add a wildcard scope to silence a permission error; add the specific permission

## Plugins

- Prefer an official `tauri-plugin-*` (fs, dialog, shell, http, store) over custom code
- Add the crate in `src-tauri/Cargo.toml`, register with `.plugin(...)` on the builder, add the JS package, then grant its permissions in a capability
- Custom plugins: separate crate with its own commands and `permissions/` files

## Tauri 1 vs 2

- Tauri 1: `allowlist` in `tauri.conf.json` toggles API groups; `tauri::api` module; config under `tauri`
- Tauri 2: allowlist is replaced by capabilities and permissions; core APIs moved into plugins; config uses `app` and `bundle` keys
- When migrating, review the resulting capability files by hand
