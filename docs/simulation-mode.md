# Simulation / Paper-Income Mode

Status: IMPLEMENTED / TESTED / SIMULATED

Every result is explicitly `SIMULATED`. `realTransaction` is structurally `false`. Simulated figures are stored only in `SimulationRun`, never in `Revenue`.

## Contract

```
MODE: SIMULATION
Traffic: 10,000
Conversion: 2.4%
Revenue: $480 SIMULATED
Costs: $73 SIMULATED
Profit: $407 SIMULATED
No real transaction occurred.
```

Seeds are hashed to a deterministic RNG (`mulberry32` over SHA-256). Identical seeds produce identical numbers in tests.

Supports opportunities, traffic, conversion, revenue, costs, profit, experiments, failures, retries, and lifecycle decisions — all labelled SIMULATED.

## API

`POST /api/ops/simulate` with `{ seed, correlationId, traffic?, conversionRate?, priceUsd?, ... }`

Response always includes `notice: "SIMULATED. No real transaction occurred."`

## Labels

| Path | Status |
|---|---|
| Deterministic paper engine | IMPLEMENTED / TESTED / SIMULATED |
| Persistence (`SimulationRun`) | IMPLEMENTED / TESTED |
| Mixing into `Revenue` | Forbidden by construction |
| Live marketplace economics | NOT_CONNECTED |
