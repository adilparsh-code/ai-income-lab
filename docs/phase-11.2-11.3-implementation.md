# Phase 11.2 + 11.3 — Governed Income Pipeline

**Status**: implemented and verified on `feat/phase11.2-11.3-income-pipeline`.

Builds the governed commercial foundation and the bounded execution/delivery
loop on top of the merged Phase 10A (Agent Control Center) and Phase 11.1
(Secure Income Foundation). Implements `docs/phase-11-design.md` (Phase 11.0);
no part of that design was redesigned.

---

## 1. Three income engines, one pipeline

`Offer.type` is the single fork, and everything downstream is shared:

| Offer type | Route | Commercial shape | Execution jobs |
|---|---|---|---|
| `DIGITAL_PRODUCT` | `DIGITAL_PRODUCT_WORKFLOW` | `SELF_SERVE` | existing `PRODUCT_CREATE/BUILD/TEST/DEPLOY/PUBLISH` |
| `MICRO_SERVICE` | `MICRO_SERVICE_WORKFLOW` | `PROPOSAL` | new `SERVICE_BUILD/QA/DELIVERY` |
| `CLIENT_SERVICE` | `CLIENT_SERVICE_WORKFLOW` | `PROPOSAL` | new `SERVICE_BUILD/QA/DELIVERY` |

Both service routes use the **same** bounded job-type set, so a micro-service is
a smaller engagement rather than a parallel architecture. All routes reuse the
existing Job Runner, AgentRun, Supervisor, halal gates, Revenue ledger,
LearningEntry, Observatory and Agent Control Center.

## 2. Migration `0009_income_pipeline` (additive only)

Nine new tables, no existing table altered:

- **11.2** — `Offer`, `Proposal`, `ProposalVersion`, `ScopeItem`, `ScopeChangeRequest`
- **11.3** — `ServiceEngagement`, `Milestone`, `Deliverable`, `ServiceIssue`

Reused unchanged: `Opportunity`, `Product`, `Revenue`, `JobRun`, `AgentRun`,
`HumanReview`, `LearningEntry`, `SecurityEvent`, `IntegrationAuthorization`.

`node scripts/check-migration-drift.mjs` → **NO DRIFT**, **CLEAN (additive only)**.
`npx prisma7 validate` → valid (54 models).

## 3. Hard invariants (enforced in code, not documented)

1. **An Offer is an ask.** `Offer.paymentState` defaults to
   `NOT_PAYMENT_VERIFIED` and there is no input path that sets a paid state at
   creation. `Offer.estimatedMargin` is always derived (`price − cost`).
2. **Versions are append-only.** `createProposalVersion` only ever CREATEs a
   row and derives the version number server-side; there is no code path that
   updates an existing version's commercial terms. Sending freezes every version
   (`locked` is a one-way latch).
3. **Sending is admin-gated.** `SENT` requires `actor: ADMIN` **and**
   `approvalState: APPROVED_FOR_SEND`. A client message reaches none of these
   paths.
4. **Acceptance requires evidence.** `ACCEPTED` requires structured evidence of
   type `PROVIDER_PAYMENT | EXPLICIT_CLIENT_MESSAGE | SIGNED_DOCUMENT |
   MILESTONE_ACCEPTANCE | ADMIN_VERIFIED`. **Silence is never acceptance.**
5. **Scope is finite.** Scope items carry `IN_SCOPE | OUT_OF_SCOPE | ASSUMPTION |
   CHANGE_REQUEST`. A request matching no `IN_SCOPE` item becomes a
   `ScopeChangeRequest` in `REVIEW_REQUIRED`, is paid by default
   (`requiresPayment = true`), and is never auto-priced into a version.
6. **Revisions are finite.** `revisionAllowance` lives on the immutable version
   (so raising it is itself a priced change). Exceeding it lands in
   `REVISION_LIMIT_REACHED`, which has no path out except `WITHHELD`.
7. **Payment truth has exactly three sources.** `PROVIDER_WEBHOOK |
   PROVIDER_API | MANUAL_ADMIN_APPROVED` — enforced on `Offer`,
   `ServiceEngagement`, `Milestone` and `recordServiceRevenue`.
8. **UNPAID → EXECUTING is impossible.** `WORK_AUTHORIZED` is reachable only
   from `PAYMENT_VERIFIED`. The only exception is an explicitly configured
   low-risk exception, **OFF by default**, requiring `exposureCapUsd > 0` and a
   `LOW_RISK | PAYMENT_VERIFIED` prospect, and always SecurityEvent-audited.
   The Job Runner re-checks this gate independently and **fails closed** when it
   cannot evaluate it.
9. **Generation ≠ QA ≠ delivery ≠ acceptance.** There is no `DRAFT → DELIVERED`
   edge. A final release needs `QA_PASSED` + `READY_FOR_DELIVERY` +
   `DELIVERY_AUTHORIZED`. QA fails closed: an unreported check is not a passed
   check.
10. **Revenue is evidence-backed.** `recordServiceRevenue` has no `paid: true`
    body field. The `Revenue.idempotencyKey` is derived from
    `(engagement, milestone, verificationRef)`, so a replayed verified payment
    is a no-op rather than a double count.
11. **Halal screening is conservative.** `BLOCKED` beats `REVIEW_REQUIRED` beats
    `UNVERIFIED` beats `HALAL`. An unscreened offer/opportunity is `UNVERIFIED`,
    never assumed compliant. Screening is an operational control, not a ruling.
12. **No fabricated market numbers.** A score dimension without evidence is
    `UNVERIFIED` and contributes **nothing** to the composite; it is never
    imputed or defaulted.
13. **Client messages are DATA.** Verified end to end: a hostile message
    containing a payment claim, a receipt, prompt injection, a "bypass the
    gates" demand and scope creep changes no offer payment state, no proposal
    state, no approval state, no prospect risk state, and creates no revenue.
14. **Truthful AI identity.** If asked directly whether it is AI, the system
    answers truthfully; no code path can produce an impersonating reply.
15. **Truthful providers.** No communication provider is connected. The
    abstraction and a deterministic test adapter exist; production
    `resolveCommunicationProvider()` returns `NOT_CONNECTED` and refuses to
    send, never fabricating a provider message id.

## 4. Modules

```
src/lib/commercial/
  offer-states.ts             pure enums, deny-by-default offer transitions, margin, payment gate
  proposal-states.ts          pure proposal machine, evidence parser, scope classifier, revision limits
  offer-service.ts            Offer writes/reads, server-side halal screening, derived margin
  proposal-service.ts         Proposal + immutable versions + scope change requests
  engagement-states.ts        engagement / milestone / deliverable / issue state machines
  engagement-service.ts       execution, delivery, issues, evidence-backed revenue
  opportunity-routing.ts      deterministic routing + scoring + discovery provenance
  micro-services.ts           bounded micro-service catalogue + QA evaluation
  communication-provider.ts   provider abstraction, NOT_CONNECTED resolver, test adapter
  outreach-safety.ts          outreach bounds, forbidden claims, truthful identity
  commercial-summary.ts       read-only Observatory aggregation
  commercial-learning.ts      learning signals from real persisted events
src/app/api/commercial/       5 admin-only routes
```

## 5. APIs (admin-only, rate-limited, audited)

| Route | Methods |
|---|---|
| `/api/commercial/offers` | GET, POST |
| `/api/commercial/offers/[offerId]` | GET, POST (`status` \| `payment`) |
| `/api/commercial/proposals` | GET, POST |
| `/api/commercial/proposals/[proposalId]` | GET, POST (`approve` \| `state` \| `version` \| `change-request` \| `resolve-change`) |
| `/api/commercial/engagements` | GET, POST |
| `/api/commercial/engagements/[engagementId]` | GET, POST (8 actions) |
| `/api/commercial/summary` | GET |

All use `requireAdminApi`, `clientIpFrom`, `enforceRateLimit`, `readJsonBody`,
`auditSecurityEvent`. No body field is authority; every enum and transition is
validated server-side.

## 6. Observability

- `ObservatoryView.commercial` — real row counts across prospects, offers,
  proposals, scope reviews, engagements, payment, delivery, issues, learning.
- One integration-health row per communication channel, derived from the
  providers' own health descriptors (all `NOT_CONNECTED`).
- `CustomerInteractionView` now reflects the existing abstraction while still
  reporting `NOT_CONNECTED`.
- Revenue is summed only when a single USD currency is present; otherwise it is
  reported `UNKNOWN` rather than guessed.

## 7. Learning

`deriveCommercialSignals()` derives 12 signal kinds from counted rows only, with
sample sizes reported alongside every signal so a 1-of-1 result is never shown
as a validated pattern. `MIN_VALIDATED_SAMPLE = 3`. Learning writes
`LearningEntry` rows (records only) and can never relax a safety gate.

## 8. A real bug this phase found and fixed

`createProposalVersion` originally refused whenever the previous version was
`locked`. That is backwards: locking is precisely *why* a change creates a new
version. Immutability is now enforced **structurally** — the function only
creates, and the version number is always derived server-side — so a locked
version's terms are never mutated and a change always produces version N+1.

## 9. Test-suite fix

`src/lib/clients/__tests__/*.test.ts` (67 Phase 11.1 tests) was **not** in the
`npm test` glob, so those tests had never run in CI. The glob now includes both
`src/lib/clients` and `src/lib/commercial`, taking the suite from 1186 to 1385
tests with no previously-passing test changed.

## 10. Verification

| Gate | Result |
|---|---|
| Focused tests | 82 pure + 37 hermetic DB + 13 Job Runner = **132**, all pass |
| Full suite | **1385 tests, 1384 pass, 0 fail, 1 skipped (pre-existing)** |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run build` | compiled successfully |
| `npx prisma7 validate` | valid (54 models) |
| Migration drift | NO DRIFT / CLEAN (additive only) |

## 11. Integration status — truthful

| Integration | State |
|---|---|
| Internal Job Runner / AgentRun / Supervisor | CONNECTED (this deployment) |
| Service execution (internal bounded) | AVAILABLE — in-process, no external provider |
| Digital-product publishing | NOT_CONFIGURED (pre-existing) |
| Client communication — EMAIL / CLIENT_PORTAL / MESSAGING | **NOT_CONNECTED** |
| Communication test adapter | SIMULATED / test-only, refuses production use |
| Prospect discovery | NOT_CONNECTED — no provider configured, zero candidates fabricated |