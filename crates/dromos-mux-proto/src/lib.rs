//! Bus event types and IPC messages shared by the `dromos-mux` daemon and client.
//!
//! This crate is a placeholder; the real types arrive with issue #39.

/// Version of the daemon/client IPC protocol.
pub const PROTOCOL_VERSION: u32 = 1;

// Version 0 is reserved for "unset"; fail the build if it is ever used.
const _: () = assert!(PROTOCOL_VERSION > 0);
