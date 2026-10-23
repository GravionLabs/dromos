//! Forward-compatible wrapper around the generated [`BusEvent`].

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::BusEvent;
use crate::generated::QueueItemDataState;

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
            let event = BusEvent::deserialize(raw).map_err(D::Error::custom)?;
            check_constraints(&event).map_err(D::Error::custom)?;
            Ok(Event::Known(event))
        } else {
            Ok(Event::Unknown { event_type, raw })
        }
    }
}

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

/// Constraints the generated types cannot express (typify drops numeric bounds and the Zod
/// refinements are not in the JSON Schema): numeric ranges, control characters in free text and
/// the `queue.item` state/result coupling. Mirrors `src/events/schema.ts`.
fn check_constraints(event: &BusEvent) -> Result<(), String> {
    use BusEvent::{Attention, HookBusy, HookIdle, Progress, QueueItem, Usage};
    let (agent_id, run_id) = match event {
        HookIdle {
            agent_id, run_id, ..
        }
        | HookBusy {
            agent_id, run_id, ..
        }
        | Progress {
            agent_id, run_id, ..
        }
        | Attention {
            agent_id, run_id, ..
        }
        | Usage {
            agent_id, run_id, ..
        }
        | QueueItem {
            agent_id, run_id, ..
        } => (
            agent_id.as_ref().map(|v| v.as_str()),
            run_id.as_ref().map(|v| v.as_str()),
        ),
    };
    let mut texts: Vec<&str> = agent_id.into_iter().chain(run_id).collect();
    match event {
        Progress { data, .. } => texts.extend([data.line.as_str(), data.agent.as_str()]),
        Attention { data, .. } => texts.push(data.summary.as_str()),
        Usage { data, .. } => {
            if data.context_tokens < 0 {
                return Err("contextTokens must be >= 0".into());
            }
            if data.cost_usd.is_some_and(|c| c.is_nan() || c < 0.0) {
                return Err("costUsd must be >= 0".into());
            }
            texts.extend(data.model.as_ref().map(|m| m.as_str()));
        }
        QueueItem { data, .. } => {
            if data.exit_code.is_some_and(|c| !(0..=3).contains(&c)) {
                return Err("exitCode must be 0..=3".into());
            }
            if data.duration_ms.is_some_and(|d| d < 0) {
                return Err("durationMs must be >= 0".into());
            }
            let coupled = match data.state {
                QueueItemDataState::Started => {
                    data.exit_code.is_none() && data.duration_ms.is_none()
                }
                QueueItemDataState::Exited => data.exit_code.is_some(),
            };
            if !coupled {
                return Err(
                    "started has no exitCode or durationMs; exited requires an exitCode".into(),
                );
            }
            texts.extend(data.mode.as_ref().map(|m| m.as_str()));
        }
        HookIdle { .. } | HookBusy { .. } => {}
    }
    if texts.into_iter().any(has_control) {
        return Err("control characters are not allowed in free text".into());
    }
    Ok(())
}

impl Serialize for Event {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Event::Known(event) => event.serialize(serializer),
            Event::Unknown { raw, .. } => raw.serialize(serializer),
        }
    }
}
