# Changelog

All notable changes to GravionLabs/dromos are documented here.
Versioning follows [Semantic Versioning](https://semver.org/).

---

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



