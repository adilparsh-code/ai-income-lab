# Private delivery — paid assets, one buyer, no public links

Status: **rules implemented and tested offline; NOT enabled against a live
provider.** No route, no table and no storage bucket is wired yet — see
[Activation checklist](#activation-checklist).

## What this is

A buyer pays for a product (a package, a document, a deliverable file) and must
receive **that** asset, **once**, and **only to them**. The rest of the
commercial stack already proves that money arrived
(`PaymentEvent`, `ServiceEngagement.paymentState`, the engagement state
machine). This module covers the other half of the promise: the *delivery*.

## The invariants

| # | Invariant | Where it is enforced |
|---|---|---|
| 1 | An entitlement comes from an **evidence-backed payment**, never from a client claim, a price or a payload | `evaluateEntitlement()` reads the payment ledger through `DeliveryStorePort.findVerifiedPayment()` |
| 2 | An entitlement is bound to **one buyer**; a substituted buyer id is refused without disclosing the real owner | `evaluateEntitlement()`, `issueDeliveryTicket()`, `redeemDeliveryTicket()` |
| 3 | The bytes are pinned by **sha256 content hash** at issue time and re-verified against the private storage before a handle is issued | `redeemDeliveryTicket()` → `PrivateStoragePort.verifyContentHash()` |
| 4 | The ticket is **single use**: exactly one `(ticket, deliveryId)` pair may spend it | `DeliveryStorePort.consumeTicket()` — an atomic compare-and-set in the durable adapter |
| 5 | **No public URL** is ever produced; the storage returns a short-lived, buyer-scoped handle that is never persisted | `PrivateStoragePort.openForBuyer()` |
| 6 | An **unknown commit** is reported as `PENDING`, never as `DELIVERED` | `redeemDeliveryTicket()` + `reconcileDelivery()` |

## Layout

```
src/lib/delivery/
  ports.ts              interfaces only: store, private storage, ticket signer, records
  private-delivery.ts   the rules (no I/O of its own; every side effect goes through a port)
  offline-fakes.ts      in-memory store + private storage + keyed HMAC signer
  __tests__/            offline test suite (node:test, no database, no network)
```

The rules deliberately do not know about Prisma, Vercel or any provider. A live
adapter implements the same port and the rules stay unchanged — which is also
why the whole flow can be exercised offline today.

## The flow

```
payment (evidence-backed)          entitlement              ticket                 redemption
─────────────────────────  ──────────────────────────  ──────────────────────  ─────────────────────────
findVerifiedPayment(orderId) →  orderId + buyerId +       issueDeliveryTicket()   redeemDeliveryTicket()
  · no payment   → DRAFT        assets (hash-pinned)      · owner check            · ticket → fingerprint lookup
  · wrong buyer  → refused      · deterministic id        · raw token minted       · buyer re-checked
  · zero amount  → refused        (order|buyer|version)  · only the fingerprint   · hashes re-verified
                                    → GRANTED              · TTL 15 min (bounded)   · handles opened (private)
                                                                    ↓             · ticket spent (atomic, once)
                                                            token returned once     · delivery recorded
                                                                                     → DELIVERED
```

Both ids are deterministic, which is what makes retries safe:

- `ent_<sha256(order|buyer|version)>` — one entitlement per order+buyer.
- `dlv_<sha256(ticket|buyer)>` — one delivery per ticket+buyer.

A retry therefore lands on the same rows instead of creating a second
entitlement or a second delivery.

## Unknown-commit protocol

A durable write has three outcomes, never two: **committed**, **not committed**,
**unknown**. The unknown case is the interesting one — the ticket may or may not
have been spent.

1. `consumeTicket()` returns `STORE_UNAVAILABLE` → the attempt reports
   `PENDING` with `COMMIT_UNKNOWN`, and a `PENDING` delivery row is written
   (best effort).
2. The buyer retries, or an operator runs `reconcileDelivery()`. Both use the
   **same** deterministic delivery id:
   - the ticket was spent → the store reports `ALREADY_CONSUMED` → the delivery
     completes and is reported `DELIVERED`;
   - the ticket was not spent → the store reports `CONSUMED` → same result.
3. Either way the outcome is exact. It is never guessed, and `PENDING` is never
   upgraded to `DELIVERED` without the durable record.

The same rule applies to the other two ambiguous points: a delivery whose
record could not be written is reported `PENDING`
(`DELIVERY_RECORD_UNAVAILABLE`), and an unreadable store is reported `PENDING`
(`STORE_UNAVAILABLE`) — never `DELIVERED`, and never "invalid ticket".

## User-visible status

`deliveryStatus()` reads the durable records only; the precedence is
deliberately pessimistic.

| Status | Meaning |
|---|---|
| `DRAFT` | Nothing is entitled yet, the payment is not verified, or the assets are not review-ready |
| `REVIEW_READY` | Entitled, assets final, delivery can run |
| `UNAVAILABLE` | Private storage is not configured or not serving |
| `PENDING` | A ticket is waiting to be redeemed, or an outcome is not yet settled |
| `FAILED` | The attempt was refused (wrong buyer, tampered asset, spent ticket) |
| `REVOKED` | The entitlement or the ticket was revoked or has expired |
| `DELIVERED` | The assets were handed over and the fact is durably recorded |

## Offline verification

```bash
npx tsx --test src/lib/delivery/__tests__/*.test.ts   # 29 tests
npm run typecheck
npm run lint
```

The suite is hermetic: real HMAC and sha256 over synthetic bytes, an in-memory
store and storage fake, no network, no database.

## Activation checklist

Live private delivery stays **off** until all of the following exist and are
verified. The rules are written against ports, so each item is an adapter, not
a rewrite.

- [ ] **Durable persistence.** Tables for entitlements, tickets and deliveries,
      added with an additive migration (`prisma/migrations/00xx_…`) plus the
      matching `prisma/schema.prisma` models. The drift check
      (`npm run prisma:drift-check`) must stay clean. `consumeTicket()` must be
      an atomic compare-and-set — a conditional `UPDATE … WHERE state = 'ISSUED'`
      that returns the updated row, or a serializable transaction.
- [ ] **Payment ledger adapter.** `findVerifiedPayment()` must read the
      existing `PaymentEvent` rows (`outcome = 'ACCEPTED'`,
      `signatureVerified = true`) and derive the buyer from the engagement's
      prospect — never from request data.
- [ ] **Private storage adapter.** A private bucket with per-buyer,
      short-lived reads. `openForBuyer()` must fail closed for an unknown
      asset, and must never return a public URL.
- [ ] **Ticket signing secret.** A server-side secret for the keyed HMAC
      (see `createHmacTicketSigner()`); never a client value, never committed.
- [ ] **Authentication.** A route that derives the buyer id server-side from
      the session. The buyer id is an input to the rules, never an assertion
      the client can make.
- [ ] **Rate limiting and audit.** Reuse `src/lib/security/guard.ts`
      (`enforceRateLimit`, `auditSecurityEvent`) for ticket issuance and
      redemption.
- [ ] **Reconciliation job.** A scheduled pass over `PENDING` delivery rows
      that settles them with `reconcileDelivery()`.

Until every box is ticked, `PrivateStoragePort` is `null` and every delivery
attempt fails closed with `UNAVAILABLE`.
