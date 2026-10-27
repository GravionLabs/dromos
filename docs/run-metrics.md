# Run metrics

The JSON contract of the run metrics, for apm-hub P4. Source: `src/run-metrics.ts`.

Two entry points return the same data:

- `dromos run metrics [--issues <n,…>] [--since <date>] [--format json|table]`: needs `--issues` or `--since`; `--format` defaults to `json`. Exit code 2 on a bad argument.
- `GET /runs/{issue}/metrics?since=&until=`: one `RunMetrics`. `GET /runs/metrics?issues=1,2,3` or `?since=[&until=]`: `{ runs, aggregate }`.

The JSON of the CLI is the body of `GET /runs/metrics`: `{ "runs": RunMetrics[], "aggregate": RunMetricsAggregate }`. Fields are only ever added; existing ones keep their meaning. A value that was not measured is `null` (never estimated); a count is `0`.

## Source events

| Metric | Event |
| --- | --- |
| duration, usage per phase | `phase.finished`, `phase.failed` (`durationMs`, `usage`) |
| unanswered questions | `phase.finished` `unansweredQuestions` (planner) |
| fix rounds | `outcome.fixRound` |
| findings | `outcome.finding` (`fingerprint`) |
| blocked | `run.state` with `state: "blocked"`, or `attempt.settled` with `outcome: "blocked"` |
| progress, attention, agents, `usage` events | as before |

## RunMetrics

```jsonc
{
  "issue": 7,
  "events": 42,
  "progress": { "byKind": { "phase": 2 } },
  "attention": { "byKind": { "GATE": 1 } },
  "usage": {
    "tokensIn": 1100,            // sum over phases that reported usage, else null
    "tokensOut": 210,
    "usd": 0.5,                  // usage events if any, else the sum of phase costUsd, else null
    "measured": true,
    "byRole": {                  // role = phase name (planner, implementer, reviewer, ...)
      "planner": { "phases": 1, "inputTokens": 100, "outputTokens": 10, "usd": 0.5 }
    }
  },
  "durations": {
    "firstAt": "2026-01-01T00:00:00.000Z",
    "lastAt": "2026-01-01T00:06:00.000Z",
    "seconds": 360,
    "phases": { "implementer": 150, "planner": 60 }   // seconds; absent without phases
  },
  "agents": [{ "agentId": "impl-1", "role": "implementer", "events": 3 }],
  "fixRounds": 1,
  "blocked": true,
  "unansweredQuestions": 2,
  "findings": { "total": 3, "fingerprints": { "<sha1>": 2 } }
}
```

`durations.phases` sums `durationMs` of the `phase.*` events per phase name; without them it falls back to the time between `progress` phase markers.

## RunMetricsAggregate

Computed over the runs that have events.

```jsonc
{
  "runs": 2,
  "events": 50,
  "progress": { "byKind": {} },
  "attention": { "byKind": {} },
  "usage": { "usd": 1.5, "measured": true, "byRole": { "planner": { "phases": 1, "inputTokens": 100, "outputTokens": 10, "usd": 0.5 } } },
  "durations": { "seconds": 440, "phases": { "planner": 60 } },
  "mean": { "seconds": 220, "events": 25, "usd": 1.5 },   // usd mean over measured runs only
  "fixRounds": 1,
  "blockedRuns": 1,
  "unansweredQuestions": 2,
  "repeatedFindings": [{ "fingerprint": "<sha1>", "runs": [1, 2], "count": 4 }]
}
```

`repeatedFindings` lists fingerprints (sha1 over file, rule and title) reported in two or more runs, most runs first.
