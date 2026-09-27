# HIGH-1 — Authenticated Opportunity Handoff Receiver

Status: **IMPLEMENTED + INTEGRATED + TESTED** (22 receiver tests, full suite 974/974)
Deployment status: **NOT_CONFIGURED** until `OPERATOR_CONTROL_TOKEN` is set server-side
and the migration is applied. See "Honest state" below.

---

## 1. What this is

A single authenticated HTTP boundary that accepts an opportunity proposal from an
**external agent sender** (a different repository/service) and funnels it into the
existing AI Income Lab pipeline.

The receiver is a *door*, not a worker. It never runs agents or AI itself. All real
execution goes through the existing **Job Runner**, which remains authoritative for
lifecycle, retries, idempotency, safety gates, budget controls and audit.

```
External/Agent Sender
        ↓  POST /api/handoff/receive
Receiver (route: rate limit → auth → body bounds)
        ↓
Envelope validation (handoff-envelope.ts)
        ↓
Idempotency (OpportunityHandoff.idempotencyKey, UNIQUE)
        ↓
Safety: halal gate recomputed server-side
        ↓  (BLOCKED / REVIEW_REQUIRED stop here — no execution)
Job Runner  →  existing AI Income Lab workflow
        ↓
Audit (SecurityEvent) + persisted OpportunityHandoff row
```

## 2. Files

| File | Role |
|------|------|
| `src/app/api/handoff/receive/route.ts` | HTTP boundary: rate limit, operator auth, bounded body, response mapping |
| `src/lib/integrations/handoff-envelope.ts` | Delivery-envelope contract + validation + eligibility resolution (pure) |
| `src/lib/integrations/handoff-receiver.ts` | Processing: idempotency, halal gate, Job Runner handoff, persistence, audit |
| `src/lib/integrations/__tests__/handoff-receiver.test.ts` | 22 tests across envelope, receiver, auth, and real-DB persistence |
| `prisma/schema.prisma` | `OpportunityHandoff` model (additive) |
| `prisma/migrations/0004_high1_handoff/migration.sql` | Additive migration: 1 CREATE TABLE + 5 indexes, 0 destructive statements |

## 3. Reused existing architecture

Nothing here introduces a second auth system or a parallel execution path. The
receiver composes infrastructure that already exists:

- **Auth** — `requireOperator` (`src/lib/security/guard.ts`). Constant-time
  comparison, fail-closed `503 NOT_CONFIGURED` when no credential is configured.
- **Rate limiting** — `enforceRateLimit` (DB-backed, shared across instances).
- **Body bounds** — `readJsonBody` (Content-Length precheck, streamed byte cap,
  character cap, strict plain-object check, prototype-pollution defusing).
- **Halal gate** — `screenForHalalCompliance` (`src/lib/halal-filter.ts`).
- **Job Runner** — `runJob` (`src/lib/jobs/job-runner.ts`).
- **Audit** — `auditSecurityEvent` → `SecurityEvent` rows.
- **Credentials** — `credentialFingerprint` (HMAC). The raw sender credential is
  never stored, logged, or returned.

## 4. Delivery envelope

Strictly typed. Unknown **top-level** fields are a **rejection**, not a silent
ignore — this is what stops a sender smuggling execution directives.

```json
{
  "contractVersion": "1.0",
  "contractId": "contract-abc-1",
  "idempotencyKey": "idem-1",
  "correlationId": "corr-1",
  "eventType": "OPPORTUNITY_PROPOSED",
  "title": "Niche research newsletter",
  "description": "A curated weekly newsletter about practical automation topics.",
  "category": "MEDIA",
  "businessModel": "SUBSCRIPTION",
  "monetizationMethod": "PAID_SUBSCRIPTION",
  "assertedEligibility": "ALLOWED",
  "payload": { "notes": "plain data only" }
}
```

Validation rules:

| Rule | Behaviour |
|------|-----------|
| `contractVersion` | Only `1.0`; anything else → 400 |
| `eventType` | Only `OPPORTUNITY_PROPOSED`; anything else → 400 |
| `idempotencyKey` | Required, ≤ 200 chars, UNIQUE in DB |
| `correlationId` | Required, ≤ 200 chars, threaded to Job Runner + audit |
| `contractId` | Required, ≤ 200 chars |
| `payload` | Optional object; ≤ 16 KB, depth ≤ 6, ≤ 50 keys, strings ≤ 2000 chars |
| Unknown top-level fields | Rejected (no `jobType`, `instructions`, `command`, …) |
| Forbidden payload keys | `instructions`, `systemPrompt`, `sql`, `shell`, `apiKey`, `token`, … → rejected |

## 5. Untrusted data, not instructions

The sender is a different trust domain. Everything it sends is **data**.

- The envelope has no `instructions` / `command` / `jobType` field, and unknown
  top-level fields are refused.
- The receiver maps event type → job type itself
  (`OPPORTUNITY_PROPOSED → RESEARCH`). A sender can never name the work that runs.
- The `payload` is stored as an opaque JSON string. It is never executed, never
  concatenated into SQL, prompts, shell commands, or file paths.
- Keys that look like instruction/credential smuggling are rejected outright
  rather than sanitised — a legitimate sender never needs them.

## 6. Authorization / halal safety

`assertedEligibility` is recorded **for audit only** and is never an input to the
decision. The effective verdict is always recomputed from the existing halal gate:

| Local screening | Outcome | Work dispatched? |
|-----------------|---------|------------------|
| `NOT_ALLOWED` | `BLOCKED` (409) | **No** |
| `REVIEW_REQUIRED` | `REVIEW_REQUIRED` (409) | **No** — human must review |
| `HALAL` | `ACCEPTED` (201) | Yes, via Job Runner |

A compromised or buggy sender **cannot** steer the system past a safety gate: a
payload asserting `ALLOWED` over prohibited content is still `BLOCKED`, and the
persisted row records both the assertion and the local verdict.

## 7. Idempotency and replay

`OpportunityHandoff.idempotencyKey` is UNIQUE and **is** the idempotency record.

- First delivery → `ACCEPTED` (201), one Job Runner dispatch.
- Same delivery again → `DUPLICATE` (200), **no** second job/opportunity.
- Different `idempotencyKey` → processed independently.
- Concurrent duplicates: the unique index decides the race; the loser re-reads and
  returns `DUPLICATE`. Exactly one dispatch occurs.
- If the Job Runner throws, the reservation is marked `REJECTED` so a later replay
  cannot silently re-trigger the work.

## 8. HTTP contract

| Status | Meaning |
|--------|---------|
| 201 | `ACCEPTED` — persisted and dispatched |
| 200 | `DUPLICATE` — already processed, nothing new created |
| 400 | Invalid envelope (validation failed) |
| 401 | Missing/invalid operator credential |
| 409 | `BLOCKED` (halal NOT_ALLOWED) or `REVIEW_REQUIRED` |
| 413 | Body too large |
| 429 | Rate limit exceeded |
| 502 | Dispatch/persistence failure — nothing was executed |
| 503 | **NOT_CONFIGURED**: `OPERATOR_CONTROL_TOKEN` not set server-side |

Error bodies are generic. Internal error text, credentials, prompts and raw
payloads are never echoed to the caller or written to logs.

## 9. Tests (22)

Covering the required list:

1. valid request → 201, persisted, dispatched
2. malformed body → 400, no dispatch
3. missing authentication → 401
3b. no credential configured → 503 `NOT_CONFIGURED` (fail-closed)
4. unauthorized/overridden eligibility on prohibited content → `BLOCKED`, no dispatch
5. invalid (non-object) payload → 400
6. oversized payload → 400
7. missing correlation ID → 400
8. missing idempotency key → 400
9. duplicate request → `DUPLICATE`, exactly one dispatch
9b. different delivery → processed independently
10. rate limit → 429 after max
11. Job Runner handoff with the **server-mapped** job type
12. audit records for accept/duplicate/block/reject; no credential in audit detail
13. safe error response on Job Runner throw; internal text not leaked
14. prompt-injection payload keys rejected
14b. unknown top-level fields rejected (no directive smuggling)
14c. unsupported contract version / event type rejected
15. borderline content → `REVIEW_REQUIRED`, **no autonomous execution**

Plus envelope-contract unit tests and a real-database persistence/dedup test.

## 10. Honest state

| Aspect | State |
|--------|-------|
| Receiver code | **IMPLEMENTED** |
| Envelope validation | **IMPLEMENTED + TESTED** |
| Idempotency / audit / halal gating | **IMPLEMENTED + TESTED** |
| Route registration in build | **VERIFIED** (`ƒ /api/handoff/receive`) |
| Migration | **IMPLEMENTED** (additive; not yet applied to any live database) |
| Cross-repository delivery from a real external sender | **NOT VERIFIED** — no live sender exists yet |
| Operator credential | **NOT_CONFIGURED** until `OPERATOR_CONTROL_TOKEN` is set server-side |
| Live AI provider execution | **NOT_CONFIGURED** (existing honest `MOCKED`/`NOT_CONFIGURED` capability labels apply) |

HIGH-1 is **not yet LIVE**. It becomes live only when the migration is applied and
an operator credential is configured, and an actual cross-repository delivery has
been observed end to end.

## 11. Applying the migration

```bash
npx prisma migrate deploy          # applies 0004_high1_handoff (additive)
export OPERATOR_CONTROL_TOKEN=...  # server-side only; never commit
```

Then send:

```bash
curl -X POST https://<host>/api/handoff/receive \
  -H "Authorization: Bearer $OPERATOR_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d @envelope.json
```
