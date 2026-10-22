//! Forward-compatible wrapper around the generated [`BusEvent`].

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::BusEvent;

/// `type` values the generated [`BusEvent`] knows. Keep in sync with the generated enum; the
/// fixtures test checks that every fixture type is listed here and every entry has a fixture.
pub const KNOWN_TYPES: &[&str] = &["hook:idle", "hook:busy"];

/// A bus event as received by the mux.
///
/// Event types added to the bus before the mux is updated land in [`Event::Unknown`] instead of
/// failing, so the mux keeps working. A known `type` with a malformed payload is still an error.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// An event whose `type` the generated schema knows, validated strictly.
    Known(BusEvent),
    /// An event with an unrecognised `type`; `raw` is the untouched JSON and is serialised as is.
    Unknown {
        /// The value of the `type` field.
        event_type: String,
        /// The complete original JSON object.
        raw: Value,
    },
}

impl<'de> Deserialize<'de> for Event {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Value::deserialize(deserializer)?;
        let event_type = match raw.get("type") {
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err(D::Error::custom("event field `type` must be a string")),
            None => return Err(D::Error::missing_field("type")),
        };
        if KNOWN_TYPES.contains(&event_type.as_str()) {
            BusEvent::deserialize(raw)
                .map(Event::Known)
                .map_err(D::Error::custom)
        } else {
            Ok(Event::Unknown { event_type, raw })
        }
    }
}

impl Serialize for Event {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Event::Known(event) => event.serialize(serializer),
            Event::Unknown { raw, .. } => raw.serialize(serializer),
        }
    }
}
