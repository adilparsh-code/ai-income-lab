# Autonomous Loop Controller

Status: IMPLEMENTED / TESTED

Deterministic controller over the Phase 7 Income Engine. One safe transition per tick.

Target lifecycle:

`DISCOVER → RESEARCH → VALIDATE → DECIDE → BUILD → TEST → DEPLOY → PUBLISH → TRAFFIC → CONVERT → REVENUE → LEARN → ITERATE`

## Rules

1. Read current opportunity state (existing `getIncomeLoopState`).
2. Identify completed stages from real records.
3. Find the next valid stage. Never skip mandatory gates.
4. Verify halal / review / kill / pause / infinite-loop guards.
5. Execute exactly one transition through `advanceIncomeLoop` → `runJob`.
6. Persist `LoopTransition` with from, to, reason, evidence, correlationId, timestamp, status.
7. Return the next action.

Never repeats a completed stage as if it were unfinished. After three identical non-advancing transitions the infinite-loop guard (`GUARD`) stops the tick.

`TRAFFIC` / `CONVERT` / `REVENUE` remain `AWAITING_HUMAN_INPUT` unless real ingestion exists. The controller cannot fabricate visitors or sales.

## API

`POST /api/ops/loop/:opportunityId/tick`

Optional body: `{ humanApprovalToken?: string }` — accepted only to satisfy the existing publish/deploy boundary; never logged in plaintext.

## Labels

| Path | Status |
|---|---|
| Controller + transition log | IMPLEMENTED / TESTED |
| Stage execution | IMPLEMENTED (Income Engine / Job Runner) |
| Live publish/deploy | NOT_CONNECTED / HUMAN_REQUIRED |
| Live traffic/revenue | EXTERNAL_DEPENDENCY (ingestion APIs) |
