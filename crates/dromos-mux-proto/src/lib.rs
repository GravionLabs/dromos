//! Bus event types and IPC messages shared by the `dromos-mux` daemon and client.
//!
//! The event types are generated from `schema/events.schema.json` (exported from the Zod
//! `BusEvent` union) by `cargo run -p dromos-schema-gen --locked` into the checked-in
//! `generated` module; do not edit it by hand. [`BusEvent`] is internally tagged on `type`.
//! Timestamps (`at`) stay strings validated by the schema's ISO-8601 pattern instead of
//! `chrono::DateTime`, so events re-serialise byte-for-byte as the TypeScript bus wrote them.
//!
//! Integer fields (`id`, `issue`) are `i64`. The JSON Schema bounds them to the JavaScript safe
//! integer range (±2^53-1), which the generated types do not enforce: the TypeScript bus is the
//! producer and validates the bound with Zod, and `i64` is a strict superset. Code that writes
//! events from Rust must stay within ±2^53-1 itself.

mod event;

// No lint allowances: the generated code passes the workspace lints as is. If a typify upgrade
// or a new event type trips a lint, add a targeted `#[expect(clippy::<lint>)]` here.
#[rustfmt::skip]
mod generated;

pub use event::{Event, KNOWN_TYPES};
pub use generated::error::ConversionError;
pub use generated::{
    BUS_EVENT_TYPES, BusEvent, BusEventAt, BusEventSource, HookEvent, HookEventCli, HookEventModel,
    HookEventRole, HookEventState,
};

/// Version of the daemon/client IPC protocol.
pub const PROTOCOL_VERSION: u32 = 1;

// Version 0 is reserved for "unset"; fail the build if it is ever used.
const _: () = assert!(PROTOCOL_VERSION > 0);
