# Private Delivery — Durable Persistence Contract

Status: **proposal, not applied.** The tables live only in
`prisma/proposals/private-delivery/schema.prisma`. The active application
schema (`prisma/schema.prisma`) is untouched, and no migration has been run
against any database.

| Concern | File |
| --- | --- |
| The rules | `src/lib/delivery/private-delivery.ts` |
| The ports | `src/lib/delivery/ports.ts` |
| The durable binding (the only module that talks to a database) | `src/lib/delivery/private-delivery-client-binding.ts` |
| The buyer-safe projection | `src/lib/delivery/delivery-view.ts` |
| The offline doubles | `src/lib/delivery/offline-fakes.ts` |
| The schema contract + drift checker | `src/lib/delivery/private-delivery-schema.ts` |
| The isolated proposal | `prisma/proposals/private-delivery/schema.prisma` |
| Isolated proposal validation | `scripts/verify-private-delivery-proposal.mjs` |
| Offline tests (rules) | `src/lib/delivery/__tests__/private-delivery-persistence.test.ts` |
| Offline tests (durable binding) | `src/lib/delivery/__tests__/private-delivery-client-binding.test.ts` |
| Offline tests (buyer-safe view) | `src/lib/delivery/__tests__/delivery-view.test.ts` |

---

## 1. What the durable ticket must preserve

A buyer must receive **exactly** the asset they paid for, **once**, and
**only to them**. The durable record of that promise has to carry:

| Requirement | Where it lives | Why |
| --- | --- | --- |
| Ticket id | `DeliveryTicket.id` | the handle the buyer holds |
| Token **digest** only | `DeliveryTicket.tokenFingerprint` (unique) | the raw bearer token is NEVER stored, so a database dump cannot be replayed into a download |
| Buyer association | `DeliveryTicket.buyerId` | every step re-checks the binding |
| Order association | `DeliveryTicket.orderId` | the hold check and the audit trail are per order |
| Entitlement association | `DeliveryTicket.entitlementId` | the ticket is always traceable to what it was issued for |
| Immutable package id | `DeliveryTicket.packageId` | the ticket says which package was sold |
| Immutable version id | `DeliveryTicket.productVersionId` | the ticket says which version was sold |
| Order association on the delivery | `DeliveryRecord.orderId` | the audit trail of what was handed over is per order |
| Immutable asset id | `DeliveryTicketAsset.assetId` | the ticket says which assets were sold |
| Immutable content digest | `DeliveryTicketAsset.contentHash` | the promise is pinned to bytes, re-verified against private storage before any handle is handed out |
| Creation timestamp | `DeliveryTicket.issuedAt` | audit |
| Expiry timestamp | `DeliveryTicket.expiresAt` | an expired ticket is refused, not silently extended |
| Single-use state | `DeliveryTicket.state`, `consumedAt`, `consumedByDeliveryId` | exactly one delivery id may hold a ticket |
| Revocation evidence | `DeliveryTicket.revokedAt`, `revocationReason` | a revoked ticket is refused |
| Consumption evidence | `DeliveryTicketEvent` | issuance, consumption, revocation, expiry and refusals are all recorded |
| Audit metadata, no personal data | every table | only ids, digests, bounded reasons and timestamps. No email, no name, no card data, no raw token, no storage handle |

### The unique constraints that make it safe

| Constraint | Effect |
| --- | --- |
| `DeliveryTicket.tokenFingerprint` is unique | one row per bearer token; a token can never be bound to two tickets |
| `DeliveryTicket @@unique([entitlementId, tokenFingerprint])` | one live token per entitlement |
| `DeliveryEntitlement @@unique([orderId, buyerId, productVersionId])` | one entitlement per order, buyer and version |
| `DeliveryEntitlementAsset @@unique([entitlementId, assetId])` | the same asset is never granted twice |
| `DeliveryTicketAsset @@unique([ticketId, assetId])` | the pinned asset list is unambiguous |
| `DeliveryTicketEvent @@unique([ticketId, kind, reference])` | the same audit event is never written twice |
| `DeliveryRecord.deliveryId` is the primary key | the deterministic delivery id makes a retry an upsert, never a second delivery |

### What the database does NOT do

* The **version binding** is enforced by the application, not by the
  database: the ticket stores the version it was issued for, and redemption
  compares it with the entitlement's current version. A database trigger
  could do this too; it is not in the proposal.
* **Single use** is a compare-and-set, not a uniqueness constraint: the
  ticket's `state` transitions `ISSUED → CONSUMED` only when the row still
  reads as `ISSUED` and belongs to the requesting buyer. The uniqueness
  constraints above make a *duplicate* impossible; they do not by themselves
  make a *double spend* impossible.
* **Expiry** is evaluated against the caller's clock, the same as the
  adverse-intake lease. The database clock is not consulted.
* **The access hold** lives in the adverse-intake proposal
  (`AdverseHold`). The delivery store reads it through the
  `findAccessHold` port; a delivery adapter implements that port by querying
  the hold table. The two proposals are related but independent, and neither
  has been applied.

---

## 2. The adapter contracts a real implementation must satisfy

The rules in `private-delivery.ts` are written against three ports. A real
deployment needs three adapters. These are the requirements on them.

### 2.1 `DeliveryStorePort`

| Method | Contract |
| --- | --- |
| `findVerifiedPayment(orderId)` | reads the **existing** payment ledger; never assembles a payment from request data. A missing payment means "not paid", never "assume paid". |
| `findEntitlement` / `findEntitlementByOrder` | read the durable entitlement. A read that fails must **throw**, so the caller can report PENDING instead of "not entitled". |
| `saveEntitlement` | idempotent on `entitlementId`. The id is deterministic, so a retry converges on one row. |
| `revokeEntitlement` | sets the revoked state and records the reason. Idempotent. |
| `findTicket` / `findTicketByFingerprint` | the fingerprint is a **keyed** HMAC; the lookup by fingerprint is how a redemption finds its ticket without storing the token. |
| `saveTicket` | idempotent on `ticketId`; stores the **pinned** asset list with their content digests. |
| `expireTicket` | best effort, idempotent. |
| **`consumeTicket`** | **The single-use transition.** It MUST be one atomic compare-and-set — the read and the write must not be separated by an await, and in a real adapter they must be one database statement or one transaction. It must return `ALREADY_CONSUMED` (not `CONFLICT`) when the same delivery id re-consumes its own ticket, so an idempotent retry still succeeds, and `CONFLICT` when a different delivery id tries. |
| `findDelivery` / `saveDelivery` | idempotent on `deliveryId`, which is deterministic. |
| **`findAccessHold`** | returns the active hold for an order, or `null`. It MUST throw when it cannot answer, so the caller fails closed. A store that answers "no hold" when it simply does not know is a security bug. |

### 2.2 `PrivateStoragePort`

| Method | Contract |
| --- | --- |
| `verifyContentHash` | returns the digest the storage currently holds for the asset. `DENIED` means "not available to this buyer / not there"; `UNAVAILABLE` means "could not be reached"; `UNKNOWN` means "the read may or may not have happened". The three are **not** interchangeable. |
| `openForBuyer` | opens a **buyer-scoped, short-lived, opaque** handle. It must never return a public URL, never a permanent path, and never a handle that another buyer can use. The handle is never persisted. |

### 2.3 `TicketSignerPort`

| Method | Contract |
| --- | --- |
| `fingerprint(token)` | a **keyed** derivation (HMAC-SHA256 with a server-side secret). A plain hash of a random token is replayable from a database dump. The secret is never logged, never returned in an error, and never stored next to the fingerprints. |

### 2.4 The durable binding

`src/lib/delivery/private-delivery-client-binding.ts` is the only module in
this area that talks to durable storage. It implements `DeliveryStorePort`, so
the rules in `private-delivery.ts` do not change when a real database is
plugged in underneath them.

| Property | How it is enforced |
| --- | --- |
| **Single use is one statement** | `consumeTicket` issues ONE conditional update — `updateMany({ where: { id, state: 'ISSUED', tokenFingerprint, buyerId }, data: { state: 'CONSUMED', … } })`. There is deliberately **no read-then-write**: a read-then-write has a window in which two callers both see `ISSUED` and both believe they spent the ticket. The compare-and-set has no such window. |
| **The store decides, the caller classifies** | The rows the update matched are the rows that were still `ISSUED`, still carried this fingerprint and still belonged to this buyer. The reads that follow a zero-row update only turn "matched nothing" into an honest outcome (`ALREADY_CONSUMED`, `CONFLICT`, `NOT_FOUND`, `STORE_UNAVAILABLE`); they never decide. |
| **An unknown commit is never a consumption** | A durable write ends in COMMITTED, NOT COMMITTED or UNKNOWN. A lost answer on the consumption returns `STORE_UNAVAILABLE`, so the rules answer `PENDING` and the caller reconciles with the **same deterministic delivery id**. |
| **The hold lookup fails closed** | `findAccessHold` does **not** catch its errors. A store that cannot answer "is this order held?" must throw so the caller fails closed. Answering "no hold" when the store simply does not know would hand over assets a chargeback has already invalidated. |
| **A revoked entitlement is never revived** | `saveEntitlement` refuses to replace an entitlement that exists in a state other than `GRANTED`. `revokeEntitlement` revokes the entitlement **and** its outstanding tickets in one transaction — defence in depth, so a dead ticket cannot be spent even if the entitlement re-check were bypassed. |
| **A spent ticket is never reset** | `saveTicket` refuses to replace a ticket that is no longer `ISSUED`. `expireTicket` only moves a row that still reads `ISSUED`. |
| **The payment is evidence, never an assumption** | `findVerifiedPayment` requires the order, a server-derived buyer identity (the order's own prospect), the paid posture (`PAYMENT_VERIFIED`), **and** an accepted, positive, signed payment event. A missing payment means "not paid". |
| **The audit ledger cannot duplicate** | Issuance, consumption, expiry and revocation are appended to `DeliveryTicketEvent`, which is unique per `(ticketId, kind, reference)`; the writes are upserts, so a retry cannot duplicate an event or abort the transaction that carried the real effect. |
| **No personal data** | The rows carry ids, digests, bounded reasons and timestamps. No email, no name, no card data, no raw token, no storage handle. |

The delegate seam is expressed **structurally** (plain row records), not as a
generated Prisma type, so the module compiles and is tested without either
proposal being applied. A real Prisma client satisfies it once the proposals
are applied as migrations.

### 2.5 The buyer-safe view

`src/lib/delivery/delivery-view.ts` projects the durable records into the
shape a buyer-facing surface may render.

It is built from an **allow-list**: every field that reaches the buyer is
named on purpose, and anything not named is never copied — not "stripped
later". The view therefore never contains the keyed fingerprint of the bearer
token, a private storage handle or public URL, the internal revocation reason,
a provider payload, or another buyer's identifiers.

The status in the view comes from `deliveryStatus()`, which reads the durable
facts only, so **the view can never be more optimistic than the records behind
it**. The buyer-facing copy (`DELIVERY_STATUS_MESSAGES`) never says *why* a
delivery was refused: it states the state and what to do next, and nothing
about internal reasons or other buyers.

---

## 3. The ten scenarios, and where they are proven

All ten are covered by
`src/lib/delivery/__tests__/private-delivery-persistence.test.ts` (offline,
against the in-memory doubles) unless noted.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Token replay refusal | a second buyer cannot redeem a spent ticket (`BUYER_MISMATCH`); the raw token is never in the durable record; exactly one delivery record exists |
| 2 | Expired ticket refusal | `TICKET_EXPIRED`, the ticket is durably marked `EXPIRED`, no delivery is recorded |
| 3 | Asset substitution refusal | a ticket whose pinned asset list was swapped is refused (`ASSET_TAMPERED`); the ticket stays `ISSUED` |
| 4 | Version / content digest mismatch refusal | a ticket pinned to `ver_1` is refused (`VERSION_MISMATCH`) when the entitlement moved to `ver_2`; a swapped content digest is refused (`ASSET_TAMPERED`) |
| 5 | Buyer mismatch refusal | `BUYER_MISMATCH`; the ticket is not spent |
| 6 | Refund / chargeback / cancellation / dispute hold | the order is held → the entitlement is refused, the ticket is refused, and redemption is refused (`ACCESS_HELD`) — checked immediately before the private read, and a hold lookup that cannot answer is treated as "held" (PENDING) |
| 7 | Concurrent redemption race | two concurrent redemptions produce **one** delivery record and one consumption; a concurrent redemption by a second buyer is refused |
| 8 | Storage timeout / unavailable object | a missing object is `ASSET_NOT_FOUND`; a storage timeout is `STORAGE_UNAVAILABLE`; neither spends the ticket |
| 9 | Unknown persistence commit result | the outcome is `PENDING` / `COMMIT_UNKNOWN` — **never** DELIVERED; reconciliation with the same deterministic delivery id settles it to exactly one delivery |
| 10 | Entitlement revoked between issuance and retrieval | `ENTITLEMENT_REVOKED`; the ticket is not spent and no delivery is recorded |

### 3.1 The same ten scenarios, on the durable binding

`src/lib/delivery/__tests__/private-delivery-client-binding.test.ts` runs the
rules a second time **against the durable binding**, with an in-memory double
that emulates the unique constraints and the compare-and-set semantics. It
additionally proves the properties that only exist at that seam:

| Property | Test |
| --- | --- |
| The consumption is decided by ONE conditional update, and no read happens first | "decides with one conditional update and never reads first" — the first delegate call on the wire must be `deliveryTicket.updateMany` |
| An idempotent retry by the same delivery id succeeds | "reports an idempotent retry by the same delivery as already consumed" |
| A competing delivery id is refused | "reports a competing delivery as a conflict" |
| Two concurrent redemptions produce exactly one consumption | "lets only one of two concurrent redemptions spend the ticket" |
| A lost answer is never reported as a consumption | "never reports a lost commit as a consumption" — the outcome is `STORE_UNAVAILABLE` and reconciling with the same delivery id settles it to `ALREADY_CONSUMED` |
| An indeterminate consumption is unknown, never a failure | "reports an indeterminate consumption as unknown, never as a failure" |
| A revoked entitlement cannot be revived | "refuses to revive a revoked entitlement" |
| A spent ticket cannot be reset | "refuses to replace a ticket that is no longer issued" |
| A hold the store cannot answer fails closed | "fails closed when the hold table cannot be answered" |
| The payment is evidence, never an assumption | "refuses a payment whose signature was never verified", "refuses a rejected or reversed payment event", "refuses an order that is no longer in the paid posture", "refuses an order with no server-derived buyer identity" |
| The raw bearer token is never stored | "never stores the raw token, only its fingerprint" |
| The two proposals work together | "refuses a redemption when the adverse-intake pipeline placed a hold" — the **real** adverse-intake pipeline writes the hold, and the delivery side refuses the redemption because of it |
| A package binding is enforced | "refuses a ticket whose package no longer matches the entitlement" (`PACKAGE_MISMATCH`) |

`src/lib/delivery/__tests__/delivery-view.test.ts` proves the buyer-safe
projection: the fingerprint, the revocation reason and the internal reason
never reach the view, the view is never more optimistic than the records, and
the buyer-facing copy never explains an internal refusal.

---

## 4. What is verified, and what is not

**Verified offline (this repository, no database, no provider):**

* the proposal validates with the installed Prisma CLI and generates delegate
  types in a temporary, isolated output
  (`scripts/verify-private-delivery-proposal.mjs`);
* the proposal still matches the contract in code — a dropped unique, a
  field that became `NOT NULL`, a missing model and a missing enum value are
  all detected (`private-delivery-schema.ts`);
* all ten scenarios above, plus the existing rules, run against the
  in-memory doubles;
* the same ten scenarios run again against the **durable binding**, and the
  cross-proposal bridge (a real adverse-intake hold blocking a real
  redemption) is exercised end to end offline.

**Not verified:**

* that PostgreSQL enforces these constraints as written (no live database
  was contacted);
* that a real `consumeTicket` is atomic under real concurrency;
* that a real private storage adapter returns buyer-scoped, short-lived
  handles;
* that a real Prisma client satisfies the structural delegate seam (the
  proposals are not applied, so the generated delegates do not exist yet);
* any end-to-end run with a real payment provider, a real bucket or a real
  buyer.

The in-memory store is a **double**, not an adapter. It proves the rules; it
does not prove the storage.
