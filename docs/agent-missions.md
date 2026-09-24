# Agent Missions

Status: **implemented and tested**.

Missions are bounded work intents persisted in `AgentMission`. They carry an objective, opportunity and agent scope, constraints, budget, allow-listed tool names, expected output, explicit success/failure criteria, deadline, approval requirement, lifecycle status, timestamps, failure reason, and correlation ID.

The mission layer is not an execution authority. Starting a mission records `RUNNING`; actual work still runs through the authoritative Job Runner. `HUMAN_REVIEW`, `BLOCKED`, `CANCELLED`, and `FAILED` states never grant permission to bypass safety gates.

Implemented: `src/lib/operations/missions.ts`, `/api/missions`.

External dependency: none for mission persistence. Approval and provider actions remain dependent on the existing human/provider boundaries.
