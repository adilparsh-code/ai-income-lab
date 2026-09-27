# Operations Dashboard

Status: IMPLEMENTED / TESTED

Route: `/operations`  
API: `GET /api/ops/dashboard` (plus existing `GET /api/operations`)

## Surfaces

**System Health** — Database, AI, Research, Ruflo, Ruflo Runtime, Publishing, Deployment, Agents, Jobs, Workflows.

**Execution** — running, completed, failed, retries, human review, blocked, waiting, queued (from `AgentMission` + existing JobRun aggregates).

**Income Engine** — opportunities, loop transitions, experiments, products, simulated revenue, real revenue, simulated profit, pending human input. Simulated and real figures are separate fields.

**Agent Timeline** — missions, operational memory, simulation runs. Each event carries a state label.

## Labels (never hidden)

`LIVE MOCKED SIMULATED NOT_CONFIGURED NOT_CONNECTED BLOCKED AWAITING_HUMAN_INPUT`

Unavailable functionality is labelled, not omitted. Publishing and deployment tiles stay `NOT_CONNECTED` until a real provider + human approval token exist.

## Labels of this module

| Path | Status |
|---|---|
| `/operations` UI | IMPLEMENTED |
| Dashboard assembler | IMPLEMENTED / TESTED |
| Live Ruflo / Polar / Vercel tiles | NOT_CONFIGURED / NOT_CONNECTED unless env is set |
| Existing `/api/operations` factory summary | IMPLEMENTED (Phase 5.5, reused) |
