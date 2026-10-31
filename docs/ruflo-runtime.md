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
   │  per-IP throttle → auth (per-credential throttle → constant-time compare) → strict body guard
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
| `AUTH_REQUIRED` | Token configured but no handle registered in this process (`RUFLO_RUNTIME_ENABLED` not true, or registration failed). Dispatch refused. |
| `CONNECTING` | Token + handle registered but no successful health verification recorded yet, or the last success is older than the 10-minute freshness window (stale). Re-run `POST /api/ruflo/runtime`. |
| `CONNECTED` | Real verification (boundary contracts + DB) succeeded within the last 10 minutes. Nothing refreshes it automatically; without a new health check it returns to `CONNECTING`. |
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
4. Verify connectivity from the runtime (or any shell that has the token).

   > **Client identification:** the edge middleware (`src/middleware.ts`)
   > refuses API requests whose `User-Agent` matches generic scripting clients
   > (`curl/`, `python-requests/`, `Go-http-client/` …) with **403**, so a bare
   > `curl` fails before reaching the route. Send an identifying `User-Agent`
   > as below. This filter is **not an authentication control** — the bearer
   > token is. Do not disable or loosen the filter to make `curl` work. A Ruflo
   > caller built on Node's `fetch` sends a `User-Agent` that these patterns do
   > not match, but confirm what your actual Ruflo runtime sends (not verified
   > in this repository).


<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e1711bc6c65522de3c02ab4899036a7fc6071578a157bf6879d876f6546dc554 -->

```bash
curl -s -X POST "$BASE_URL/api/ruflo/runtime" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN" \
  -H "User-Agent: ruflo-runtime-operator/1.0"
# → 200 {"ok":true,"health":{"status":"CONNECTED",...}}
# → 503 {"ok":false,"error":"Ruflo runtime API is NOT_CONFIGURED: set RUFLO_RUNTIME_TOKEN server-side to enable it."} (server token absent)
# → 503 {"ok":false,"health":{"status":"AUTH_REQUIRED",...}} (valid bearer token, no handle) · 500 ERROR

curl -s "$BASE_URL/api/ruflo/runtime" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN" \
  -H "User-Agent: ruflo-runtime-operator/1.0"
# → {"ok":true,"ruflo":{"status":"<NOT_CONFIGURED|AUTH_REQUIRED|CONNECTING|CONNECTED|ERROR>",...}}
```

<!-- /coderabbit-ai-generated:v1 -->

5. Dispatch a workflow (idempotent by `executionId`):

```bash
curl -s -X POST "$BASE_URL/api/ruflo/runtime/dispatch" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN" \
  -H "User-Agent: ruflo-runtime-operator/1.0" \
  -H "Content-Type: application/json" \
  -d '{"workflowType":"OPPORTUNITY_DISCOVERY","objective":"…","executionId":"ruflo-run-001"}'
# 202 fresh · 200 duplicate replay · 400 invalid fields/body · 401 bad or missing token · 413 body too large
# 429 throttled · 503 runtime token not configured or no handle registered (NOT_CONNECTED) · 504 timeout
```

6. Trace the execution end-to-end:

```bash
curl -s "$BASE_URL/api/ruflo/runtime/executions/ruflo-run-001" \
  -H "Authorization: Bearer $RUFLO_RUNTIME_TOKEN" \
  -H "User-Agent: ruflo-runtime-operator/1.0"
# → {"ok":true,"execution":{"found":true,"workflow":{…},"jobs":[…]}}
```

## Runtime-side integration contract

An external Ruflo runtime needs only an HTTP client:

- `POST /api/ruflo/runtime/dispatch` with `{workflowType, objective, opportunityId?, executionId?}`
  — treat `executionId` as the workflow-run idempotency key; reuse it for retries.
- `GET /api/ruflo/runtime/executions/:executionId` for status polling.
- `POST /api/ruflo/runtime` runs the real health verification (there is no `/health` sub-path); `GET /api/ruflo/runtime` reads the capability status without verifying.
- Registered handles (same process) additionally receive `onWorkflowCompleted`
  callbacks with bounded, secret-free summaries.

No Ruflo package/CLI is installed or required — the integration is the
documented HTTP contract above plus the server-side handle seam. When/if a
concrete Ruflo distribution ships an official client, it can call exactly these
endpoints without further changes to this codebase.

## HTTP status codes (from the route handlers)

All four endpoints apply a per-IP throttle first, then bearer authentication.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:ee071e15c48a86fa95c2b2bc725029c0b5baa56d0ede491e987e4fdd62012ba4 -->

| Endpoint | Status | Meaning |
| --- | --- | --- |
| all | 429 | Per-IP throttle, or too many attempts for the presented credential (`retry-after` set on the IP throttle). |
| all | 401 | Missing or wrong bearer token (audited). |
| all | 503 | Server token absent: `{ "ok": false, "error": "Ruflo runtime API is NOT_CONFIGURED: set RUFLO_RUNTIME_TOKEN server-side to enable it." }` (fail-closed). |
| `GET /api/ruflo/runtime` | 200 | Capability status; `ruflo.status` is one of the five states above. |
| `POST /api/ruflo/runtime` | 200 / 503 / 500 | After successful authentication: health verdict `CONNECTED` / `AUTH_REQUIRED` (no handle registered) / `ERROR` (boundary or database check failed, or the check threw). A missing server token instead returns the authentication error above. |
| `POST /api/ruflo/runtime/dispatch` | 202 | Fresh dispatch accepted. |
| | 200 | Duplicate `executionId`: the recorded execution is returned, nothing re-runs. |
| | 400 / 413 | Body is not a JSON object or fails field validation (unknown `workflowType`, missing `objective`, bad `opportunityId`) / body over 32 KiB or 12,000 characters. |
| | 503 | No runtime handle registered (`NOT_CONNECTED`). |
| | 504 | Dispatch exceeded `RUFLO_DISPATCH_TIMEOUT_MS`; durable partial state stays queryable. |
| `GET /api/ruflo/runtime/executions/:executionId` | 200 | Trace returned; an unknown id is `found:false`, not an error. |
| | 400 / 500 | `executionId` empty or over 128 characters / lookup failed. |

<!-- /coderabbit-ai-generated:v1 -->

## Failure modes handled

timeout (bounded, durable partial state stays queryable) · invalid/missing
credentials (401/503, audited, throttled) · unknown runtime/unregistered handle
(NOT_CONNECTED refusal, nothing executes) · malformed request (400, strict body
guard) · duplicate execution (workflow-level idempotency by executionId;
job-level idempotency in the Job Runner) · agent/Job Runner failure (surfaced
in durable WorkflowRun/JobRun status, never fabricated as success) ·
authorization failure (halal NOT_ALLOWED → BLOCKED pre-execution;
REVIEW_REQUIRED → HUMAN_REVIEW, never autonomous).
