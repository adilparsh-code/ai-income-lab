# Phase 11.4 → 11.8 — Implementation Notes

**Base:** Phase 11.0 design (`docs/phase-11-design.md`), Phase 11.1 (secure income
foundation), Phase 11.2/11.3 (governed income pipeline).

**Standing constraint:** every phase reuses the existing architecture. No second
Job Runner, Supervisor, Agent Control system, Halal engine, revenue ledger,
P&L layer, authentication, authorization, payment-truth or learning system was
created. The three income paths (digital product / micro-service / client
service) keep separate lifecycles and share only governance, safety, the Job
Runner, and the economic view.

---

## Phase 11.4 — Payment verification + financial gates

### What existed
- Phase 8 signature verification (`webhook-verification.ts`) — sound.
- Phase 8 digital-product revenue ingestion — sound, idempotent.
- Phase 11.3 `PaymentVerificationSource` on engagement/milestone — sound as a
  *concept*, but **`PROVIDER_WEBHOOK` was unreachable**: no service webhook route
  existed, so every service payment required manual approval.

### What was added
- **`PaymentEvent`** — an append-only, replay-guarded evidence ledger. Every
  claim the system is asked to trust gets a row *with its verdict*, including
  REJECTED ones, so "someone tried to claim payment from a screenshot" is
  auditable rather than invisible. `@@unique([provider, providerEventId])` is
  the replay guard.
- **`ManualPaymentVerification`** — the controlled review path. A manual
  approval must carry a named reviewer, a reason, real evidence references and a
  timestamp. An unattributed approval is not an approval.
- **`payment-evidence.ts` (pure)** — the single trust boundary. Named untrusted
  classes (`CLIENT_SCREENSHOT`, `CLIENT_MESSAGE`, `BROWSER_PARAMETER`,
  `FRONTEND_FLAG`, `AI_GENERATED_CLAIM`, …) are refused *first*, so smuggling a
  valid method string alongside them does not help. `PROVIDER_WEBHOOK` requires
  a verified signature; `PROVIDER_API` requires a confirmed read.
- **`payment-service.ts`** — applies verified events to governed state, and
  routes reversals to their own path so a refund can never be treated as a fresh
  payment.
- **`POST /api/webhooks/polar/service`** — the missing provider path, ordered so
  that nothing can skip a step: bounded body → signature → parse → evidence →
  state transition. `MISSING_SECRET` returns 503 and changes nothing.

### Invariants now enforced
- UNPAID → EXECUTING remains impossible (verified by test, not by comment).
- Replayed events collapse to one ledger row and re-apply **no** state change.
- Currency mismatch, underpayment, and cross-engagement milestones are refused.
- A refund/chargeback zeroes recognized revenue and drops the engagement and
  milestone out of `PAYMENT_VERIFIED`. A refund can never silently remain paid.
- Revenue remains idempotent (`service:{eng}:{ms|'engagement'}:{ref}`).

---

## Phase 11.5 — Client communication + safe outreach

- **`OutreachSend`** ledger with `@@unique(idempotencyKey)`: a retried outreach is
  a no-op, never a second message to a real business. Stores digests, not raw
  contact data.
- **`outreach-service.ts`** — the only send path. Order is the design: content
  gate → eligibility (opt-out, lifecycle, caps, window, first-contact approval)
  → global daily cap → duplicate gate → provider → audit.
- **Content gate moved inside the send path.** `sendCommunication` now calls
  `screenOutreachCopy` itself, closing a gap where any caller could put
  impersonating copy in front of a provider.
- **Provider truth fixed.** `SimulatedCommunicationProvider.health()` previously
  returned `HEALTHY`; it now reports `NOT_CONNECTED` with a `SIMULATED / TEST_ONLY`
  label, so a test adapter can never read as a connected provider.
- Opt-out suppression works with **no provider connected** — it is a local
  safety control and must not depend on an external round trip.

---

## Phase 11.6 — Service execution, QA and delivery hardening

Audit findings closed:

| Finding | Fix |
|---|---|
| **F3 HIGH** — `createEngagement` never read the offer's `halalStatus` | Engagement creation now enforces the stored verdict: `BLOCKED`/`UNVERIFIED` refused, `REVIEW_REQUIRED` requires an explicit audited admin override. |
| **F3 HIGH** — the runner's halal gate keyed on `payload.opportunityId`, absent from service payloads | `executeServiceJobViaRunner` now re-checks the linked offer's verdict at execution time and **fails closed** if the offer cannot be read. |
| **F16 MED** — 3 sub-routes acted on a body id, never compared to the path engagement | `deliverable-state`, `revision-classify`, `issue-resolve` and `milestone-pay` now take the path `engagementId` and refuse cross-engagement access, with an audited IDOR refusal. The same check was added to the job runner. |
| **F6 MED** — an admin-supplied `halalStatus` skipped screening entirely | The screen **always** runs. A caller-supplied status may only move the verdict *more* conservative, never less. |
| **F12** — simulated adapter reported `HEALTHY` | Reports `NOT_CONNECTED` + `SIMULATED`. |

Added execution gates: **cancellation/termination** and **payment reversal**
(`paymentState === 'REFUNDED'`) now block work at the runner, so a future change
to the authorized-state list cannot re-open execution on a cancelled engagement.

---

## Phase 11.7 — Revenue, cost, P&L and learning

### The gap
Phase 11.3 recorded service revenue but had **no engagement-level cost**, so
per-engagement P&L was impossible and `MARGIN_OUTCOME` was measuring *price*
and calling it a margin.

### What was added
- **`EngagementCost`** with an explicit `basis`: `ACTUAL` requires evidence
  (an unevidenced "actual" is a fabricated cost and is refused); `ESTIMATED` does
  not, and is never summed into realized profit.
- **`Revenue.serviceEngagementId` / `milestoneId` / `paymentEventId`** — the
  attribution that makes per-engagement P&L computable at all.
- **`Revenue.revenueBasis`** — `ACTUAL | ESTIMATED | PROJECTED | SIMULATED`.
  Totals use ACTUAL rows only. A projection or simulation is reported in its own
  bucket and can never be summed as income.
- **`economics.ts`** — per-engagement P&L and portfolio economics. Profit =
  recognized revenue − ACTUAL cost. Margin is `UNKNOWN` (not zero) when no cost
  is recorded. Sample sizes are always reported.
- **`recommendOptimizations()`** — `requiresHumanApproval` is typed `true` and
  `actionable` is false below the sample bar, so a 1-of-1 result is never
  presented as a finding.

### Learning fixes
| Finding | Fix |
|---|---|
| **F13** — 12 signals declared, 10 emitted | All 12 now emitted, including `OPPORTUNITY_CONVERTED` and `OPPORTUNITY_FAILED_VALIDATION`. |
| **F13** — `MARGIN_OUTCOME` measured price | Now a real margin over engagements with *both* realized revenue and a recorded actual cost. |
| **F13** — `BLOCKED_OPPORTUNITY` counted `ServiceIssue` rows | Counts real blocked/unscreened **offers**. |
| **F13** — `HALAL_REVIEW_OUTCOME` hardcoded a HALAL verdict and stamped `VERIFIED_DATA` | Reports the real persisted offer-verdict distribution. |
| **F13** — no dedupe key | Deterministic `commercial:{kind}:{day}:{evidenceDigest}`; a repeat observation creates no row. |
| **F14** — optimizer filtered on a null `opportunityId` | Commercial signals are discovered by their `context` prefix instead. |
| **F15** — commercial entries capped at 5 | Raised to 50. |

---

## Phase 11.8 — Production readiness

Audit outcomes:

- **HSTS was absent** from the edge header set. Added, emitted only for HTTPS so
  a plain-HTTP dev session is not stranded.
- **SSRF**: research fetch already had a full allowlist + DNS-rebinding guard.
  The Ruflo runtime client validated *protocol* only, so a mis-set base URL could
  reach loopback, RFC1918 or `169.254.169.254`. It now **reuses the existing
  `isAllowedResearchUrl` guard** rather than adding a second, weaker list.
- `production-readiness.test.ts` turns the audit into structural regression
  tests: no engagement state reaches `WORK_AUTHORIZED` except from
  `PAYMENT_VERIFIED`; terminal states have no outgoing edges; `DRAFT` cannot
  reach `DELIVERED`/`ACCEPTED`; the generating system cannot self-certify QA;
  no `paid` boolean exists; the client layer still has **no** write path into
  any commercial table; the Phase 11.1 suites are inside the default test glob;
  the migration contains no destructive SQL.

---

## Phase gates

| Gate | Result |
|---|---|
| 11.4 payment security, revenue idempotency, replay, unauthorized verification, UNPAID→EXECUTING, admin-only manual | pass |
| 11.5 communication, opt-out, duplicate prevention, rate limits, inert injection, no impersonation, truthful provider status | pass |
| 11.6 payment gate, execution state, QA fail-closed, delivery, duplicate execution, cancellation/refund, authorization | pass |
| 11.7 revenue/cost/P&L/learning/sample sizes, no fabricated metrics | pass |
| 11.8 full audit + regression | pass |

## Provider reality

| Provider | State |
|---|---|
| Polar (service payments) | **NOT_CONNECTED** — no `POLAR_WEBHOOK_SECRET` in this environment. The route returns 503 and changes nothing. |
| Communication (all channels) | **NOT_CONNECTED** — no provider adapter is implemented. |
| Ruflo runtime | **NOT_CONNECTED** (now SSRF-guarded). |
| AI | **MOCKED**. |
| Service execution | In-process, bounded, deterministic. |

No live external E2E verification is claimed anywhere in this phase.
