# Phase 11.1 — Secure Income Foundation (implementation notes)

Implements the Phase 11.1 scope from `docs/phase-11-design.md` (Phase 11.0, PR #18):
**Prospect + Conversation + Message + trust/security layer**. Design is unchanged;
this document records what was built and where.

## What exists now

### Schema (additive-only migration `0008_client_foundation`)
- `Prospect` — business-level contact only (PII minimization). Lifecycle + risk
  states default `NEW`; mandatory provenance (`source` ∈ DISCOVERY_PROVIDER |
  INBOUND | REFERRAL | MANUAL + sourceProvider/sourceRef/evidenceRefs); deterministic
  risk counters; outreach-protection fields (optedOut/optedOutAt/lastContactedAt/
  contactAttempts/suppressionReason). `@@unique([email])` = duplicate-outreach
  prevention. Indexes on lifecycleState, riskState, optedOut.
- `Conversation` — prospect relation, channel (EMAIL | PORTAL | API), state
  (OPEN | REQUIREMENTS_READY | PROPOSAL_PENDING | CLOSED_BLOCKED | CLOSED_LOST |
  CLOSED_COMPLETED), injectionFlagCount, prospectMessageCount.
  Index `(prospectId, state)`.
- `Message` — conversation relation, direction (INBOUND | OUTBOUND_INTERNAL |
  OUTBOUND_CLIENT), role (CLIENT | SYSTEM_DRAFT | AGENT | ADMIN), bounded body,
  providerMessageId/providerStatus, trustFlags (validated JSON array),
  `treatedAs` (constant `DATA`), `immutable` (constant `true`).
  `@@unique([conversationId, providerMessageId])` = provider replay protection
  (NULLs distinct in both PostgreSQL and SQLite, so non-provider rows are
  unaffected). Index `(conversationId, createdAt)`.

Deliberately absent (Phase 11.2+): Proposal, ProposalVersion, ServiceEngagement,
Milestone, Deliverable, ServiceIssue, email providers, outreach execution,
payment-verification changes.

### Core library (`src/lib/clients/`)
- `prospect-states.ts` — validated state constants, deny-by-default lifecycle
  transition table (`NEW → CONTACTED` impossible; CONTACTED only from QUALIFIED
  via `approvedContactTransition` with an approval reference; no casual
  CLIENT→prospect demotion), and the **deterministic risk engine**
  (`evaluateRisk`): ordered rules → HIGH_RISK / REVIEW_REQUIRED / LOW_RISK /
  NORMAL / UNVERIFIED with explainable reasons. The engine structurally cannot
  produce `PAYMENT_VERIFIED`.
- `message-classifier.ts` — bounded, offline, deterministic classifier: 10 trust
  flags, 9 first-pass categories, pattern rules with normalization
  (NFKC, zero-width stripping, markdown/punctuation stripping, bounded
  split-token collapse) covering prompt injection, credential requests, payment
  claims, free-work requests, scope changes, urgency pressure, halal-violation
  pressure, history manipulation, abuse, and resource waste. No API key; live
  AI is never a prerequisite (deterministic signals always win by construction).
- `client-service.ts` — the single write path: bounded validation (message body
  ≤ 10,000 chars, oversize REJECTED not truncated), object-level loads, immutable
  message persistence, counter updates, SecurityEvents for every deterministic
  security flag, HumanReview (existing `SAFETY_REVIEW` queue) for suspected
  prompt injection, provider-replay collapse to the stored row, opt-out
  recording, and the hard `PAYMENT_VERIFIED` gate
  (`paymentVerificationSource` ∈ PROVIDER_WEBHOOK | PROVIDER_API |
  MANUAL_ADMIN_APPROVED + reference required).

### API (admin-only; existing `requireAdminApi` + rate limit + audit conventions)
- `GET/POST /api/clients/prospects`
- `GET /api/clients/prospects/[prospectId]`
- `POST /api/clients/prospects/[prospectId]/lifecycle` (state machine + CONTACTED gate)
- `POST /api/clients/prospects/[prospectId]/risk-state` (PAYMENT_VERIFIED hard gate)
- `POST /api/clients/prospects/[prospectId]/opt-out`
- `GET/POST /api/clients/conversations`
- `POST /api/clients/conversations/[conversationId]/state` (closed = immutable)
- `GET/POST /api/clients/messages` (THE security boundary)

### Invariants enforced (spec §9–§25)
- Messages are DATA, never authority: message ingestion cannot mutate
  permissions, budgets, halal state, governance, or payment state — there is no
  code path from `recordClientMessage` to any privileged write.
- `PAYMENT_VERIFIED` never from client claims: claims become `PAYMENT_CLAIM`
  flags; only the gated risk-state endpoint with a real verification source
  can set it.
- Lifecycle: `NEW → CONTACTED` forbidden; CONTACTED requires
  `contactApprovalRef` from QUALIFIED (gated helper); closed conversations and
  messages are immutable.
- Security response to injection: store immutable → flag → increment counters
  (Conversation.injectionFlagCount, Prospect.injectionFlags) → SecurityEvent
  (no message content, no secrets in detail) → HumanReview SAFETY_REVIEW →
  nothing executed.

## Verification (this branch)

- `npx prisma7 validate` — PASS (45 models)
- `node scripts/check-migration-drift.mjs` — NO DRIFT; destructive SQL audit CLEAN (additive only)
- `npm run pretest` — regenerated SQLite test schema with new models
- Focused: `src/lib/clients/__tests__/` — **67/67 pass** (41 pure + 26 hermetic DB through real routes)
- Full suite: **1161 tests — 1160 pass / 0 fail / 1 skipped (pre-existing)**
- `npx tsc --noEmit` — exit 0
- `npx eslint` on all new paths — 0 errors, 0 warnings
- `npm run build` — exit 0

## Digital products / micro-services unaffected

No existing model, route, job type, or factory path was modified. A digital
product still never requires a Prospect/Conversation/Message. Migration 0008 is
additive-only (three new tables, indexes, FKs — no ALTER of existing tables).

## Out of scope (later phases)

Email provider, outreach sending, prospect discovery providers, proposals,
ServiceEngagement/Milestone/Deliverable/ServiceIssue, payment verification
wiring, service execution job types, Observatory/Control Center redesign,
multi-user auth.
