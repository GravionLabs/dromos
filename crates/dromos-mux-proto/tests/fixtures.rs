//! Serde round-trip of every bus event fixture in `schema/fixtures/`.

use std::fs;
use std::path::{Path, PathBuf};

use dromos_mux_proto::{BusEvent, HookEventCli, HookEventRole, HookEventState};
use serde_json::{Value, json};

fn fixture_paths() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/fixtures");
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap();
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn fixtures_exist() {
    assert!(
        !fixture_paths().is_empty(),
        "schema/fixtures has no *.json files"
    );
}

#[test]
fn every_fixture_round_trips_through_bus_event() {
    for path in fixture_paths() {
        let input = read_json(&path);
        let event: BusEvent = serde_json::from_value(input.clone())
            .unwrap_or_else(|e| panic!("{} does not parse as BusEvent: {e}", path.display()));
        let output = serde_json::to_value(&event).unwrap();
        assert_eq!(output, input, "{} changed on round-trip", path.display());
    }
}

#[test]
fn hook_idle_fixture_maps_to_hook_idle_variant() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/fixtures/hook-idle.json");
    let BusEvent::HookIdle {
        id,
        at,
        agent_id,
        issue,
        run_id,
        data,
        ..
    } = serde_json::from_value(read_json(&path)).unwrap()
    else {
        panic!("hook-idle.json did not map to BusEvent::HookIdle");
    };
    assert_eq!(id, 41);
    assert_eq!(at.as_str(), "2026-10-22T09:15:30.000Z");
    assert_eq!(agent_id.as_deref(), Some("implementer-1"));
    assert_eq!(issue, Some(39));
    assert_eq!(run_id, None);
    assert_eq!(data.role, HookEventRole::Implementer);
    assert_eq!(data.cli, HookEventCli::Claude);
    assert_eq!(data.state, HookEventState::Idle);
    assert_eq!(
        data.model.as_deref().map(String::as_str),
        Some("claude-sonnet-5-5")
    );
    assert_eq!(data.session_id.as_deref(), Some("sess-7f3a"));
}

#[test]
fn hook_busy_fixture_maps_to_hook_busy_variant() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/fixtures/hook-busy.json");
    let event: BusEvent = serde_json::from_value(read_json(&path)).unwrap();
    assert!(matches!(event, BusEvent::HookBusy { id: 42, .. }));
}

fn valid_event() -> Value {
    json!({
        "id": 1,
        "type": "hook:idle",
        "at": "2026-10-22T09:15:30Z",
        "source": "orchestrator",
        "agentId": null,
        "issue": null,
        "runId": null,
        "data": { "role": "orchestrator", "cli": "claude", "state": "idle" }
    })
}

fn parse(value: Value) -> Result<BusEvent, serde_json::Error> {
    serde_json::from_value(value)
}

#[test]
fn accepts_minimal_event_with_null_metadata() {
    let event = parse(valid_event()).unwrap();
    assert_eq!(serde_json::to_value(&event).unwrap(), valid_event());
}

#[test]
fn rejects_missing_nullable_field() {
    let mut event = valid_event();
    event.as_object_mut().unwrap().remove("agentId");
    assert!(parse(event).is_err());
}

#[test]
fn rejects_unknown_field() {
    let mut event = valid_event();
    event["extra"] = json!(true);
    assert!(parse(event).is_err());
}

#[test]
fn rejects_timestamp_without_utc_suffix() {
    let mut event = valid_event();
    event["at"] = json!("2026-10-22T09:15:30+02:00");
    assert!(parse(event).is_err());
}

#[test]
fn rejects_impossible_date() {
    let mut event = valid_event();
    event["at"] = json!("2026-02-29T00:00:00Z");
    assert!(parse(event).is_err());
}

#[test]
fn rejects_empty_model() {
    let mut event = valid_event();
    event["data"]["model"] = json!("");
    assert!(parse(event).is_err());
}

#[test]
fn rejects_unknown_enum_value() {
    let mut event = valid_event();
    event["data"]["cli"] = json!("gemini");
    assert!(parse(event).is_err());
}

mod event_wrapper {
    use super::*;
    use dromos_mux_proto::{Event, KNOWN_TYPES};

    fn hook_idle() -> Value {
        read_json(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/fixtures/hook-idle.json"),
        )
    }

    #[test]
    fn every_fixture_is_known_and_round_trips() {
        for path in fixture_paths() {
            let input = read_json(&path);
            let event: Event = serde_json::from_value(input.clone()).unwrap();
            assert!(
                matches!(event, Event::Known(_)),
                "{} is not Known",
                path.display()
            );
            assert_eq!(serde_json::to_value(&event).unwrap(), input);
        }
    }

    #[test]
    fn known_types_match_fixture_types() {
        let mut fixture_types: Vec<String> = fixture_paths()
            .iter()
            .map(|p| read_json(p)["type"].as_str().unwrap().to_owned())
            .collect();
        fixture_types.sort();
        let mut known: Vec<String> = KNOWN_TYPES.iter().map(|s| (*s).to_owned()).collect();
        known.sort();
        assert_eq!(fixture_types, known);
    }

    #[test]
    fn unknown_type_maps_to_unknown_and_round_trips_unchanged() {
        let input = json!({"type": "future.thing", "id": 7, "extra": {"a": [1, 2, null]}});
        let event: Event = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(
            event,
            Event::Unknown {
                event_type: "future.thing".into(),
                raw: input.clone()
            }
        );
        assert_eq!(serde_json::to_value(&event).unwrap(), input);
        let text = serde_json::to_string(&event).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), input);
    }

    #[test]
    fn known_type_with_invalid_data_fails() {
        let mut input = hook_idle();
        input["data"] = json!("not an object");
        assert!(serde_json::from_value::<Event>(input).is_err());
    }

    #[test]
    fn known_type_with_unknown_field_fails() {
        let mut input = hook_idle();
        input["surprise"] = json!(true);
        assert!(serde_json::from_value::<Event>(input).is_err());
    }

    #[test]
    fn missing_type_fails() {
        let mut input = hook_idle();
        input.as_object_mut().unwrap().remove("type");
        assert!(serde_json::from_value::<Event>(input).is_err());
    }

    #[test]
    fn non_string_type_fails() {
        assert!(serde_json::from_value::<Event>(json!({"type": 5})).is_err());
    }

    #[test]
    fn non_object_input_fails() {
        assert!(serde_json::from_value::<Event>(json!([1, 2])).is_err());
    }
}
