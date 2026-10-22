# Private Delivery — Durable Persistence Contract

Status: **proposal, not applied.** The tables live only in
`prisma/proposals/private-delivery/schema.prisma`. The active application
schema (`prisma/schema.prisma`) is untouched, and no migration has been run
against any database.

| Concern | File |
| --- | --- |
| The rules | `src/lib/delivery/private-delivery.ts` |
| The ports | `src/lib/delivery/ports.ts` |
| The offline doubles | `src/lib/delivery/offline-fakes.ts` |
| The schema contract + drift checker | `src/lib/delivery/private-delivery-schema.ts` |
| The isolated proposal | `prisma/proposals/private-delivery/schema.prisma` |
| Isolated proposal validation | `scripts/verify-private-delivery-proposal.mjs` |
| Offline tests | `src/lib/delivery/__tests__/private-delivery-persistence.test.ts` |

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
  in-memory doubles.

**Not verified:**

* that PostgreSQL enforces these constraints as written (no live database
  was contacted);
* that a real `consumeTicket` is atomic under real concurrency;
* that a real private storage adapter returns buyer-scoped, short-lived
  handles;
* any end-to-end run with a real payment provider, a real bucket or a real
  buyer.

The in-memory store is a **double**, not an adapter. It proves the rules; it
does not prove the storage.
