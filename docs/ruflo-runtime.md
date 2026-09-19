# Ruflo Runtime Integration — Setup & Activation

Status today: **NOT_CONFIGURED** (truthful). The runtime-facing integration is
implemented and tested end-to-end; it activates the moment the credentials
below exist. Nothing reports CONNECTED/LIVE until a real, authenticated health
verification succeeds.

## Architecture (what runs where)

```
Ruflo runtime (external orchestrator)
   │  HTTP, bearer RUFLO_RUNTIME_TOKEN (server-side secret)
   ▼
/api/ruflo/runtime/*            ← authenticated runtime API (this repo)
   │  auth (constant-time) → per-IP throttle → strict body guard
   ▼
dispatchForRufloRuntime()       ← workflow-level idempotency by executionId
   │
   ▼
dispatchWorkflowViaRuflo()      ← EXISTING connector seam (Phase 5.5)
   ▼
executeWorkflow()               ← EXISTING planner + halal/human-review gates
   ▼
runJob()                        ← EXISTING Job Runner (job idempotency,
   │                               bounded retries, AgentRegistry)
   ▼
Agents → AgentLog / WorkflowRun / JobRun (durable) → SecurityEvent (audit)
   │
   ▼
completion callback → registered Ruflo runtime handle (notification only)
```

Every gate remains authoritative inside AI Income Lab. Ruflo is a caller with a
credential — never a bypass. It cannot mutate revenue, payment, or security
state directly; the only verbs it has are dispatch (workflow), health, and
status lookup.

## Environment variables (server-side only)

| Variable | Required | Purpose |
|---|---|---|
| `RUFLO_RUNTIME_TOKEN` | Yes | Shared secret for the runtime API. Long random string (32+ chars). Never sent anywhere except as `Authorization: Bearer …` from the runtime. |
| `RUFLO_RUNTIME_ID` | No | Non-secret audit label of the runtime (default `ruflo-runtime`). |
| `RUFLO_RUNTIME_ENABLED` | Yes (=`true`) | Explicit kill switch. The handle registers only when `true`; without it the posture stays AUTH_REQUIRED. |
| `RUFLO_DISPATCH_TIMEOUT_MS` | No | Dispatch budget in ms (1000–600000, default 120000). |

No `NEXT_PUBLIC_*` variable exists for any of these. Tokens never appear in
logs, API responses, or client bundles (enforced by regression tests).

## Capability state machine

| State | Meaning |
|---|---|
| `NOT_CONFIGURED` | No token, no handle. Integration dormant. |
| `AUTH_REQUIRED` | Token configured but handle not registered (`RUFLO_RUNTIME_ENABLED` not true). Dispatch refused. |
| `CONNECTING` | Token + handle registered but no successful health verification recorded yet. |
| `CONNECTED` | Real verification (boundary contracts + DB) succeeded; freshness window applies. |
| `ERROR` | Last verification failed (boundary or DB). |

The status is computed from real facts (config + registered handle + durable
SecurityEvent verification records). It cannot be flipped manually.

## Activation (operator checklist)

1. Generate a token server-side, e.g. `openssl rand -hex 32`.
2. Set in Settings → Environment (or `freebuff-env`):
   - `RUFLO_RUNTIME_TOKEN=<generated>`
   - `RUFLO_RUNTIME_ENABLED=true`
   - optional: `RUFLO_RUNTIME_ID`, `RUFLO_DISPATCH_TIMEOUT_MS`
3. Restart the server — `src/instrumentation.ts` registers the handle
   idempotently at startup.
4. Verify connectivity from the runtime (or any shell that has the token):

```bash
curl -s -X POST "$BASE_URL/api/ruflo/runtime/health" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN"
# → {"ok":true,"health":{"status":"CONNECTED",...}}

curl -s "$BASE_URL/api/ruflo/runtime" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN"
# → {"ok":true,"ruflo":{"status":"CONNECTED",...}}
```

5. Dispatch a workflow (idempotent by `executionId`):

```bash
curl -s -X POST "$BASE_URL/api/ruflo/runtime/dispatch" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workflowType":"OPPORTUNITY_DISCOVERY","objective":"…","executionId":"ruflo-run-001"}'
# 202 fresh · 200 duplicate replay · 401 auth · 429 throttle · 504 timeout
```

6. Trace the execution end-to-end:

```bash
curl -s "$BASE_URL/api/ruflo/runtime/executions/ruflo-run-001" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN"
# → {"ok":true,"execution":{"found":true,"workflow":{…},"jobs":[…]}}
```

## Runtime-side integration contract

An external Ruflo runtime needs only an HTTP client:

- `POST /api/ruflo/runtime/dispatch` with `{workflowType, objective, opportunityId?, executionId?}`
  — treat `executionId` as the workflow-run idempotency key; reuse it for retries.
- `GET /api/ruflo/runtime/executions/:executionId` for status polling.
- `POST /api/ruflo/runtime/health` for liveness; `GET /api/ruflo/runtime` for capability.
- Registered handles (same process) additionally receive `onWorkflowCompleted`
  callbacks with bounded, secret-free summaries.

No Ruflo package/CLI is installed or required — the integration is the
documented HTTP contract above plus the server-side handle seam. When/if a
concrete Ruflo distribution ships an official client, it can call exactly these
endpoints without further changes to this codebase.

## Failure modes handled

timeout (bounded, durable partial state stays queryable) · invalid/missing
credentials (401/503, audited, throttled) · unknown runtime/unregistered handle
(NOT_CONNECTED refusal, nothing executes) · malformed request (400, strict body
guard) · duplicate execution (workflow-level idempotency by executionId;
job-level idempotency in the Job Runner) · agent/Job Runner failure (surfaced
in durable WorkflowRun/JobRun status, never fabricated as success) ·
authorization failure (halal NOT_ALLOWED → BLOCKED pre-execution;
REVIEW_REQUIRED → HUMAN_REVIEW, never autonomous).
