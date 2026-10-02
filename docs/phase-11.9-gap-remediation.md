# Phase 11.9 — Audit Gap Remediation

Audit findings G1–G10 plus the job-governance, auto-enqueue, and
`ServiceIssue → Message` traceability questions, re-derived against the actual
`main` code rather than taken on trust.

This document records, per finding: what was reproduced, what was already
correct, what changed, and — importantly — what was deliberately **not** done.

---

## Premise correction

The audit brief stated `origin/main = 6c83ff9` and "PR #20 IS NOT MERGED". That
snapshot was stale. At the time this work started `main` was `0c6538e` and PR
#20 was already merged, carrying Phases 11.2/11.3 **and** 11.4→11.8. Several
findings were therefore already fixed and the first job was reproducing each
one against source before changing anything.

---

## Finding-by-finding

### G3 — Halal gate bypass — **ALREADY FIXED (Phase 11.6), verified**

`createEngagement` reads the linked offer's **stored** `halalStatus` and refuses
`BLOCKED` / `NOT_ALLOWED` / `UNVERIFIED` outright; `REVIEW_REQUIRED` requires an
explicit `allowReviewRequiredOffer` that is itself audited.
`executeServiceJobViaRunner` re-checks the same verdict at execution time and
**fails closed** if the offer cannot be read.

Verified by reproduction, not assumption: tests `#1`, `#1b`, `#2`, `#2b`.

### G4 — Admin halal override — **ALREADY FIXED (Phase 11.6), verified**

`offer-service.ts` always runs `screenForHalalCompliance`. A caller-supplied
`halalStatus` may only be equal to or **more conservative** than the screen's
verdict (worst-wins rank `HALAL 0 < UNVERIFIED 1 < REVIEW_REQUIRED 2 < BLOCKED 3`).

Verified: test `#4` drives a request carrying `halalStatus: 'HALAL'` against
explicitly blocked betting content and asserts both that creation is refused
**and** that zero `HALAL` offers were persisted.

### G5 — `Revenue.serviceEngagementId` — **ALREADY IMPLEMENTED (Phase 11.4/11.7)**

Added as a nullable, indexed, FK-backed column plus `revenueBasis`,
`recognizedUsd`, `milestoneId`, `paymentEventId`, `evidenceBasis`. Verified by
tests `#14` (service revenue carries the link), `#15` (digital product revenue
valid with a null link), `#16` (idempotency intact).

### G6 — Learning signal integrity — **ALREADY FIXED (Phase 11.7), verified**

All 12 declared signals have real production emission sites. Test `#18` asserts
this structurally: it parses the declared union out of the source and requires
an emission site for every declared kind, so a future "declared but never
emitted" signal fails the build rather than quietly widening the claim.

### G7 — Margin semantics — **ALREADY FIXED (Phase 11.7), verified**

`MARGIN_OUTCOME` is `mean_realized_margin_ratio` — `(revenue − cost) / revenue`
over engagements that have **both** realized ACTUAL revenue and a recorded
ACTUAL cost. Estimated costs are excluded; missing cost yields UNKNOWN, never
zero. Test `#19` asserts `0.7` for revenue 100 / cost 30, which fails for both
an implementation reporting the *price* (100) and one reporting *absolute
profit* (70). Test `#19b` asserts an ESTIMATED cost contributes no sample.

### G9 — Simulated provider health — **ALREADY FIXED (Phase 11.6), verified**

`SimulatedCommunicationProvider.health()` returns `NOT_CONNECTED`, never
`HEALTHY`. Test `#12`.

### G2 (outreach) — **ALREADY FIXED (Phase 11.5), verified**

`sendGovernedOutreach` runs content screening → eligibility/opt-out → daily cap
→ dedupe → provider → audit, and `sendCommunication` itself calls
`screenOutreachCopy` so a direct caller cannot skip it.

### G1 — Production routing — **REAL GAP, FIXED**

**Reproduced:** `routeOpportunity`, `executionVerdict`, `validateCandidates` and
`discoveryCandidates` had **zero references outside their own module and its
test file**. The routing layer was decoration.

**Fix:** `src/lib/commercial/routing-service.ts` resolves the route from the
already-screened offer type and the *persisted* opportunity halal verdict, and
**persists** it onto the Offer (`route`, `routeJobTypes`, `routeExecutable`,
`routeBlockers`, `routeReason`, `routeResolvedAt`). `createOffer` calls it after
screening. `executeServiceJobViaRunner` refuses a job whose type is not in the
offer's recorded route — which is what stops routing being decorative.

**Truthfulness:** this records *which existing job types a route runs through*.
It dispatches nothing and fabricates nothing. An offer with no screened
opportunity resolves to `HALAL_UNVERIFIED` and is **not** executable.

> `DISCOVERY NOT_CONNECTED ≠ DISCOVERY FABRICATED`

### G2 (micro-service bounds) — **REAL GAP, FIXED**

**Reproduced:** `createEngagement` checked only that the kind was a known
catalogue key. `validateMicroServicePackage` and `isPriceWithinBand` existed,
were well tested, and were **never called by any production path**. A
`CUSTOM_WORKSHEET` (band $15–150, max 6 hours) could be created at $100,000.

**Fix:** `createEngagement` now enforces effort ceiling, revision limit, and
price band. Out-of-band values are **refused, never clamped**.

### G8 — Micro-service kind representation — **REAL GAP, FIXED**

**Reproduced, and worse than the audit described.** Phase 11.3 stored the kind
as free text: `scopeSummary: '[KIND] ' + summary`. Prose is user-editable and
unindexed — and because it was not authoritative, the job runner could not read
it and **trusted a caller-supplied payload value instead**. An execution could
declare a different catalogue kind than the engagement was admitted under.

**Fix (schema + code):**
- New nullable `ServiceEngagement.microServiceKind` (indexed), plus
  `microServiceEffortHours` / `microServiceRevisionLimit` snapshotting the
  admitted envelope so the bound stays reproducible if the catalogue changes.
- The free-text prefix write is **removed**; `scopeSummary` stays verbatim.
- The runner reads the **column**. A payload kind that contradicts it is
  refused; a `MICRO_SERVICE` with no persisted kind is refused (fail-closed).

**Contract note:** the pre-existing `bounded` result field kept its meaning
("a bounded deterministic service job"). Whether an engagement is additionally
*catalogue*-bounded is reported separately as `microServiceBounded`, so an
existing contract was not silently repurposed.

### ServiceIssue → Message traceability — **REAL GAP, FIXED**

**Reproduced:** `correlationId: 'client-message:' + randomUUID()` — a generated
UUID pointing at nothing, so a client-sourced dispute could not be traced to the
message that caused it.

**Fix:** nullable FK `ServiceIssue.messageId → Message.id` with
`ON DELETE SET NULL`. `createServiceIssue` takes `messageId`, validates the
message **exists** (a dangling id is refused), and records
`client-message:<realId>`. Admin-raised issues legitimately have no message.

Direction is preserved: `Message.treatAs` is constant `DATA`, never
`AUTHORITY`, so a message can *trigger* an issue but never *resolve* one.

---

## G10 — Job type contract — deliberately NOT renamed

Design references `CLIENT_OUTREACH`, `SERVICE_EXECUTION`, `SERVICE_QA`,
`SERVICE_DELIVERY`. Implementation uses `SERVICE_BUILD`, `SERVICE_QA`,
`SERVICE_DELIVERY`.

- `CLIENT_OUTREACH` is absent **because the communication provider is
  NOT_CONNECTED**. Adding an outreach job type would assert a capability that
  does not exist. This is the bounded, truthful contract.
- `SERVICE_BUILD` **is** the conceptual `SERVICE_EXECUTION` job: it is the
  bounded build/execute step. Renaming it would churn a stable vocabulary and
  break running history for no behavioural gain.

Test asserts the exact implemented set, so the contract is pinned rather than
merely implied.

## Job governance — verified, no second control system

`/api/jobs` is operator-guarded (`guardOperatorEndpoint`, rate-limited,
fail-closed) and every dispatch runs the same `runJob` gates: idempotency →
halal → payment → cancellation/reversal → deliverable ownership.

Service jobs reach `runJob()` through the **same** path as every other job
type. Agency supervised dispatch (`src/lib/agency/supervised-dispatch.ts`) is
an existing opt-in layer over `runJob()` for *all* job types — it is not a
service-specific gap, and no second supervisor was added.

`SERVICE_BUILD` is **not** automatically enqueued. That is intentional and was
left that way: the system distinguishes *capability exists* / *an authorized
path can dispatch it* / *autonomous dispatch is enabled*. Turning autonomous
execution on just to satisfy a test would be the wrong trade.

---

## Database

One additive migration, `0011_gap_remediation_routing_and_bounds`. No DROP, no
DELETE, no UPDATE, no data backfill — historical rows stay `NULL`, which
truthfully means "not recorded" rather than inventing linkage.

Verified by `node scripts/check-migration-drift.mjs`: **NO DRIFT / CLEAN
(additive only) / PASS**. That check caught a real `REAL` vs
`DOUBLE PRECISION` mismatch during development, which is why it was re-run
after every schema edit.

## Tests

`src/lib/commercial/__tests__/gap-remediation-db.test.ts` — 34 tests, each
named against the audit item it closes.

Full suite: **1509 tests / 377 suites / 1508 pass / 0 fail / 1 skipped**
(skipped = `AI_LIVE_TESTS`).

Three pre-existing fixtures broke when the price band went live — they used
`totalPrice: 500` against a `CUSTOM_WORKSHEET` whose band is $15–150. That was
never a real price; it was tolerated only because the bound was unenforced.
Fixtures were corrected rather than the bound weakened.