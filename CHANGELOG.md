# Changelog

All notable changes to GravionLabs/dromos are documented here.
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.1.3] — 2026-10-27

### Documentation
- Decision record, dromos owns control flow and apm-hub is content (#237)
- Spike measurement and harness decision (#217) (#241)


### Features
- Add kind filter to GET /events (#136) (#203)
- Harness interface, phase events and runner config (#214) (#238)
- Permission callback with allowlist and git guardrails (#215) (#239)
- Spike command, implement one Task through the harness CLIs (#216) (#240)
- Claude adapter on the Claude Agent SDK (#218) (#242)
- Copilot CLI usage parsing and per-harness models (#219) (#243)
- Run state machine for one PBI with bounded rounds (#220) (#244)
- Worktree, branch and PBI claim per run, GitHub access in one module (#221) (#245)
- Implementer phase with parallel Tasks and related tests (#222) (#246)
- Reviewer phase, one fix round, PR (#223) (#249)


## [0.1.2] — 2026-10-27

### Documentation
- Feature #12 is closed
- **roadmap**: Add Stage 7 self-learning (#159)
- Re-scope ROADMAP and README to bus core, park dromos-mux
- Update CHANGELOG.md for v0.1.2 [skip ci]


### Features
- Add GET /events query API (#135) (#176)
- Add optional kind and fields to progress events (#136) (#177)
- Add run metrics routes (#137) (#181)
- Add attention state and answer endpoint (#138) (#188)
- Emit run, gate, review and attention events (#44) (#197)
- Add dromos run export for json and mermaid (#113) (#198)
- Add typed task message payload (#130) (#199)
- Add dromos cli serve subcommand (#32) (#200)
- Add events cli subcommand (#135) (#201)


## [0.1.1] — 2026-10-25

### Documentation
- Add what apm-hub's self-learning workflow needs from dromos
- Align ROADMAP.md with v0.1.0 and the milestones
- Update CHANGELOG.md for v0.1.1 [skip ci]


## [0.1.0] — 2026-10-25

### Bug Fixes
- Address review findings (#14)
- Address re-review advisories (#14)
- Address review advisories (#15)
- Address review findings (#16)
- Address re-review findings (#16)
- Address round 3 review advisories (#16)
- Address round 4 review advisories (#16)
- Address round 5 review advisories (#16)
- Address round 6 review advisories (#16)
- Address round 7 review advisories (#16)
- Address review advisories (#38)
- Address review advisories (#39)
- Address review advisories (#39)
- Address review advisories (#39)
- Address review advisories (#39)
- Make runGate tail test independent of stream order (#147) (#148)


### Documentation
- Make terminal choice explicit, WezTerm optional
- Add ROADMAP.md with stages, dependencies and the session API (#61)
- Rename agent-bus to dromos in ROADMAP.md (#70)
- Rewrite README for dromos
- Add stage 2b (history and attention for unattended apm-hub loops) to ROADMAP.md (#139)
- Update CHANGELOG.md for v0.1.0 [skip ci]


### Features
- Scaffold TypeScript MCP server with streamable HTTP transport (#3)
- Add shared Zod schemas module (#4)
- Load configuration with defaults from agent-bus.config.json (#5)
- Add SQLite persistence layer with migrations (#6)
- Bind MCP sessions to roles and add requireRole helper (#8)
- Add post and ack messaging tools (#9)
- Add inbox long-poll tool (#10)
- Add /events endpoint and human-readable bus log (#11)
- Add run state machine (#13)
- Add orchestrator-only start_run tool (#14)
- Add deterministic gate runner with stack auto-detection (#15)
- Add submit_implementation tool with background gate (#16)
- Add Zod BusEvent union, schema export and TS fixtures (#39)
- Add submit_review tool with verdict routing (#17) (#110)
- Add external event types and free-form source (#39) (#111)
- Add agent instances instead of fixed role enum (#41) (#120)
- Add events stream sse endpoint with resume (#42) (#121)
- Add POST /ingest for external sources (#43) (#123)
- Start_run worktree under repo .worktrees dir (#80) (#129)
- Validate busevent payloads before storing (#42) (#140)
- Write apm-hub compatible checkout lease in start_run (#126) (#146)
- Name start_run branch <type>/<issue>-<slug> (#127) (#149)
- Add orchestrator-only open_pr tool (#18) (#154)
- Add status tool (#19) (#155)


### Refactoring
- Rename code and config from agent-bus to dromos (#71) (#128)



