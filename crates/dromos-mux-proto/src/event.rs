//! Forward-compatible wrapper around the generated [`BusEvent`].

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::BusEvent;

/// `type` values the generated [`BusEvent`] knows, taken from the generated
/// [`BUS_EVENT_TYPES`](crate::BUS_EVENT_TYPES) so a new variant can never fall into
/// [`Event::Unknown`]. Tags match case-sensitively.
pub const KNOWN_TYPES: &[&str] = crate::BUS_EVENT_TYPES;

/// A bus event as received by the mux.
///
/// Event types added to the bus before the mux is updated land in [`Event::Unknown`] instead of
/// failing, so the mux keeps working. A known `type` with a malformed payload is still an error.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// An event whose `type` the generated schema knows, validated strictly.
    Known(BusEvent),
    /// An event with an unrecognised `type`; `raw` is the untouched JSON and is serialised as is.
    ///
    /// **Untrusted:** nothing beyond `type` being a string is validated. The envelope fields may
    /// be missing, `raw` may hold arbitrary nesting and size, and both `event_type` and string
    /// values in `raw` may contain control characters or terminal escape sequences. Bound the
    /// input size before deserialising, and escape or truncate these values before displaying
    /// or logging them.
    Unknown {
        /// The value of the `type` field (untrusted, see above).
        event_type: String,
        /// The complete original JSON object (untrusted, see above).
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
