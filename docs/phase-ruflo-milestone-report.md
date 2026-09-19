## Summary

Completes the **Ruflo Live Integration Phase**: the RUFLO_READY / NOT_CONNECTED seam is now a runtime-facing, authenticated orchestration API — while every existing AI Income Lab boundary (Job Runner, halal gates, idempotency, audit, security hardening from `c3d8545`) remains strictly authoritative.

> Note: the implementation commit (`1cebdf0`) is already on `main` (pushed directly per the milestone's standing instructions). This branch is a review mirror of `main` at that commit plus one additive milestone report (`docs/phase-ruflo-milestone-report.md`) so the work is reviewable as a real diff. Merging changes nothing on `main` code-wise; closing it also loses nothing.

## What was built

- **5-state capability machine** (`NOT_CONFIGURED / AUTH_REQUIRED / CONNECTING / CONNECTED / ERROR`) computed from real facts only — config, registered server-side handle, durable `SecurityEvent` health records. Never manually flippable; CONNECTED requires a fresh real verification.
- **Real health verification**: workflow boundary contracts + database reachability, recorded durably in the audit trail.
- **Authenticated runtime API** (the only inbound execution path for an external orchestrator):
  - `GET /api/ruflo/runtime` — capability status
  - `POST /api/ruflo/runtime/health` — real verification (fail-closed)
  - `POST /api/ruflo/runtime/dispatch` — workflow dispatch (202 fresh / 200 duplicate / 401 / 429 / 504)
  - `GET /api/ruflo/runtime/executions/:executionId` — end-to-end trace
- **Execution chain preserved**: Ruflo → `dispatchWorkflowViaRuflo` (existing connector seam) → `executeWorkflow` (planner + halal/human-review gates) → `runJob` (Job Runner: idempotency, bounded retries) → Agents → durable `WorkflowRun`/`JobRun`/`AgentLog` → `SecurityEvent` audit → completion callback.
- **Workflow-level idempotency** by `executionId` (= `correlationId`); duplicates return the durable row, never re-execute.
- **Bounded dispatch timeout** (`RUFLO_DISPATCH_TIMEOUT_MS`), always-cleared timer; durable partial state stays queryable.
- **Idempotent server-side handle wiring** via `instrumentation.ts`, gated on `RUFLO_RUNTIME_TOKEN` + `RUFLO_RUNTIME_ENABLED=true`.
- **Docs**: `docs/ruflo-runtime.md` (architecture, activation checklist, failure modes) + credentials table update.

## Safety verification (tested, not claimed)

- NOT_ALLOWED → `BLOCKED` pre-execution, zero jobs dispatched
- REVIEW_REQUIRED → `HUMAN_REVIEW`, never autonomous
- Wrong/missing token → 401/503 fail-closed, audited, brute-force throttled
- Malformed JSON → 400; oversized → 413 (strict body guard reused)
- Timeout → 504 with queryable durable partial state
- Duplicate → idempotent 200
- HTTP handle registration still refused (403) — server-side only
- Runtime module provably never writes revenue/payment/authorization tables
- No secrets in diff; no `NEXT_PUBLIC_*`; no security control weakened

## Verification

- **Tests: 825/825 passing** (32 new runtime integration tests; 44/44 Ruflo-specific; full security regression suite green)
- `npm run typecheck` — 0 errors
- `npx eslint . --max-warnings=0` — clean
- `npx prisma generate` — OK
- `npm run build` — OK (middleware/proxy intact)

## Honest status

**NOT_CONFIGURED** in this environment (no Ruflo credentials exist). Activation is documented and is one operator step: set `RUFLO_RUNTIME_TOKEN` + `RUFLO_RUNTIME_ENABLED=true`, restart, run the health check → `CONNECTED`. Nothing was fabricated to claim a live external smoke test.
