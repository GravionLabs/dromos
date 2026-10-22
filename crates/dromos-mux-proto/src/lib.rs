//! Bus event types and IPC messages shared by the `dromos-mux` daemon and client.
//!
//! This crate is a placeholder; the real types arrive with issue #39.

/// Version of the daemon/client IPC protocol.
pub const PROTOCOL_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_starts_at_one() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }
}
