//! Serde round-trip of every bus event fixture in `schema/fixtures/`.

use std::fs;
use std::path::{Path, PathBuf};

use dromos_mux_proto::{BUS_EVENT_TYPES, BusEvent, HookEventCli, HookEventRole, HookEventState};
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
    assert_eq!(agent_id.as_ref().map(|v| v.as_str()), Some("implementer-1"));
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

fn fixture(name: &str) -> Value {
    read_json(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../schema/fixtures")
            .join(name),
    )
}

#[test]
fn external_fixtures_map_to_their_variants() {
    let load = |name: &str| parse(fixture(name)).unwrap();
    assert!(matches!(load("progress.json"), BusEvent::Progress { .. }));
    assert!(matches!(load("attention.json"), BusEvent::Attention { .. }));
    assert!(matches!(load("usage.json"), BusEvent::Usage { .. }));
    assert!(matches!(
        load("queue-item.json"),
        BusEvent::QueueItem { .. }
    ));
}

#[test]
fn accepts_free_form_source_and_rejects_malformed() {
    let mut event = valid_event();
    event["source"] = json!("apm-hub/subagent-stop");
    assert!(parse(event.clone()).is_ok());
    event["source"] = json!("a".repeat(128));
    assert!(parse(event.clone()).is_ok());
    for bad in ["", "Apm Hub", "1abc", &"a".repeat(129)] {
        event["source"] = json!(bad);
        assert!(parse(event.clone()).is_err(), "{bad:?}");
    }
}

fn remove_data(event: &mut Value, key: &str) {
    event["data"].as_object_mut().unwrap().remove(key);
}

/// Every mutation must be rejected by `Event`, which also enforces what the generated types
/// cannot (numeric bounds, control characters, queue.item coupling).
fn assert_rejected(name: &str, mutate: impl Fn(&mut Value), label: &str) {
    let mut event = fixture(name);
    mutate(&mut event);
    assert!(
        serde_json::from_value::<dromos_mux_proto::Event>(event).is_err(),
        "{name}: {label} was accepted"
    );
}

#[test]
fn rejects_invalid_progress_data() {
    let p = "progress.json";
    assert_rejected(p, |e| e["data"]["extra"] = json!(1), "extra key");
    assert_rejected(p, |e| e["data"]["line"] = json!(""), "empty line");
    assert_rejected(
        p,
        |e| e["data"]["line"] = json!("x".repeat(1001)),
        "long line",
    );
    assert_rejected(
        p,
        |e| e["data"]["line"] = json!("a\u{1b}[31mred"),
        "ANSI escape",
    );
    assert_rejected(
        p,
        |e| e["data"]["agent"] = json!("x".repeat(65)),
        "long agent",
    );
    assert_rejected(p, |e| remove_data(e, "agent"), "missing agent");
    assert_rejected(p, |e| e["data"]["agent"] = Value::Null, "null agent");
    assert_rejected(p, |e| e["agentId"] = json!("x".repeat(129)), "long agentId");
    assert_rejected(p, |e| e["runId"] = json!(""), "empty runId");
}

#[test]
fn rejects_invalid_attention_data() {
    let a = "attention.json";
    assert_rejected(a, |e| e["data"]["kind"] = json!("DONE"), "unknown kind");
    assert_rejected(a, |e| e["data"]["summary"] = json!(""), "empty summary");
    assert_rejected(
        a,
        |e| e["data"]["summary"] = json!("x".repeat(2001)),
        "long summary",
    );
    assert_rejected(
        a,
        |e| e["data"]["summary"] = json!("line\nbreak"),
        "newline",
    );
    assert_rejected(a, |e| e["data"]["pr"] = json!(1.5), "fractional pr");
    assert_rejected(a, |e| remove_data(e, "pr"), "missing pr");
}

#[test]
fn rejects_invalid_usage_data() {
    let u = "usage.json";
    assert_rejected(
        u,
        |e| e["data"]["contextTokens"] = json!(-1),
        "negative tokens",
    );
    assert_rejected(u, |e| e["data"]["costUsd"] = json!(-0.01), "negative cost");
    assert_rejected(u, |e| e["data"]["model"] = json!(""), "empty model");
    assert_rejected(
        u,
        |e| e["data"]["model"] = json!("x".repeat(129)),
        "long model",
    );
    assert_rejected(u, |e| remove_data(e, "costUsd"), "missing cost");
    assert_rejected(
        u,
        |e| e["data"]["contextTokens"] = Value::Null,
        "null tokens",
    );
}

#[test]
fn rejects_invalid_queue_item_data() {
    let q = "queue-item.json";
    assert_rejected(q, |e| e["data"]["exitCode"] = json!(4), "exit code 4");
    assert_rejected(q, |e| e["data"]["exitCode"] = json!(-1), "exit code -1");
    assert_rejected(
        q,
        |e| e["data"]["durationMs"] = json!(-1),
        "negative duration",
    );
    assert_rejected(
        q,
        |e| e["data"]["state"] = json!("running"),
        "unknown state",
    );
    assert_rejected(
        q,
        |e| e["data"]["mode"] = json!("x".repeat(65)),
        "long mode",
    );
    assert_rejected(
        q,
        |e| e["data"]["exitCode"] = Value::Null,
        "exited without exit code",
    );
    assert_rejected(
        q,
        |e| e["data"]["state"] = json!("started"),
        "started with a result",
    );
    assert_rejected(q, |e| remove_data(e, "mode"), "missing mode");
}

#[test]
fn accepts_boundary_values_and_started_item() {
    use dromos_mux_proto::Event;
    let ok = |name: &str, mutate: &dyn Fn(&mut Value)| {
        let mut event = fixture(name);
        mutate(&mut event);
        serde_json::from_value::<Event>(event).unwrap();
    };
    ok("usage.json", &|e| {
        e["data"]["contextTokens"] = json!(0);
        e["data"]["costUsd"] = json!(0.0);
    });
    ok("queue-item.json", &|e| e["data"]["exitCode"] = json!(3));
    ok("queue-item.json", &|e| {
        e["data"]["state"] = json!("started");
        e["data"]["exitCode"] = Value::Null;
        e["data"]["durationMs"] = Value::Null;
    });
    ok("progress.json", &|e| {
        e["data"]["line"] = json!("x".repeat(1000))
    });
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

#[test]
fn rejects_fractional_id() {
    let mut event = valid_event();
    event["id"] = json!(1.5);
    assert!(parse(event).is_err());
}

#[test]
fn rejects_string_id() {
    let mut event = valid_event();
    event["id"] = json!("1");
    assert!(parse(event).is_err());
}

#[test]
fn rejects_null_id() {
    let mut event = valid_event();
    event["id"] = Value::Null;
    assert!(parse(event).is_err());
}

#[test]
fn rejects_id_beyond_i64() {
    let mut event = valid_event();
    event["id"] = json!(9_223_372_036_854_775_808_u64);
    assert!(parse(event).is_err());
}

#[test]
fn accepts_largest_safe_integer_id_and_issue() {
    let mut event = valid_event();
    event["id"] = json!(9_007_199_254_740_991_i64);
    event["issue"] = json!(-9_007_199_254_740_991_i64);
    let parsed = parse(event.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), event);
}

/// Documented asymmetry (see the crate docs): the schema bounds ids to ±2^53-1, the generated
/// `i64` does not. Fails if the bound starts being enforced, so the docs get updated with it.
#[test]
fn accepts_id_beyond_safe_integer_range() {
    let mut event = valid_event();
    event["id"] = json!(9_007_199_254_740_992_i64);
    assert!(parse(event).is_ok());
}

#[test]
fn bus_event_types_match_generated_enum_tags() {
    // serde lists every variant tag of the internally tagged enum in its unknown-variant error.
    let err = parse(json!({"type": "__probe__"})).unwrap_err().to_string();
    // Same wording as serde's `OneOf` display: "expected `a`", "`a` or `b`", "one of `a`, ...".
    let tags: Vec<String> = BUS_EVENT_TYPES.iter().map(|t| format!("`{t}`")).collect();
    let expected = match tags.as_slice() {
        [one] => one.clone(),
        [a, b] => format!("{a} or {b}"),
        all => format!("one of {}", all.join(", ")),
    };
    assert!(
        err.ends_with(&format!("expected {expected}")),
        "BUS_EVENT_TYPES {BUS_EVENT_TYPES:?} differs from the BusEvent tags: {err}"
    );
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
    fn known_type_tags_are_case_sensitive() {
        for tag in ["HOOK:IDLE", "Hook:Idle", "hook:Idle", " hook:idle"] {
            let mut input = hook_idle();
            input["type"] = json!(tag);
            let event: Event = serde_json::from_value(input.clone()).unwrap();
            assert_eq!(
                event,
                Event::Unknown {
                    event_type: tag.into(),
                    raw: input
                },
                "{tag:?}"
            );
        }
    }

    #[test]
    fn unknown_type_without_envelope_is_accepted() {
        let input = json!({"type": "future.thing"});
        let event: Event = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(
            event,
            Event::Unknown {
                event_type: "future.thing".into(),
                raw: input
            }
        );
    }

    #[test]
    fn empty_type_is_unknown() {
        let event: Event = serde_json::from_value(json!({"type": ""})).unwrap();
        assert!(matches!(event, Event::Unknown { ref event_type, .. } if event_type.is_empty()));
    }

    #[test]
    fn bus_event_rejects_unknown_type() {
        let mut input = hook_idle();
        input["type"] = json!("future.thing");
        let err = serde_json::from_value::<BusEvent>(input).unwrap_err();
        assert!(
            err.to_string().contains("unknown variant `future.thing`"),
            "{err}"
        );
    }

    #[test]
    fn known_types_are_the_generated_tags() {
        assert_eq!(
            KNOWN_TYPES,
            [
                "hook:idle",
                "hook:busy",
                "progress",
                "attention",
                "usage",
                "queue.item"
            ]
        );
    }

    #[test]
    fn non_object_input_fails() {
        assert!(serde_json::from_value::<Event>(json!([1, 2])).is_err());
    }
}
