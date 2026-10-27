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
    assert!(matches!(
        load("attention-question.json"),
        BusEvent::Attention { .. }
    ));
    assert!(matches!(
        load("attention-answered.json"),
        BusEvent::AttentionAnswered { .. }
    ));
    assert!(matches!(
        load("attention-acked.json"),
        BusEvent::AttentionAcked { .. }
    ));
    assert!(matches!(load("usage.json"), BusEvent::Usage { .. }));
    assert!(matches!(
        load("queue-item.json"),
        BusEvent::QueueItem { .. }
    ));
    assert!(matches!(load("agent-run.json"), BusEvent::AgentRun { .. }));
    assert!(matches!(load("run-state.json"), BusEvent::RunState { .. }));
    assert!(matches!(
        load("gate-result.json"),
        BusEvent::GateResult { .. }
    ));
    assert!(matches!(
        load("gate-result-failed.json"),
        BusEvent::GateResult { .. }
    ));
    assert!(matches!(
        load("review-result.json"),
        BusEvent::ReviewResult { .. }
    ));
    assert!(matches!(
        load("attempt-started.json"),
        BusEvent::AttemptStarted { .. }
    ));
    assert!(matches!(
        load("attempt-settled.json"),
        BusEvent::AttemptSettled { .. }
    ));
    assert!(matches!(
        load("agent-state-last-output.json"),
        BusEvent::AgentState { .. }
    ));
}

#[test]
fn workflow_fixtures_carry_their_values() {
    let BusEvent::GateResult { data, .. } = parse(fixture("gate-result-failed.json")).unwrap()
    else {
        panic!("gate-result-failed.json did not map to BusEvent::GateResult");
    };
    assert!(!data.passed);
    assert_eq!(
        data.failed_step.as_deref().map(String::as_str),
        Some("test")
    );
    assert_eq!(data.steps.len(), 2);
    assert_eq!(data.steps[1].exit_code, 1);
    assert_eq!(
        serde_json::to_value(data.evidence).unwrap(),
        json!("verified")
    );

    let BusEvent::AgentState { data, .. } = parse(fixture("agent-state-last-output.json")).unwrap()
    else {
        panic!("agent-state-last-output.json did not map to BusEvent::AgentState");
    };
    assert_eq!(
        data.last_output_at.as_deref().map(String::as_str),
        Some("2026-10-26T10:00:04.000Z")
    );
}

#[test]
fn rejects_invalid_workflow_event_data() {
    let g = "gate-result.json";
    assert_rejected(g, "negative duration", "data.durationMs", |e| {
        e["data"]["durationMs"] = json!(-1);
    });
    assert_rejected(g, "negative step duration", "data.steps.durationMs", |e| {
        e["data"]["steps"][0]["durationMs"] = json!(-1);
    });
    assert_rejected(g, "33 steps", "at most 32", |e| {
        e["data"]["steps"] = (0..33)
            .map(|i| json!({"name": format!("s{i}"), "exitCode": 0, "durationMs": 1}))
            .collect();
    });
    assert_accepted(g, "32 steps", |e| {
        e["data"]["steps"] = (0..32)
            .map(|i| json!({"name": format!("s{i}"), "exitCode": 0, "durationMs": 1}))
            .collect();
    });
    assert_rejected(g, "escape in step name", "data.steps.name", |e| {
        e["data"]["steps"][0]["name"] = json!("a\u{1b}[31m");
    });
    assert_rejected(g, "bidi in failedStep", "data.failedStep", |e| {
        e["data"]["failedStep"] = json!("a\u{202e}");
    });
    assert_field_rejected(g, "round 0", "data.round", Edit::Set(json!(0)));
    assert_field_rejected(
        g,
        "unknown tier",
        "data.evidence",
        Edit::Set(json!("guessed")),
    );
    assert_field_rejected(g, "extra key", "data.extra", Edit::Set(json!(1)));
    assert_field_rejected(
        g,
        "long failedStep",
        "data.failedStep",
        Edit::Set(json!("x".repeat(129))),
    );

    let r = "review-result.json";
    assert_rejected(r, "negative findings", "data.findings", |e| {
        e["data"]["findings"] = json!(-1);
    });
    assert_rejected(r, "negative blocking", "data.blockingFindings", |e| {
        e["data"]["blockingFindings"] = json!(-1);
    });
    assert_field_rejected(
        r,
        "verdict reject",
        "data.verdict",
        Edit::Set(json!("reject")),
    );

    let s = "run-state.json";
    assert_field_rejected(s, "unknown state", "data.state", Edit::Set(json!("done")));
    assert_accepted(s, "null previous", |e| e["data"]["previous"] = Value::Null);

    assert_field_rejected(
        "attempt-started.json",
        "unknown cause",
        "data.cause",
        Edit::Set(json!("retry")),
    );
    assert_field_rejected("attempt-started.json", "n 0", "data.n", Edit::Set(json!(0)));
    assert_field_rejected(
        "attempt-settled.json",
        "unknown outcome",
        "data.outcome",
        Edit::Set(json!("initial")),
    );
    assert_field_rejected(
        "attempt-settled.json",
        "missing evidence",
        "data.evidence",
        Edit::Remove,
    );
    assert_field_rejected(
        "agent-state.json",
        "date-only lastOutputAt",
        "data.lastOutputAt",
        Edit::Set(json!("2026-10-26")),
    );
}

#[test]
fn rejects_invalid_agent_run_data() {
    let a = "agent-run.json";
    assert_field_rejected(a, "depth 0", "data.depth", Edit::Set(json!(0)));
    assert_field_rejected(a, "depth 9", "data.depth", Edit::Set(json!(9)));
    assert_field_rejected(a, "state done", "data.state", Edit::Set(json!("done")));
    assert_field_rejected(a, "extra key", "data.extra", Edit::Set(json!(1)));
    assert_field_rejected(
        a,
        "negative duration",
        "data.durationMs",
        Edit::Set(json!(-1)),
    );
    assert_field_rejected(
        a,
        "newline in summary",
        "data.summary",
        Edit::Set(json!("a\nb")),
    );
    assert_accepted(a, "empty description", |e| {
        e["data"]["description"] = json!("")
    });
    assert_accepted(a, "root run", |e| {
        e["data"]["parentAgentId"] = Value::Null;
        e["data"]["depth"] = json!(1);
    });
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

fn event_from(name: &str, mutate: impl Fn(&mut Value)) -> Result<dromos_mux_proto::Event, String> {
    let mut event = fixture(name);
    mutate(&mut event);
    serde_json::from_value::<dromos_mux_proto::Event>(event).map_err(|e| e.to_string())
}

/// `Event` (not the bare `BusEvent`) must accept the mutated fixture.
fn assert_accepted(name: &str, label: &str, mutate: impl Fn(&mut Value)) {
    if let Err(e) = event_from(name, mutate) {
        panic!("{name}: {label} was rejected: {e}");
    }
}

/// `Event` must reject the mutated fixture with an error containing `expected`. Only for messages
/// this crate writes itself (the `queue.item` state coupling); library wording is never asserted.
fn assert_rejected(name: &str, label: &str, expected: &str, mutate: impl Fn(&mut Value)) {
    match event_from(name, mutate) {
        Ok(_) => panic!("{name}: {label} was accepted"),
        Err(e) => assert!(
            e.contains(expected),
            "{name}: {label} failed with `{e}`, expected it to contain `{expected}`"
        ),
    }
}

/// What a single-field rejection case does to the field at its path.
enum Edit {
    Set(Value),
    Remove,
}

/// `Event` must reject the fixture once only the field at `path` (`data.line`, `agentId`) is
/// edited. The fixture itself parses, so the rejection is caused by that field. The message is
/// not matched against serde or typify wording (it changes across upgrades); it must be non-empty
/// and, when it names a field (`data.<key>` or ``field `<key>` ``), it must name this one.
fn assert_field_rejected(name: &str, label: &str, path: &str, edit: Edit) {
    if let Err(e) = event_from(name, |_| {}) {
        panic!("{name}: the unedited fixture must parse, got `{e}`");
    }
    let mut parents: Vec<&str> = path.split('.').collect();
    let key = parents.pop().expect("path has a key");
    let result = event_from(name, |event| {
        let parent = parents.iter().fold(event, |node, p| &mut node[*p]);
        let object = parent
            .as_object_mut()
            .unwrap_or_else(|| panic!("{name}: parent of {path} is not an object"));
        match &edit {
            Edit::Set(value) => {
                object.insert(key.to_owned(), value.clone());
            }
            Edit::Remove => {
                assert!(
                    object.remove(key).is_some(),
                    "{name}: {path} not in fixture"
                );
            }
        }
    });
    let e = match result {
        Ok(_) => panic!("{name}: {label} ({path}) was accepted"),
        Err(e) => e,
    };
    assert!(
        !e.trim().is_empty(),
        "{name}: {label} failed with an empty message"
    );
    if e.contains("data.") || e.contains("field `") {
        assert!(
            e.contains(&format!("`{key}`")) || e.contains(path),
            "{name}: {label} blamed another field than {path}: `{e}`"
        );
    }
}

#[test]
fn progress_kind_fixtures_parse_with_their_kind() {
    for kind in [
        "phase",
        "task",
        "wave",
        "fix-round",
        "ruling",
        "gate",
        "loop",
        "complete",
        "subagent",
        "other",
    ] {
        let input = read_json(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../schema/fixtures/progress-{kind}.json")),
        );
        let BusEvent::Progress { data, .. } = serde_json::from_value(input).unwrap() else {
            panic!("progress-{kind}.json did not map to BusEvent::Progress");
        };
        let wire = serde_json::to_value(data.kind.expect("kind set")).unwrap();
        assert_eq!(wire, json!(kind));
        let fields = serde_json::to_value(&data.fields).unwrap();
        assert_eq!(fields, json!({"ref": "#97", "count": 3.5, "note": null}));
    }
}

#[test]
fn rejects_invalid_progress_data() {
    let p = "progress.json";
    assert_field_rejected(p, "unknown kind", "data.kind", Edit::Set(json!("bogus")));
    assert_field_rejected(p, "non-object fields", "data.fields", Edit::Set(json!([1])));
    assert_field_rejected(
        p,
        "object field value",
        "data.fields",
        Edit::Set(json!({"a": {"n": 1}})),
    );
    assert_field_rejected(
        p,
        "bool field value",
        "data.fields",
        Edit::Set(json!({"a": true})),
    );
    assert_field_rejected(
        p,
        "empty field key",
        "data.fields",
        Edit::Set(json!({"": "x"})),
    );
    assert_field_rejected(
        p,
        "long field value",
        "data.fields",
        Edit::Set(json!({"a": "x".repeat(1001)})),
    );
    assert_field_rejected(
        p,
        "long field key",
        "data.fields",
        Edit::Set(json!({"k".repeat(65): "x"})),
    );
    assert_rejected(p, "33 field entries", "at most 32", |e| {
        let map: serde_json::Map<String, Value> =
            (0..33).map(|i| (format!("k{i}"), json!(i))).collect();
        e["data"]["fields"] = Value::Object(map);
    });
    assert_accepted(p, "32 field entries", |e| {
        let map: serde_json::Map<String, Value> =
            (0..32).map(|i| (format!("k{i}"), json!(i))).collect();
        e["data"]["fields"] = Value::Object(map);
    });
    assert_accepted(p, "empty value and empty map", |e| {
        e["data"]["fields"] = json!({"a": ""});
    });
    assert_rejected(p, "escape in field value", "data.fields", |e| {
        e["data"]["fields"] = json!({"a": "x\u{1b}[31m"});
    });
    assert_rejected(p, "zero-width in field key", "data.fields", |e| {
        e["data"]["fields"] = json!({"a\u{200b}b": "x"});
    });
    assert_field_rejected(p, "extra key", "data.extra", Edit::Set(json!(1)));
    assert_field_rejected(p, "empty line", "data.line", Edit::Set(json!("")));
    assert_field_rejected(
        p,
        "long line",
        "data.line",
        Edit::Set(json!("x".repeat(1001))),
    );
    assert_field_rejected(
        p,
        "ANSI escape",
        "data.line",
        Edit::Set(json!("a\u{1b}[31mred")),
    );
    assert_field_rejected(
        p,
        "long agent",
        "data.agent",
        Edit::Set(json!("x".repeat(65))),
    );
    assert_field_rejected(p, "missing agent", "data.agent", Edit::Remove);
    assert_field_rejected(p, "null agent", "data.agent", Edit::Set(Value::Null));
    assert_field_rejected(
        p,
        "long agentId",
        "agentId",
        Edit::Set(json!("x".repeat(129))),
    );
    assert_field_rejected(p, "empty runId", "runId", Edit::Set(json!("")));
}

#[test]
fn rejects_invalid_attention_data() {
    let a = "attention.json";
    assert_field_rejected(a, "empty kind", "data.kind", Edit::Set(json!("")));
    assert_field_rejected(
        a,
        "long kind",
        "data.kind",
        Edit::Set(json!("x".repeat(65))),
    );
    assert_field_rejected(a, "kind newline", "data.kind", Edit::Set(json!("A\nB")));
    assert_field_rejected(
        a,
        "17 options",
        "data.options",
        Edit::Set(json!(vec!["o"; 17])),
    );
    assert_field_rejected(
        a,
        "option control char",
        "data.options",
        Edit::Set(json!(["a\u{7}"])),
    );
    assert_field_rejected(
        a,
        "checkout esc",
        "data.checkout",
        Edit::Set(json!("/a\u{1b}")),
    );
    assert_field_rejected(
        a,
        "question newline",
        "data.question",
        Edit::Set(json!("a\nb")),
    );
    assert_field_rejected(a, "empty summary", "data.summary", Edit::Set(json!("")));
    assert_field_rejected(
        a,
        "long summary",
        "data.summary",
        Edit::Set(json!("x".repeat(2001))),
    );
    assert_field_rejected(
        a,
        "newline",
        "data.summary",
        Edit::Set(json!("line\nbreak")),
    );
    assert_field_rejected(a, "fractional pr", "data.pr", Edit::Set(json!(1.5)));
    assert_field_rejected(a, "missing pr", "data.pr", Edit::Remove);
}

#[test]
fn accepts_free_form_attention_kind_and_16_options() {
    let mut event = fixture("attention-question.json");
    event["data"]["kind"] = json!("ANYTHING");
    event["data"]["options"] = json!(vec!["o"; 16]);
    assert!(parse(event).is_ok());
}

#[test]
fn rejects_invalid_attention_answered_and_acked() {
    let a = "attention-answered.json";
    assert_field_rejected(a, "id zero", "data.id", Edit::Set(json!(0)));
    assert_field_rejected(a, "empty text", "data.text", Edit::Set(json!("")));
    assert_field_rejected(a, "text newline", "data.text", Edit::Set(json!("a\nb")));
    assert_field_rejected(a, "null by", "data.by", Edit::Set(Value::Null));
    assert_field_rejected(a, "by esc", "data.by", Edit::Set(json!("a\u{1b}")));
    let k = "attention-acked.json";
    assert_field_rejected(k, "id zero", "data.id", Edit::Set(json!(0)));
    assert_field_rejected(k, "by bidi", "data.by", Edit::Set(json!("a\u{202e}")));
    assert_field_rejected(k, "missing by", "data.by", Edit::Remove);
}

#[test]
fn rejects_invalid_usage_data() {
    let u = "usage.json";
    assert_field_rejected(
        u,
        "negative tokens",
        "data.contextTokens",
        Edit::Set(json!(-1)),
    );
    assert_field_rejected(u, "negative cost", "data.costUsd", Edit::Set(json!(-0.01)));
    assert_field_rejected(u, "empty model", "data.model", Edit::Set(json!("")));
    assert_field_rejected(
        u,
        "long model",
        "data.model",
        Edit::Set(json!("x".repeat(129))),
    );
    assert_field_rejected(u, "missing cost", "data.costUsd", Edit::Remove);
    assert_field_rejected(
        u,
        "null tokens",
        "data.contextTokens",
        Edit::Set(Value::Null),
    );
}

#[test]
fn rejects_invalid_queue_item_data() {
    let q = "queue-item.json";
    assert_field_rejected(q, "exit code 4", "data.exitCode", Edit::Set(json!(4)));
    assert_field_rejected(q, "exit code -1", "data.exitCode", Edit::Set(json!(-1)));
    assert_field_rejected(
        q,
        "negative duration",
        "data.durationMs",
        Edit::Set(json!(-1)),
    );
    assert_field_rejected(
        q,
        "unknown state",
        "data.state",
        Edit::Set(json!("running")),
    );
    assert_field_rejected(
        q,
        "long mode",
        "data.mode",
        Edit::Set(json!("x".repeat(65))),
    );
    assert_field_rejected(q, "missing mode", "data.mode", Edit::Remove);
}

#[test]
fn queue_item_state_coupling_cases_are_isolated() {
    let q = "queue-item.json";
    let coupling = "started has no exitCode or durationMs";
    assert_rejected(q, "exited without exitCode", coupling, |e| {
        e["data"]["exitCode"] = Value::Null;
    });
    assert_rejected(q, "started with exitCode only", coupling, |e| {
        e["data"]["state"] = json!("started");
        e["data"]["durationMs"] = Value::Null;
    });
    assert_rejected(q, "started with durationMs only", coupling, |e| {
        e["data"]["state"] = json!("started");
        e["data"]["exitCode"] = Value::Null;
    });
    assert_accepted(q, "exited with null durationMs", |e| {
        e["data"]["durationMs"] = Value::Null;
    });
    assert_accepted(q, "started with nothing", |e| {
        e["data"]["state"] = json!("started");
        e["data"]["exitCode"] = Value::Null;
        e["data"]["durationMs"] = Value::Null;
    });
}

#[test]
fn accepts_boundary_values() {
    assert_accepted("usage.json", "zero usage", |e| {
        e["data"]["contextTokens"] = json!(0);
        e["data"]["costUsd"] = json!(0.0);
    });
    assert_accepted("queue-item.json", "exit code 3", |e| {
        e["data"]["exitCode"] = json!(3);
    });
    assert_accepted("progress.json", "line at the cap", |e| {
        e["data"]["line"] = json!("x".repeat(1000));
    });
    // The cap counts code points, as in the JSON Schema and Zod 4.
    assert_accepted("progress.json", "1000 astral code points", |e| {
        e["data"]["line"] = json!("\u{1F600}".repeat(1000));
    });
}

#[test]
fn bare_bus_event_skips_the_constraint_checks_but_check_constraints_catches_them() {
    let mut input = fixture("queue-item.json");
    input["data"]["exitCode"] = json!(99);
    let bare = parse(input).unwrap();
    assert!(dromos_mux_proto::check_constraints(&bare).is_err());
}

/// Applies a `schema/parity.json` mutation: `{"repeat": [char, n]}` expands to a repeated string.
fn expand(value: &Value) -> Value {
    match value.get("repeat") {
        Some(r) => json!(
            r[0].as_str()
                .unwrap()
                .repeat(r[1].as_u64().unwrap() as usize)
        ),
        None => value.clone(),
    }
}

fn set_path(event: &mut Value, path: &str, value: Value) {
    let mut node = event;
    let mut parts = path.split('.').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            node[part] = value;
            return;
        }
        node = &mut node[part];
    }
}

/// Same cases as `src/events/schema.test.ts`: both languages must agree on every one.
#[test]
fn parity_cases_agree_with_typescript() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/parity.json");
    let cases = read_json(&path);
    let cases = cases["cases"].as_array().unwrap();
    assert!(cases.len() > 100, "parity.json looks truncated");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let valid = case["valid"].as_bool().unwrap();
        let mut event = fixture(case["fixture"].as_str().unwrap());
        for (path, value) in case
            .get("set")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            set_path(&mut event, path, expand(value));
        }
        let result = serde_json::from_value::<dromos_mux_proto::Event>(event);
        assert_eq!(result.is_ok(), valid, "parity case `{name}`: {result:?}");
    }
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
        // `progress-<kind>.json` repeat the `progress` type.
        fixture_types.dedup();
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
                "attention.answered",
                "attention.acked",
                "usage",
                "queue.item",
                "agent.registered",
                "agent.state",
                "agent.run",
                "run.state",
                "gate.result",
                "review.result",
                "attempt.started",
                "attempt.settled"
            ]
        );
    }

    #[test]
    fn non_object_input_fails() {
        assert!(serde_json::from_value::<Event>(json!([1, 2])).is_err());
    }
}
