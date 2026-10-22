# Durable Adverse-Intake — Transaction Contract

Status: **proposal, not applied.** The tables below live only in
`prisma/proposals/adverse-intake/schema.prisma`. The active application
schema (`prisma/schema.prisma`) is untouched, and no migration has been
run against any database.

Code that implements this contract:

| Concern | File |
| --- | --- |
| Model / field / uniqueness contract + drift checker | `src/lib/product-factory/adverse-intake-schema.ts` |
| Payload validation, canonical digest, replay classification | `src/lib/product-factory/adverse-intake-mapping.ts` |
| Durable operations expressed as compare-and-set | `src/lib/product-factory/adverse-intake-client-binding.ts` |
| Offline tests (no database) | `src/lib/product-factory/__tests__/adverse-intake.test.ts` |
| Isolated proposal validation | `scripts/verify-adverse-intake-proposal.mjs` |

---

## 1. What an adverse event is

A provider reports that money already earned is at risk: a chargeback, a
refund, a dispute, a cancellation. The intake pipeline must survive a hostile
and unreliable world:

* the same provider event may arrive many times;
* the same provider event id may arrive carrying **different** content;
* an event may arrive **before** the order it refers to;
* several workers may try to process the same event at the same time;
* a worker may crash **after** the commit but before it learns the outcome;
* an event may be unprocessable and need a human.

The contract below is the set of guarantees that make those cases safe.

---

## 2. Identity, content and anchoring

### 2.1 Identity — enforced by the database

The dedupe key is `(provider, providerEventId)`, enforced by

```prisma
@@unique([provider, providerEventId])
```

on `AdverseEvent`. This is the **only** thing that makes deduplication
durable. The application never dedupes by itself: `recordIncoming` reads
first (to produce a friendly outcome) but the unique constraint is the
arbiter, and the read-after-failed-write is what settles a race between two
concurrent inserts.

Consequence: a duplicate delivery cannot create a second event row, even if
two workers race, even if the process is restarted.

### 2.2 Content — a digest, compared, never silently ignored

Each event stores `payloadDigest`: the SHA-256 of the **canonical** payload
(canonical JSON — keys sorted recursively, so a re-serialised webhook is not
a tampered webhook).

* Same key, same digest → `DUPLICATE`. Nothing is written.
* Same key, different digest → `CONFLICT`. **Nothing is written.** The event
  is quarantined for a human; it is never applied automatically.

A digest detects *changed* content. It does **not** prove the original
delivery was authentic — that is the provider signature's job, and the intake
layer assumes the caller has already verified it. Nothing in this contract
should be read as "the event is genuine".

### 2.3 Anchoring — nullable on purpose

`AdverseEvent.orderId` and `buyerId` are nullable. An event that arrives
before its order is stored with `orderId = null` and waits. It is never
discarded, and it is never anchored to a guessed order.

Anchoring later is an explicit apply step, not a background guess.

---

## 3. Atomicity

### 3.1 What must be atomic — `applyEvent`

One transaction, four writes, all or nothing:

1. the **hold** on the order (`AdverseHold`);
2. the **evidence** record (`AdverseEventEvidence`);
3. the **status change** of the event to `APPLIED` (the compare-and-set);
4. the **attempt** record (`AdverseEventAttempt`).

If the compare-and-set in step 3 matches zero rows, the transaction rolls
back and **no hold survives**. An event is never half applied: there is
never a hold without a matching APPLIED status, and never an APPLIED status
without a hold.

`quarantineEvent` is deliberately **not** in the same transaction shape: it
writes a status change and, best-effort, an attempt row. A lost audit row
must not turn a known outcome into an unknown one.

### 3.2 What the database must enforce

| Constraint | Where | Why |
| --- | --- | --- |
| `@@unique([provider, providerEventId])` | `AdverseEvent` | the dedupe key |
| `@@unique([eventId, attempt])` | `AdverseEventAttempt` | a replayed attempt number cannot overwrite history |
| `@@unique([sourceEventId, orderId])` | `AdverseHold` | one hold per (provider event, order) |
| `@@unique([eventId, kind, reference])` | `AdverseEventEvidence` | evidence is written once |
| `NOT NULL` on `payloadDigest`, `eventType`, `provider`, `providerEventId` | `AdverseEvent` | a stored event is always identifiable |
| `NOT NULL` on `sourceEventId`, `orderId`, `reason` | `AdverseHold` | a hold always names what it blocks and why |
| Int32 on `attemptCount`, `leaseEpoch`, `amountMinor` | `AdverseEvent` | counters must not silently widen |

### 3.3 What the application must not claim

* **Uniqueness is a database property.** The application's read-then-write
  is an optimisation; the constraint is the guarantee.
* **Transaction isolation is a database property.** The contract only
  requires that the writes above commit or roll back together. It does not
  promise a specific isolation level beyond that, and the schema does not
  enable serialisable isolation.
* **Lease expiry uses the caller's clock.** `leaseExpiresAt` is compared
  against the `now` the worker passes in. The database clock is not
  consulted. A worker with a badly skewed clock can hold a lease longer than
  intended — the epoch fencing still prevents double application.
* **Crash durability is a database property.** The contract asks the store
  to *report* an unknown outcome, not to prove the data survived a power
  cut.

---

## 4. Concurrency: leases, epochs and fencing

### 4.1 Acquiring a lease

`acquireLease` is a compare-and-set:

```
UPDATE AdverseEvent
   SET status = 'LEASED',
       leaseOwner = <worker>,
       leaseEpoch = leaseEpoch + 1,
       leaseExpiresAt = <now + ttl>
 WHERE id = <event>
   AND status = <the status I read>
   AND leaseEpoch = <the epoch I read>
```

Exactly one of N competing workers sees `count = 1`; the others see `0` and
report `BUSY`. A worker that finds a **live** lease (expiry in the future)
does not attempt the update at all.

### 4.2 Fencing a stale worker

`leaseEpoch` is the fencing token. Every acquisition bumps it, so a lease
that expired and was taken over carries a **higher** epoch than the original.

An apply or a quarantine is a second compare-and-set:

```
UPDATE AdverseEvent
   SET status = 'APPLIED' | 'QUARANTINED', ...
 WHERE id = <event>
   AND status = 'LEASED'
   AND leaseOwner = <my worker id>
   AND leaseEpoch = <my epoch>
```

A stale worker holds the *old* epoch (and the old owner). Its update matches
**zero** rows, the transaction rolls back, and the store reports
`LEASE_LOST`. The stale worker cannot apply the event, cannot quarantine it,
and cannot write a hold or evidence.

This is the mechanism that makes a re-delivery, a worker restart and a lease
expiry safe: **the epoch, not the worker's memory, decides.**

### 4.3 Attempt numbering

`attemptCount` is a 32-bit counter. `nextAttemptNumber` **refuses** at
`Int32.MAX_VALUE` instead of wrapping. A wrapped counter would let a worker
reuse attempt number 1 and overwrite the history of an earlier attempt —
which the `@@unique([eventId, attempt])` constraint would then reject, but
only after a confusing failure. The refusal is explicit and produces
`REJECTED`, with no hold and no evidence.

---

## 5. Ambiguous commits — the "unknown" outcome

A database write has **three** possible outcomes, never two:

1. **COMMITTED** — the write landed and we know it.
2. **NOT COMMITTED** — the write did not land and we know it.
3. **UNKNOWN** — the connection died; the write may or may not have landed.

The store never collapses (3) into (1) or (2). `recordIncoming`, `acquireLease`,
`applyEvent` and `quarantineEvent` all return `UNKNOWN` rather than guessing.

### 5.1 Why reconciliation is always possible

Every durable write is keyed deterministically, so a retry cannot create a
second side effect:

| Write | Key |
| --- | --- |
| event | `(provider, providerEventId)` |
| hold | `(sourceEventId, orderId)` |
| evidence | `(eventId, kind, reference)` |
| attempt | `(eventId, attempt)` |

`reconcile({ eventId })` reads the durable state and reports **what is true**:
`APPLIED` when the status is APPLIED (the commit landed), `PENDING` when it
is not (the commit did not land, or landed partially — which the transaction
shape forbids), `NOT_FOUND` when the row is gone.

### 5.2 The retry rules

* **After an unknown `recordIncoming`:** call `recordIncoming` again. The
  unique constraint plus the digest comparison settle it: `DUPLICATE` if the
  event landed, `STORED` if it did not, `CONFLICT` if something else
  arrived under the same key.
* **After an unknown `applyEvent`:** call `reconcile`. If the status is
  `APPLIED`, the hold exists — do not apply again. If it is not, the
  transaction rolled back — no hold exists, and a fresh lease may be taken.
* **Never** re-apply an event on the strength of "it probably worked". A
  second apply attempt on a still-leased event is safe (the compare-and-set
  is what fences it), but a *blind* re-creation of the side effect outside
  the transaction is not.

---

## 6. Outcomes and what each one obliges the caller to do

| Outcome | Meaning | Caller must |
| --- | --- | --- |
| `STORED` | the event is durably recorded, not yet processed | lease it and apply it |
| `DUPLICATE` | the same event, same digest, already stored | do nothing |
| `CONFLICT` | same key, different digest | quarantine for a human; **never** apply |
| `UNKNOWN` | the commit may or may not have landed | reconcile, then decide |
| `ACQUIRED` | this worker holds the lease at this epoch | apply within the TTL |
| `BUSY` | another worker holds a live lease | back off; do not force |
| `ALREADY_APPLIED` | the event is done | do nothing |
| `QUARANTINED` | the event was quarantined | do nothing; a human decides |
| `APPLIED` | the hold and the evidence are durable | do nothing |
| `LEASE_LOST` | the epoch was fenced; someone else owns it | do nothing; record the attempt |
| `REJECTED` | the event cannot be applied (counter range, no effect) | quarantine or ignore deliberately |
| `NOT_FOUND` | the event does not exist | treat as a bug, not a retry |

### 6.1 Errors that require quarantine or human review

* **Digest conflict** — the same provider event id with different content.
  A human decides; the system never picks a winner.
* **Attempt counter at the Int32 limit** — the event is stuck. Quarantine;
  a human resets the counter.
* **An event that refers to an order that never appears** — it stays
  `RECEIVED` and unanchored. It is not an error; it is pending. A human (or
  an operator-driven anchoring job) resolves it.
* **An event whose type has no effect on access** — deliberately `IGNORED`
  or `REJECTED`, never silently dropped.

### 6.2 Fail-closed

Every uncertain path in this contract closes **closed**:

* no hold without a proof of the event;
* no applied event without a hold;
* no automatic resolution of a conflict;
* no status the caller cannot justify from durable state.

---

## 7. What is verified, and what is not

**Verified offline (this repository, no database):**

* the proposal validates with the installed Prisma CLI and generates
  delegate types in a temporary, isolated output
  (`scripts/verify-adverse-intake-proposal.mjs`);
* the proposal still matches the contract in code — a missing field, a
  changed type, a field that became `NOT NULL`, a dropped compound unique
  and a missing model are all detected
  (`adverse-intake-schema.ts`);
* the rules — dedupe, conflict detection, anchoring, lease contention,
  stale-worker fencing, single application, Int32 refusal, unknown-commit
  honesty, quarantine — are exercised against an in-memory delegate double
  (`__tests__/adverse-intake.test.ts`).

**Not verified:**

* that PostgreSQL enforces these constraints as written (no live database
  was contacted);
* the behaviour of a real Prisma client against a real transaction, under
  real concurrency and real crash timing;
* any integration with a payment provider's actual webhook payloads.

The delegate seam in `adverse-intake-client-binding.ts` is structural, so a
generated Prisma client satisfies it once the proposal is applied as a
migration — but until that happens, these tests prove the *rules*, not the
*storage*.
