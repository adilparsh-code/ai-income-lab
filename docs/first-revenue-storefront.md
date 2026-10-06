# First-Revenue Storefront Runbook

How the public acquisition surface works and how to take the **first
legitimate halal sale** with it. This is the operational companion to the
`ai-income-lab-income-readiness-audit.md` recommendation (Section 17):
*"a public-facing acquisition surface plus the minimal connected path to the
first real sale."*

## What exists now

| Piece | Route / module | Auth |
|---|---|---|
| Public landing + catalog | `/store` (`src/app/(storefront)/store/`) | Public |
| Offer detail + purchase request | `/store/[offerId]` | Public |
| Purchase-request intake | `POST /api/store/inquiries` | Public, rate-limited (10/min/IP), same-origin, bounded, validated |
| Operator console view | `/storefront` (gated `(admin)` route group) | Admin session |
| Public listing gate | `src/lib/storefront/eligibility.ts` | Fail-closed, pure |
| Inquiry orchestration | `src/lib/storefront/store.ts` | Reuses Prospect/Conversation/Message |
| Funnel events | `POST /api/events` (existing) with `source=storefront` | Public, rate-limited (existing) |

**No schema change. No new payment system. No new revenue system.** Inbound
requests reuse the existing `Prospect` (source `INBOUND`, provider
`STOREFRONT`) / `Conversation` (channel `PORTAL`) / `Message` security
boundary, and revenue is still recorded through the existing Revenue page /
revenue actions.

## Public listing gate (fail-closed)

An offer appears on `/store` only when **all** hold:

1. `status === 'ACTIVE'` (operator selling gate),
2. `price > 0`,
3. `halalStatus === 'HALAL'`,
4. display-time `screenForHalalCompliance()` on title + description/scope
   returns `HALAL` (prohibited keywords or review-required terms drop it).

Anything else is listed nowhere publicly; `/storefront` shows the exact
blocking reasons per offer.

## Taking the first sale

1. **Publish an offer**
   - `POST /api/commercial/offers` (admin) with `type`, `title`,     `description`, `scopeSummary`, `price` — then set it `ACTIVE` via
   `POST /api/commercial/offers/[offerId]` (status transitions are
   deny-by-default: ACTIVE requires price > 0 and a screened halal status).
   - Confirm it appears under **Storefront → Offer listing readiness** as
     *Listed* and at `/store`.
2. **Share `/store`** with a real buyer (any external channel you already
   use — social, community, DM).
3. **Buyer sends a purchase request** → recorded as an inbound lead with a
   PORTAL conversation. The buyer message is immutable DATA; payment claims
   inside messages are flagged, never believed.
4. **Qualify and deliver.** For a digital product: deliver after payment.
   For a service: use the existing Offer → Proposal → Engagement pipeline
   and its delivery state machine.
5. **Verify the real payment yourself.** For engagements:
   `recordManualPaymentVerification` (reviewer + reason + evidence refs,
   `MANUAL_ADMIN_APPROVED`). For a simple product sale, confirm the payment
   event in the external marketplace/bank before delivering.
   *A screenshot or “I sent it” message is never payment evidence.*
6. **Record revenue** on `/revenue` (existing manual entry) with a reference
   note pointing at the evidence. `revenueBasis` stays `ACTUAL` only for
   evidence-backed receipts.
7. **Learn**: funnel events (`PRODUCT_VIEW`, `CTA_CLICK`, then `PURCHASE`
   recorded via `POST /api/events`) show where buyers drop off.

## Security properties of the intake

- Per-IP DB-backed rate limit (10/min) + central same-origin middleware
  boundary + `requireSameOriginIfBrowser` re-check.
- Size-capped strict JSON parse; bounded fields; control characters rejected.
- Honeypot field: bots are acknowledged and dropped with no write.
- Offer re-verified server-side as publicly listable (halal fail-closed)
  before anything is persisted.
- Idempotent: prospect email is unique; messages carry
  `providerMessageId = storefront:<requestId>` so double-submits collapse.
- Identical success response for new/duplicate/honeypot → no enumeration of
  known buyers or offers.
- Every outcome writes a `SecurityEvent` (`STOREFRONT_INQUIRY`) — ids only,
  never message content or secrets.

## Verification

```bash
bun run typecheck
bun run lint
bun run test        # includes src/lib/storefront/__tests__/
```

## Explicitly out of scope (next steps, not this slice)

- Polar publishing/payment automation (needs provider credentials).
- Email outreach to inbound leads (needs a communication provider).
- Real traffic and the real first payment — only obtainable outside the
  repository.
