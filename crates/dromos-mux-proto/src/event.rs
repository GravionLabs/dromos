//! Forward-compatible wrapper around the generated [`BusEvent`].

use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::BusEvent;
use crate::generated::{ProgressDataFieldsValue, QueueItemDataState};

/// `type` values the generated [`BusEvent`] knows, taken from the generated
/// [`BUS_EVENT_TYPES`](crate::BUS_EVENT_TYPES) so a new variant can never fall into
/// [`Event::Unknown`]. Tags match case-sensitively.
pub const KNOWN_TYPES: &[&str] = crate::BUS_EVENT_TYPES;

/// A bus event as received by the mux.
///
/// Event types added to the bus before the mux is updated land in [`Event::Unknown`] instead of
/// failing, so the mux keeps working. A known `type` with a malformed payload is still an error.
// `agent.run` carries many optional fields; events are short-lived values, so boxing buys nothing.
#[expect(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// An event whose `type` the generated schema knows, validated strictly.
    Known(BusEvent),
    /// An event with an unrecognised `type`; `raw` is the untouched JSON and is serialised as is.
    ///
    /// **Unvalidated:** unlike [`Event::Known`], `raw` is never checked against the schema or
    /// [`check_constraints`].
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

/// Characters rejected in free text: control characters (`Cc`, incl. DEL and C1) and invisible
/// formatting characters that spoof or hide text (bidi controls, zero-width characters, line and
/// paragraph separators, BOM). The same explicit set lives in `src/events/schema.ts`; the shared
/// cases in `schema/parity.json` keep both in step.
fn is_forbidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{206F}'
                | '\u{FEFF}'
        )
}

/// A constraint the generated types cannot express.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConstraintError {
    /// A numeric field is outside its allowed range.
    OutOfRange {
        /// Wire name of the field.
        field: &'static str,
        /// The violated rule, e.g. `>= 0`.
        rule: &'static str,
    },
    /// A free-text field contains a forbidden character (see the crate docs).
    ForbiddenCharacter {
        /// Wire name of the field.
        field: &'static str,
    },
    /// A `queue.item` has a state that disagrees with `exitCode` / `durationMs`.
    QueueItemState,
}

impl fmt::Display for ConstraintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutOfRange { field, rule } => write!(f, "{field} must be {rule}"),
            Self::ForbiddenCharacter { field } => {
                write!(
                    f,
                    "{field} contains a control or invisible formatting character"
                )
            }
            Self::QueueItemState => {
                f.write_str("started has no exitCode or durationMs; exited requires an exitCode")
            }
        }
    }
}

impl std::error::Error for ConstraintError {}

/// Checks what the generated types cannot express: numeric ranges, forbidden characters in free
/// text and the `queue.item` state/result coupling. Mirrors `src/events/schema.ts`.
///
/// [`Event`] calls this after parsing. A bare [`BusEvent`] deserialised with serde is **not**
/// checked; call this on it, or deserialise through [`Event`] instead.
pub fn check_constraints(event: &BusEvent) -> Result<(), ConstraintError> {
    use BusEvent::{
        AgentRegistered, AgentRun, AgentState, Attention, AttentionAcked, AttentionAnswered,
        HookBusy, HookIdle, Progress, QueueItem, Usage,
    };
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
        | AttentionAnswered {
            agent_id, run_id, ..
        }
        | AttentionAcked {
            agent_id, run_id, ..
        }
        | Usage {
            agent_id, run_id, ..
        }
        | QueueItem {
            agent_id, run_id, ..
        }
        | AgentRegistered {
            agent_id, run_id, ..
        }
        | AgentState {
            agent_id, run_id, ..
        }
        | AgentRun {
            agent_id, run_id, ..
        } => (
            agent_id.as_ref().map(|v| v.as_str()),
            run_id.as_ref().map(|v| v.as_str()),
        ),
    };
    let mut texts: Vec<(&'static str, &str)> = Vec::new();
    texts.extend(agent_id.map(|v| ("agentId", v)));
    texts.extend(run_id.map(|v| ("runId", v)));
    match event {
        HookIdle { data, .. } | HookBusy { data, .. } => {
            texts.extend(data.model.as_ref().map(|v| ("data.model", v.as_str())));
            texts.extend(data.session_id.as_deref().map(|v| ("data.sessionId", v)));
        }
        Progress { data, .. } => {
            texts.push(("data.line", data.line.as_str()));
            texts.push(("data.agent", data.agent.as_str()));
            if data.fields.len() > 32 {
                return Err(ConstraintError::OutOfRange {
                    field: "data.fields",
                    rule: "at most 32 entries",
                });
            }
            for (key, value) in &data.fields {
                texts.push(("data.fields", key.as_str()));
                if let ProgressDataFieldsValue::String(v) = value {
                    texts.push(("data.fields", v.as_str()));
                }
            }
        }
        Attention { data, .. } => {
            texts.push(("data.kind", data.kind.as_str()));
            texts.push(("data.summary", data.summary.as_str()));
            texts.extend(
                data.question
                    .as_ref()
                    .map(|v| ("data.question", v.as_str())),
            );
            texts.extend(
                data.checkout
                    .as_ref()
                    .map(|v| ("data.checkout", v.as_str())),
            );
            if data.options.len() > 16 {
                return Err(ConstraintError::OutOfRange {
                    field: "data.options",
                    rule: "at most 16 entries",
                });
            }
            for option in &data.options {
                texts.push(("data.options", option.as_str()));
            }
        }
        AttentionAnswered { data, .. } => {
            // `data.id >= 1` is carried by the generated `NonZeroU64`.
            texts.push(("data.text", data.text.as_str()));
            texts.push(("data.by", data.by.as_str()));
        }
        AttentionAcked { data, .. } => {
            // `data.id >= 1` is carried by the generated `NonZeroU64`.
            texts.extend(data.by.as_ref().map(|v| ("data.by", v.as_str())));
        }
        Usage { data, .. } => {
            if data.context_tokens < 0 {
                return Err(ConstraintError::OutOfRange {
                    field: "data.contextTokens",
                    rule: ">= 0",
                });
            }
            if data.cost_usd.is_some_and(|c| c.is_nan() || c < 0.0) {
                return Err(ConstraintError::OutOfRange {
                    field: "data.costUsd",
                    rule: ">= 0",
                });
            }
            texts.extend(data.model.as_ref().map(|v| ("data.model", v.as_str())));
        }
        AgentRegistered { data, .. } => {
            texts.push(("data.role", data.role.as_str()));
            texts.push(("data.cli", data.cli.as_str()));
            texts.extend(data.model.as_ref().map(|v| ("data.model", v.as_str())));
        }
        // Closed enum, nothing free-form to check.
        AgentState { .. } => {}
        AgentRun { data, .. } => {
            if data.depth.get() > 8 {
                return Err(ConstraintError::OutOfRange {
                    field: "data.depth",
                    rule: "1..=8",
                });
            }
            if data.duration_ms.is_some_and(|d| d < 0) {
                return Err(ConstraintError::OutOfRange {
                    field: "data.durationMs",
                    rule: ">= 0",
                });
            }
            texts.push(("data.runAgentId", data.run_agent_id.as_str()));
            texts.extend(
                data.parent_agent_id
                    .as_ref()
                    .map(|v| ("data.parentAgentId", v.as_str())),
            );
            texts.extend(
                data.tool_use_id
                    .as_ref()
                    .map(|v| ("data.toolUseId", v.as_str())),
            );
            texts.push(("data.agentType", data.agent_type.as_str()));
            texts.extend(
                data.description
                    .as_ref()
                    .map(|v| ("data.description", v.as_str())),
            );
            texts.extend(data.model.as_ref().map(|v| ("data.model", v.as_str())));
            texts.extend(data.summary.as_ref().map(|v| ("data.summary", v.as_str())));
        }
        QueueItem { data, .. } => {
            if data.exit_code.is_some_and(|c| !(0..=3).contains(&c)) {
                return Err(ConstraintError::OutOfRange {
                    field: "data.exitCode",
                    rule: "0..=3",
                });
            }
            if data.duration_ms.is_some_and(|d| d < 0) {
                return Err(ConstraintError::OutOfRange {
                    field: "data.durationMs",
                    rule: ">= 0",
                });
            }
            let coupled = match data.state {
                QueueItemDataState::Started => {
                    data.exit_code.is_none() && data.duration_ms.is_none()
                }
                QueueItemDataState::Exited => data.exit_code.is_some(),
            };
            if !coupled {
                return Err(ConstraintError::QueueItemState);
            }
            texts.extend(data.mode.as_ref().map(|v| ("data.mode", v.as_str())));
        }
    }
    match texts
        .into_iter()
        .find(|(_, text)| text.chars().any(is_forbidden_char))
    {
        Some((field, _)) => Err(ConstraintError::ForbiddenCharacter { field }),
        None => Ok(()),
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
