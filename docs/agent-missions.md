# Agent Missions

Status: IMPLEMENTED / TESTED

Durable mission abstraction for bounded agent work. Execution always goes through the existing Job Runner. Missions never become a second execution authority.

## Shape

A mission stores: objective, opportunityId, agentType, constraints, budgetUsd, allowed capabilities, expected output, success/failure criteria, deadline/timeout, approval requirements, status, timestamps, failure reason, correlationId, retryCount, resumePoint, lastError, failureClass, jobId.

Statuses: `QUEUED READY RUNNING WAITING HUMAN_REVIEW COMPLETED FAILED CANCELLED BLOCKED`

## Safety

- `NOT_ALLOWED` opportunities are stored as `BLOCKED` at create time. Nothing runs.
- `REVIEW_REQUIRED` and `approvalRequired` prepare to `HUMAN_REVIEW`. No autonomous execution.
- Forbidden capabilities (`SHELL`, `ARBITRARY_EXEC`, `ENV_INJECT`, `BYPASS_HALAL`, `FABRICATE_REVENUE`, …) are rejected at validation.
- Budget is hard-capped (`MAX_MISSION_BUDGET_USD = 50`).
- Duplicate `correlationId` returns the existing row (idempotent).
- Job mapping is allowlisted. Unknown agent types fail closed.

## APIs

- `GET /api/ops/missions` — recent missions (safe fields)
- `POST /api/ops/missions` — create (idempotent on correlationId)
- `POST /api/ops/missions/:id/run` — prepare + execute through `runJob`

## Labels

| Path | Status |
|---|---|
| Mission persistence + gates | IMPLEMENTED / TESTED |
| Job Runner execution | IMPLEMENTED (reused) |
| Live Ruflo dispatch of missions | NOT_CONNECTED |
| Live AI inside a mission | MOCKED unless `AI_PROVIDER` is configured |

External: HUMAN_REQUIRED for publish/deploy tokens and for `REVIEW_REQUIRED` opportunities.
