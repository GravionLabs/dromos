//! Bus event types and IPC messages shared by the `dromos-mux` daemon and client.
//!
//! The event types are generated from `schema/events.schema.json` (exported from the Zod
//! `BusEvent` union) by `cargo run -p dromos-schema-gen --locked` into the checked-in
//! `generated` module; do not edit it by hand. [`BusEvent`] is internally tagged on `type`.
//! Timestamps (`at`) stay strings validated by the schema's ISO-8601 pattern instead of
//! `chrono::DateTime`, so events re-serialise byte-for-byte as the TypeScript bus wrote them.

mod event;

#[allow(clippy::all, missing_docs)]
#[rustfmt::skip]
mod generated;

pub use event::{Event, KNOWN_TYPES};
pub use generated::error::ConversionError;
pub use generated::{
    BusEvent, BusEventAt, BusEventSource, HookEvent, HookEventCli, HookEventModel, HookEventRole,
    HookEventState,
};

/// Version of the daemon/client IPC protocol.
pub const PROTOCOL_VERSION: u32 = 1;

// Version 0 is reserved for "unset"; fail the build if it is ever used.
const _: () = assert!(PROTOCOL_VERSION > 0);
