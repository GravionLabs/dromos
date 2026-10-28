# 002: The bus is the single source of truth

Status: accepted

## Context
Several components (runner, `dromos-mux`, the herdr plugin, apm-hub hooks) produce or show state about agent runs.

## Decision
The bus is the single source of truth for events and history. `dromos-mux` and the herdr plugin never write SQLite and never read ledger files; they talk to the bus only. GitHub stays the source of truth for issue state.

## Rationale
One writer keeps history consistent and avoids races and divergent copies of state.

## Consequences
Clients publish and read through the bus API. Features needing stored data are added to the bus, not to a client.
