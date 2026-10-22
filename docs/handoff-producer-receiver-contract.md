# Producer ↔ Receiver Handoff Contract (v1.0)

**Scope:** the receiver half of the opportunity handoff, implemented in this
repository at `src/app/api/handoff/receive/route.ts` and
`src/lib/integrations/handoff-receiver.ts` / `handoff-envelope.ts`.

**Status of this document:** OFFLINE-ONLY. Every statement below was verified
against receiver code and receiver-side offline tests
(`src/lib/integrations/__tests__/handoff-receiver.test.ts`,
`src/lib/integrations/__tests__/handoff-contract.test.ts`). The **producer**
lives in a separate repository/worktree and was NOT executed against this
receiver in this session. See "Producer-side assumptions still open" at the
end — those are the items that require a real, authorized integration run.

---

## 1. Transport

| | |
|---|---|
| Method | `POST` |
| Path | `/api/handoff/receive` |
| Auth | `Authorization: Bearer <OPERATOR_CONTROL_TOKEN>` |
| Content-Type | `application/json` |
| Body limit | 24 000 characters / 64 KiB (rejected with `413`) |
| Rate limit | 20 requests / 60 s per client IP, plus 20 / 60 s per credential |
| Idempotency | `idempotencyKey` — unique, durable, required |

The receiver reuses the repository's existing operator credential gate. There
is **no** second authentication system. If no credential is configured
server-side, the endpoint fails closed with `503 NOT_CONFIGURED` and processes
nothing — it never fabricates a success.

---

## 2. Request envelope

Exactly these fields are accepted. **Any unknown top-level field is a
rejection**, not an ignored extra: a sender can never smuggle a `jobType`,
`instructions`, `sql` or `shell` directive through the data channel.

| Field | Type | Required | Notes |
|---|---|---|---|
| `contractVersion` | string | yes | must be `"1.0"` |
| `contractId` | string | yes | sender's logical contract id, ≤ 200 chars |
| `idempotencyKey` | string | yes | ≤ 200 chars, unique per delivery |
| `correlationId` | string | yes | ≤ 200 chars; becomes the Job Runner's idempotency key suffix |
| `eventType` | string | yes | currently only `"OPPORTUNITY_PROPOSED"` |
| `title` | string | yes | ≤ 300 chars |
| `description` | string | yes | ≤ 2 000 chars; mapped to the dispatched `researchObjective` |
| `category` | string | yes | ≤ 200 chars |
| `businessModel` | string | yes | ≤ 200 chars |
| `monetizationMethod` | string | yes | ≤ 200 chars |
| `assertedEligibility` | string | yes | `ALLOWED` \| `REVIEW_REQUIRED` \| `NOT_ALLOWED` — **a claim only** |
| `payload` | object | no | untrusted data; depth ≤ 6, ≤ 50 keys, ≤ 16 KiB, forbidden keys rejected |

### 2.1 Sender assertions vs. server truth

`assertedEligibility` is recorded **for audit only**. The effective verdict is
always recomputed server-side by the existing halal gate. A sender that
asserts `ALLOWED` on prohibited content still gets `BLOCKED`.

### 2.2 Content digest

The receiver computes its own SHA-256 digest over the canonical JSON of the
content fields:

```
contractVersion, contractId, correlationId, eventType, title,
description, category, businessModel, monetizationMethod, payload
```

Deliberately **excluded**:

* `idempotencyKey` — it is the lookup key, not the content.
* `assertedEligibility` — it is the sender's *claim*; the receiver recomputes
  the effective verdict, so a re-assertion is not a content change.

`correlationId` **is** included: the Job Runner's own idempotency key is
`<jobType>:<correlationId>`, so a different correlation id under the same
idempotency key is a different logical execution.

The digest is stored alongside the payload in the durable row, wrapped as
`{"v":1,"contentDigest":"<sha256 hex>","payload":{…}}`. Rows written before
that wrapper existed are read as LEGACY and compared on the fields the row
actually carries.

---

## 3. Response contract

### 3.1 Success shapes

```jsonc
// 201 — accepted and dispatched, JobRun completed successfully
{
  "ok": true,
  "handoff": "ACCEPTED",
  "idempotencyKey": "…",
  "correlationId": "…",
  "jobRunId": "…",
  "duplicate": false,
  "detail": "Delivery accepted and dispatched to the Job Runner."
}

// 200 — a genuine replay of an already-ACCEPTED delivery
{ "ok": true, "handoff": "DUPLICATE", "duplicate": true, "jobRunId": "…", … }

// 202 — dispatched, but the outcome is not a clean success
{ "ok": true, "handoff": "DEGRADED", "duplicate": false, "detail": "… reconcile …" }
```

### 3.2 Refusal shapes

```jsonc
// 400 — envelope rejected (shape/bounds/version). `errors[]` lists reasons.
{ "ok": false, "handoff": "REJECTED", "error": "Invalid delivery envelope.", "errors": ["…"] }

// 409 — safety gate refused it, or the key was reused with different content
{ "ok": false, "handoff": "BLOCKED",            "error": "…" }
{ "ok": false, "handoff": "REVIEW_REQUIRED",    "error": "…" }
{ "ok": false, "handoff": "CONFLICT",           "error": "…" }

// 502 — the receiver could not confirm the outcome
{ "ok": false, "error": "Dispatch to the Job Runner failed. No work was completed." }

// 429 — rate limited; HONOUR THE Retry-After HEADER
{ "ok": false, "error": "Rate limit exceeded. Retry later." }
// Retry-After: 42

// 401 — bad/missing credential. 503 — no credential configured (fail closed).
```

### 3.3 Verdict vocabulary (all five stay distinct)

| `handoff` | Meaning | Work executed? |
|---|---|---|
| `ACCEPTED` | persisted, dispatched, JobRun recorded | yes, succeeded |
| `DEGRADED` | dispatched, but the outcome is incomplete or the runner degraded | yes, degraded |
| `DUPLICATE` | a replay of an already-`ACCEPTED` delivery | no new work |
| `FAILED` | persisted, but the dispatched work did not complete | attempted |
| `BLOCKED` | a safety gate refused it | no |
| `REVIEW_REQUIRED` | a human must decide | no |
| `CONFLICT` | the key was reused with different content | no |
| `REJECTED` | the envelope was structurally invalid | no |

**Invariant:** a stored `FAILED` / `BLOCKED` / `REVIEW_REQUIRED` row is *never*
reported as `DUPLICATE`, and an `ACCEPTED` row whose `JobRun` pointer is
missing is reported as `DEGRADED`, not as a success. An ambiguous result is
never reported as a success.

### 3.4 Known limitation: rows written by the previous receiver

Before this change, the receiver wrote `status: 'ACCEPTED'` on the row at
reservation time and only updated the `JobRun` pointer afterwards. A row
written by that version therefore carries `ACCEPTED` **even when the
dispatched job actually failed**, and the receiver cannot recover the job's
real outcome from the handoff row alone.

For those legacy rows the receiver reports `DUPLICATE` (the `JobRun` pointer
is present, so the work *was* dispatched) rather than inventing a failure it
cannot evidence. The authoritative job outcome for such a row lives in the
`JobRun` record, not in the handoff row.

Rows written by the current receiver always carry the job's real terminal
status (`ACCEPTED` / `DEGRADED` / `FAILED` / `BLOCKED` / `REVIEW_REQUIRED`),
so this limitation applies only to deliveries accepted before the change.

---

## 4. Producer obligations (derived from the receiver behaviour)

1. **Always send the same `idempotencyKey` for the same logical delivery.**
   The key is the receiver's only deduplication anchor.
2. **Never reuse a key for different content.** The receiver answers `409
   CONFLICT` and leaves the original delivery untouched.
3. **Treat `429` as "wait `Retry-After` seconds, then retry the SAME request".**
   Retrying with a new key would create a second delivery.
4. **Treat `502` and any transport timeout as "unknown", not "failed".**
   The receiver may have committed before the response was lost. Reconcile by
   **re-sending the identical envelope with the identical key** and reading the
   verdict — never by generating a new key.
5. **A timeout is not a failure.** Only an explicit `FAILED` verdict is.
6. **Do not retry a `BLOCKED` / `REVIEW_REQUIRED` / `CONFLICT` verdict** without
   operator action; the receiver will keep returning the same truth.
7. **Bounded retries with exponential backoff and a jitter.** The receiver
   rate-limits per IP and per credential.

---

## 5. Failure-mode matrix (receiver-side, verified offline)

| Scenario | Receiver response | Verified by |
|---|---|---|
| Same key, same content, repeated | `200 DUPLICATE`, one dispatch | contract test "executes once…" |
| Same key, different content | `409 CONFLICT`, original untouched | contract test "refuses a reused idempotency key…" |
| Same key, different `correlationId` | `409 CONFLICT` | contract test "treats a changed correlation id…" |
| Same key, only `assertedEligibility` changed | `200 DUPLICATE` | contract test "does not treat a changed sender claim…" |
| Legacy row (no digest), comparable fields match | `200 DUPLICATE` | contract test "honours a legacy replay…" |
| Legacy row, comparable field differs | `409 CONFLICT` | contract test "still detects a conflict on a legacy row…" |
| Response lost after commit, producer retries | `200 DUPLICATE`, no re-execution | contract test "reconciles a duplicate attempt…" |
| `ACCEPTED` row with no `JobRun` pointer | `202 DEGRADED` | contract test "does not acknowledge a delivery whose dispatch outcome…" |
| Job returned `FAILED` / `BLOCKED` / `HUMAN_REVIEW` / `DEGRADED` | that verdict, stored on the row | contract tests "reports a … job as …" |
| Reservation INSERT failed, row unreadable | `502`, nothing dispatched | contract test "reports an unknown commit outcome…" |
| Concurrent insert lost the unique-index race | the winner's stored verdict | contract test "refuses a concurrent loser…" |
| No operator credential configured | `503`, nothing processed | auth-boundary tests |
| Rate limit exceeded | `429` + `Retry-After` | contract test "answers 429 with a Retry-After…" |

---

## 6. Producer-side assumptions still open (require a real integration run)

These are **not** verified by this document. Each needs an authorized run
against a live receiver with a real producer.

1. The producer's serialisation produces byte-identical content for the same
   logical delivery, so the receiver's digest matches on a retry. The receiver
   canonicalises before hashing, so key order does not matter — but the
   producer's *values* must be stable.
2. The producer honours `Retry-After` and uses a bounded, jittered backoff.
3. The producer treats `502`/timeout as "unknown" and reconciles by replaying
   the identical envelope with the identical key.
4. The producer's credential handling matches the `OPERATOR_CONTROL_TOKEN`
   contract and never logs it.
5. End-to-end latency: the receiver's dispatch is synchronous with respect to
   the HTTP response, so the producer's client timeout must exceed the Job
   Runner's expected duration, or it must be prepared to reconcile.

**No end-to-end producer/receiver integration was executed in this session.**
