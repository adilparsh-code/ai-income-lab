# Operations

Status: **implemented and tested**.

`/operations` and `GET /api/operations` expose system health, Job Runner activity, workflow/blocked/review counts, mission state, loop transitions, real recorded economics, and the agent timeline. The dashboard combines the existing real-DB operations aggregate with Phase 8 summaries.

Provider labels distinguish `LIVE`, `MOCKED`, `SIMULATED`, `NOT_CONFIGURED`, `NOT_CONNECTED`, `BLOCKED`, `AWAITING_HUMAN_INPUT`, and `UNAVAILABLE`. Configuration is never promoted to live provider success.

Simulation is explicitly labelled and cannot create real revenue, traffic, publishing, deployment, or external execution. `/api/operations/simulate` is guarded and deterministic.

Human approvals remain required for deployment and publishing. Missing database/provider data degrades to an unavailable label rather than a fabricated value.
