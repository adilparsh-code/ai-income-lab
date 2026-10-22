// ============================================================================
// DURABLE ADVERSE-INTAKE — OFFLINE TESTS
// ============================================================================
// Hermetic: no database, no network, no provider. The delegate seam is
// satisfied by an in-memory double that emulates the unique constraints and
// the compare-and-set semantics the contract depends on.
//
// The doubles are NOT production adapters and the tests make no claim about
// a live PostgreSQL instance: they prove the RULES (dedupe, conflict
// detection, fencing, atomicity, honest unknown outcomes) are correct, and
// that the isolated Prisma proposal still matches the contract in code.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADVERSE_EVENT_TYPES,
  MAX_INT32,
  classifyIncoming,
  dedupeKey,
  holdDispositionFor,
  isInt32Safe,
  nextAttemptNumber,
  normalizeAdverseEvent,
  payloadDigest,
} from '../adverse-intake-mapping';
import { checkAdverseIntakeContract } from '../adverse-intake-schema';
import {
  AdverseIntakeStore,
  type AdverseAttemptRow,
  type AdverseEventRow,
  type AdverseEvidenceRow,
  type AdverseHoldRow,
  type AdverseIntakeDb,
  type AdverseIntakeTx,
} from '../adverse-intake-client-binding';

const NOW = new Date('2026-04-01T09:00:00.000Z');
const PROVIDER = 'polar';
const PROVIDER_EVENT_ID = 'evt_chargeback_9001';
const ORDER = 'order_2001';
const BUYER = 'buyer_alice';

function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: PROVIDER,
    providerEventId: PROVIDER_EVENT_ID,
    eventType: 'CHARGEBACK_CREATED',
    correlationId: 'corr_1',
    orderId: ORDER,
    buyerId: BUYER,
    amountMinor: 4900,
    currency: 'USD',
    occurredAt: '2026-03-30T10:00:00.000Z',
    payload: { reason: 'fraudulent', amount: 4900 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory delegate double
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** Write the row and then throw: the commit landed, the answer was lost. */
  loseAnswerOnEventCreate?: boolean;
  /** Make every read throw: the outcome cannot be determined. */
  failReads?: boolean;
  /** Run the transaction body and then throw: the commit may have landed. */
  loseAnswerOnTransaction?: boolean;
}

/**
 * The commit landed, but the answer was lost on the way back.
 *
 * This is NOT a rollback: the rows stay written, which is exactly the
 * ambiguity the contract has to survive.
 */
class LostAnswerError extends Error {
  constructor() {
    super('connection reset after commit');
    this.name = 'LostAnswerError';
  }
}

class FakeAdverseIntakeDb implements AdverseIntakeDb {
  events = new Map<string, AdverseEventRow>();
  holds = new Map<string, AdverseHoldRow>();
  evidence = new Map<string, AdverseEvidenceRow>();
  attempts = new Map<string, AdverseAttemptRow>();

  private counter = 0;
  options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private matches(row: AdverseEventRow, where: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'provider_providerEventId') {
        const compound = expected as { provider: string; providerEventId: string };
        if (row.provider !== compound.provider) return false;
        if (row.providerEventId !== compound.providerEventId) return false;
        continue;
      }
      if (key === 'id') {
        if (row.id !== expected) return false;
        continue;
      }
      if (key === 'status') {
        if (row.status !== expected) return false;
        continue;
      }
      if (key === 'leaseEpoch') {
        if (row.leaseEpoch !== expected) return false;
        continue;
      }
      if (key === 'leaseOwner') {
        if (row.leaseOwner !== expected) return false;
        continue;
      }
      return false;
    }
    return true;
  }

  adverseEvent = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<AdverseEventRow | null> => {
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.events.values()) {
        if (this.matches(row, args.where)) return { ...row };
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<AdverseEventRow> => {
      const data = args.data;
      const provider = String(data.provider);
      const providerEventId = String(data.providerEventId);
      for (const row of this.events.values()) {
        if (row.provider === provider && row.providerEventId === providerEventId) {
          throw new Error('Unique constraint failed on (provider, providerEventId)');
        }
      }
      const row: AdverseEventRow = {
        id: this.nextId('evt'),
        provider,
        providerEventId,
        eventType: String(data.eventType),
        schemaVersion: Number(data.schemaVersion ?? 1),
        payloadDigest: String(data.payloadDigest),
        correlationId: String(data.correlationId),
        orderId: data.orderId === null || data.orderId === undefined ? null : String(data.orderId),
        buyerId: data.buyerId === null || data.buyerId === undefined ? null : String(data.buyerId),
        amountMinor:
          data.amountMinor === null || data.amountMinor === undefined
            ? null
            : Number(data.amountMinor),
        currency: data.currency === null || data.currency === undefined ? null : String(data.currency),
        occurredAt: new Date(String(data.occurredAt)),
        receivedAt: new Date(String(data.receivedAt)),
        status: 'RECEIVED',
        attemptCount: 0,
        leaseOwner: null,
        leaseEpoch: 0,
        leaseExpiresAt: null,
        lastError: null,
        quarantinedAt: null,
        appliedAt: null,
      };
      this.events.set(row.id, row);
      if (this.options.loseAnswerOnEventCreate) {
        this.options.loseAnswerOnEventCreate = false;
        throw new LostAnswerError();
      }
      return { ...row };
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> => {
      if (this.options.failReads) throw new Error('read failed');
      let count = 0;
      for (const row of this.events.values()) {
        if (!this.matches(row, args.where)) continue;
        const data = args.data;
        if (typeof data.status === 'string') row.status = data.status as AdverseEventRow['status'];
        if (typeof data.leaseOwner === 'string' || data.leaseOwner === null) {
          row.leaseOwner = data.leaseOwner as string | null;
        }
        if (typeof data.leaseEpoch === 'number') row.leaseEpoch = data.leaseEpoch;
        if (data.leaseExpiresAt instanceof Date) row.leaseExpiresAt = data.leaseExpiresAt;
        if (data.leaseExpiresAt === null) row.leaseExpiresAt = null;
        if (typeof data.attemptCount === 'number') row.attemptCount = data.attemptCount;
        if (typeof data.lastError === 'string') row.lastError = data.lastError;
        if (data.lastError === null) row.lastError = null;
        if (data.appliedAt instanceof Date) row.appliedAt = data.appliedAt;
        if (data.quarantinedAt instanceof Date) row.quarantinedAt = data.quarantinedAt;
        count += 1;
      }
      return { count };
    },
  };

  adverseEventAttempt = {
    create: async (args: { data: Record<string, unknown> }): Promise<AdverseAttemptRow> => {
      const data = args.data;
      const eventId = String(data.eventId);
      const attempt = Number(data.attempt);
      for (const row of this.attempts.values()) {
        if (row.eventId === eventId && row.attempt === attempt) {
          throw new Error('Unique constraint failed on (eventId, attempt)');
        }
      }
      const row: AdverseAttemptRow = {
        id: this.nextId('att'),
        eventId,
        attempt,
        workerId: String(data.workerId),
        outcome: String(data.outcome),
        detail: String(data.detail ?? ''),
        createdAt: new Date(String(data.createdAt)),
      };
      this.attempts.set(row.id, row);
      return { ...row };
    },
    findMany: async (args: { where: Record<string, unknown> }): Promise<AdverseAttemptRow[]> => {
      if (this.options.failReads) throw new Error('read failed');
      const eventId = args.where.eventId;
      return [...this.attempts.values()]
        .filter((row) => row.eventId === eventId)
        .map((row) => ({ ...row }));
    },
  };

  adverseHold = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<AdverseHoldRow | null> => {
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.holds.values()) {
        const sourceEventId = args.where.sourceEventId;
        if (sourceEventId !== undefined && row.sourceEventId !== sourceEventId) continue;
        if (args.where.orderId !== undefined && row.orderId !== args.where.orderId) continue;
        if (args.where.state !== undefined && row.state !== args.where.state) continue;
        return { ...row };
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<AdverseHoldRow> => {
      const data = args.data;
      const sourceEventId = String(data.sourceEventId);
      const orderId = String(data.orderId);
      for (const row of this.holds.values()) {
        if (row.sourceEventId === sourceEventId && row.orderId === orderId) {
          throw new Error('Unique constraint failed on (sourceEventId, orderId)');
        }
      }
      const row: AdverseHoldRow = {
        id: this.nextId('hold'),
        eventId: String(data.eventId),
        orderId,
        buyerId: data.buyerId === null || data.buyerId === undefined ? null : String(data.buyerId),
        reason: String(data.reason),
        state: 'ACTIVE',
        sourceEventId,
        createdAt: new Date(String(data.createdAt)),
        releasedAt: null,
      };
      this.holds.set(row.id, row);
      return { ...row };
    },
    updateMany: async (): Promise<{ count: number }> => ({ count: 0 }),
  };

  adverseEventEvidence = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<AdverseEvidenceRow | null> => {
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.evidence.values()) {
        if (row.eventId !== args.where.eventId) continue;
        if (row.kind !== args.where.kind) continue;
        if (row.reference !== args.where.reference) continue;
        return { ...row };
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<AdverseEvidenceRow> => {
      const data = args.data;
      const eventId = String(data.eventId);
      const kind = String(data.kind);
      const reference = String(data.reference);
      for (const row of this.evidence.values()) {
        if (row.eventId === eventId && row.kind === kind && row.reference === reference) {
          throw new Error('Unique constraint failed on (eventId, kind, reference)');
        }
      }
      const row: AdverseEvidenceRow = {
        id: this.nextId('ev'),
        eventId,
        kind,
        reference,
        detail: String(data.detail ?? ''),
        createdAt: new Date(String(data.createdAt)),
      };
      this.evidence.set(row.id, row);
      return { ...row };
    },
  };

  async $transaction<T>(fn: (tx: AdverseIntakeTx) => Promise<T>): Promise<T> {
    const events = new Map(this.events);
    const holds = new Map(this.holds);
    const evidence = new Map(this.evidence);
    const attempts = new Map(this.attempts);
    try {
      const result = await fn(this);
      if (this.options.loseAnswerOnTransaction) {
        this.options.loseAnswerOnTransaction = false;
        throw new LostAnswerError();
      }
      return result;
    } catch (error) {
      if (error instanceof LostAnswerError) {
        // The commit landed; only the answer was lost. The writes stay.
        throw error;
      }
      // A failed transaction leaves no trace: the hold, the evidence, the
      // attempt and the status change are all rolled back together.
      this.events = events;
      this.holds = holds;
      this.evidence = evidence;
      this.attempts = attempts;
      throw error;
    }
  }
}

function makeStore(options: FakeOptions = {}): { db: FakeAdverseIntakeDb; store: AdverseIntakeStore } {
  const db = new FakeAdverseIntakeDb(options);
  return { db, store: new AdverseIntakeStore(db) };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe('adverse intake mapping', () => {
  it('normalizes a well-formed provider event', () => {
    const result = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.event.provider, PROVIDER);
    assert.equal(result.event.eventType, 'CHARGEBACK_CREATED');
    assert.equal(result.event.dedupeKey, dedupeKey(PROVIDER, PROVIDER_EVENT_ID));
    assert.equal(result.event.anchored, true);
    assert.equal(result.event.orderId, ORDER);
    assert.match(result.event.payloadDigest, /^[0-9a-f]{64}$/);
  });

  it('refuses identifiers that are not bounded or well-formed', () => {
    const cases: [unknown, string][] = [
      [rawEvent({ provider: '' }), 'INVALID_PROVIDER'],
      [rawEvent({ provider: 'has spaces' }), 'INVALID_PROVIDER'],
      [rawEvent({ providerEventId: '' }), 'INVALID_PROVIDER_EVENT_ID'],
      [rawEvent({ providerEventId: 'a'.repeat(201) }), 'INVALID_PROVIDER_EVENT_ID'],
      [rawEvent({ correlationId: '' }), 'INVALID_CORRELATION_ID'],
      [rawEvent({ orderId: 'bad id!' }), 'INVALID_ORDER_ID'],
    ];
    for (const [raw, code] of cases) {
      const result = normalizeAdverseEvent(raw, NOW);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.code, code);
    }
  });

  it('refuses an unknown event type', () => {
    const result = normalizeAdverseEvent(rawEvent({ eventType: 'SOMETHING_ELSE' }), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVALID_EVENT_TYPE');
    assert.ok(ADVERSE_EVENT_TYPES.includes('CHARGEBACK_CREATED'));
  });

  it('refuses a negative or out-of-range amount', () => {
    const negative = normalizeAdverseEvent(rawEvent({ amountMinor: -1 }), NOW);
    assert.equal(negative.ok, false);
    if (!negative.ok) assert.equal(negative.code, 'INVALID_AMOUNT');

    const overflow = normalizeAdverseEvent(rawEvent({ amountMinor: MAX_INT32 + 1 }), NOW);
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.equal(overflow.code, 'INVALID_AMOUNT');

    assert.equal(isInt32Safe(MAX_INT32), true);
    assert.equal(isInt32Safe(MAX_INT32 + 1), false);
  });

  it('refuses an invalid currency and a non-ISO timestamp', () => {
    const currency = normalizeAdverseEvent(rawEvent({ currency: 'usd' }), NOW);
    assert.equal(currency.ok, false);
    if (!currency.ok) assert.equal(currency.code, 'INVALID_CURRENCY');

    const occurredAt = normalizeAdverseEvent(rawEvent({ occurredAt: 'not-a-date' }), NOW);
    assert.equal(occurredAt.ok, false);
    if (!occurredAt.ok) assert.equal(occurredAt.code, 'INVALID_OCCURRED_AT');
  });

  it('refuses a payload that is too deep or too large', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    const tooDeep = normalizeAdverseEvent(rawEvent({ payload: deep }), NOW);
    assert.equal(tooDeep.ok, false);
    if (!tooDeep.ok) assert.equal(tooDeep.code, 'PAYLOAD_TOO_DEEP');

    const huge = normalizeAdverseEvent(
      rawEvent({ payload: { blob: 'x'.repeat(40_000) } }),
      NOW,
    );
    assert.equal(huge.ok, false);
    if (!huge.ok) assert.equal(huge.code, 'PAYLOAD_TOO_LARGE');
  });

  it('digests are stable across key order and change with content', () => {
    const a = payloadDigest({ b: 1, a: { d: 4, c: 3 } });
    const b = payloadDigest({ a: { c: 3, d: 4 }, b: 1 });
    assert.equal(a, b);
    assert.notEqual(a, payloadDigest({ b: 1, a: { d: 4, c: 5 } }));
  });

  it('classifies a replay as duplicate and a changed payload as conflict', () => {
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    assert.equal(classifyIncoming(null, normalized.event), 'NEW');
    assert.equal(
      classifyIncoming({ payloadDigest: normalized.event.payloadDigest }, normalized.event),
      'DUPLICATE',
    );
    assert.equal(
      classifyIncoming({ payloadDigest: 'f'.repeat(64) }, normalized.event),
      'CONFLICT',
    );
  });

  it('refuses to wrap the attempt counter', () => {
    assert.deepEqual(nextAttemptNumber(0), { ok: true, attempt: 1 });
    assert.equal(nextAttemptNumber(MAX_INT32).ok, false);
    assert.equal(nextAttemptNumber(-1).ok, false);
  });

  it('maps every adverse event type to a hold', () => {
    for (const type of ADVERSE_EVENT_TYPES) {
      assert.equal(holdDispositionFor(type), 'HOLD');
    }
  });
});

// ---------------------------------------------------------------------------
// Contract vs proposal
// ---------------------------------------------------------------------------

describe('adverse intake proposal contract', () => {
  const proposal = readFileSync(
    join(process.cwd(), 'prisma', 'proposals', 'adverse-intake', 'schema.prisma'),
    'utf8',
  );

  it('the isolated proposal matches the contract in code', () => {
    const check = checkAdverseIntakeContract(proposal);
    assert.deepEqual(check.problems, []);
    assert.equal(check.ok, true);
  });

  it('detects a field that stopped being nullable', () => {
    const mutated = proposal.replace(/^(\s*)orderId\s+String\?/m, '$1orderId String');
    assert.notEqual(mutated, proposal, 'the mutation must actually change the proposal');
    const check = checkAdverseIntakeContract(mutated);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => /orderId/.test(problem)));
  });

  it('detects a dropped compound unique constraint', () => {
    const mutated = proposal.replace(/^\s*@@unique\(\[provider, providerEventId\]\)\s*$/m, '');
    assert.notEqual(mutated, proposal, 'the mutation must actually change the proposal');
    const check = checkAdverseIntakeContract(mutated);
    assert.equal(check.ok, false);
    assert.ok(
      check.problems.some((problem) => /compound unique constraint \(provider, providerEventId\)/.test(problem)),
    );
  });

  it('detects a missing model', () => {
    const mutated = proposal.replace(/^model\s+AdverseHold\s*\{/m, 'model AdverseHoldRenamed {');
    assert.notEqual(mutated, proposal, 'the mutation must actually change the proposal');
    const check = checkAdverseIntakeContract(mutated);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => /AdverseHold/.test(problem)));
  });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('adverse intake store', () => {
  it('stores a new event', async () => {
    const { db, store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;

    const outcome = await store.recordIncoming(normalized.event);
    assert.equal(outcome.kind, 'STORED');
    assert.equal(db.events.size, 1);
    assert.equal(db.holds.size, 0);
  });

  it('treats a repeated delivery as a duplicate and creates nothing', async () => {
    const { db, store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;

    await store.recordIncoming(normalized.event);
    const second = await store.recordIncoming(normalized.event);

    assert.equal(second.kind, 'DUPLICATE');
    assert.equal(db.events.size, 1);
    assert.equal(db.holds.size, 0);
  });

  it('refuses a conflicting payload for the same provider event id', async () => {
    const { db, store } = makeStore();
    const first = normalizeAdverseEvent(rawEvent(), NOW);
    const tampered = normalizeAdverseEvent(
      rawEvent({ payload: { reason: 'fraudulent', amount: 9900 } }),
      NOW,
    );
    assert.equal(first.ok, true);
    assert.equal(tampered.ok, true);
    if (!first.ok || !tampered.ok) return;

    await store.recordIncoming(first.event);
    const second = await store.recordIncoming(tampered.event);

    assert.equal(second.kind, 'CONFLICT');
    assert.equal(db.events.size, 1);
    assert.equal(db.holds.size, 0);
  });

  it('stores an event that arrives before its order and anchors it later', async () => {
    const { db, store } = makeStore();
    const early = normalizeAdverseEvent(rawEvent({ orderId: null, buyerId: null }), NOW);
    assert.equal(early.ok, true);
    if (!early.ok) return;
    assert.equal(early.event.anchored, false);

    const stored = await store.recordIncoming(early.event);
    assert.equal(stored.kind, 'STORED');
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';
    assert.equal(eventId.length > 0, true);

    // The order is only known later: the event is applied against it then.
    const lease = await store.acquireLease({ eventId, workerId: 'worker_a', now: NOW });
    assert.equal(lease.kind, 'ACQUIRED');

    const applied = await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1,
      now: NOW,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });
    assert.equal(applied.kind, 'APPLIED');
    assert.equal(db.holds.size, 1);
  });

  it('lets only one worker hold the lease', async () => {
    const { store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';

    const [a, b] = await Promise.all([
      store.acquireLease({ eventId, workerId: 'worker_a', now: NOW }),
      store.acquireLease({ eventId, workerId: 'worker_b', now: NOW }),
    ]);

    const acquired = [a, b].filter((outcome) => outcome.kind === 'ACQUIRED');
    const busy = [a, b].filter((outcome) => outcome.kind === 'BUSY');
    assert.equal(acquired.length, 1);
    assert.equal(busy.length, 1);
  });

  it('fences a stale worker whose lease was taken over', async () => {
    const { db, store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';

    const first = await store.acquireLease({
      eventId,
      workerId: 'worker_a',
      now: NOW,
      ttlMs: 1_000,
    });
    assert.equal(first.kind, 'ACQUIRED');
    const staleEpoch = first.kind === 'ACQUIRED' ? first.leaseEpoch : -1;

    // The lease expires and another worker takes over: the epoch is bumped.
    const later = new Date(NOW.getTime() + 5_000);
    const second = await store.acquireLease({ eventId, workerId: 'worker_b', now: later });
    assert.equal(second.kind, 'ACQUIRED');
    assert.equal(
      second.kind === 'ACQUIRED' && second.leaseEpoch > staleEpoch,
      true,
      'taking over a lease must bump the fencing epoch',
    );

    // The stale worker now tries to apply: it must be rejected, and it must
    // not leave a hold behind.
    const staleApply = await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: staleEpoch,
      now: later,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });
    assert.equal(staleApply.kind, 'LEASE_LOST');
    assert.equal(db.holds.size, 0, 'a fenced worker must not create a hold');
    assert.equal(db.evidence.size, 0, 'a fenced worker must not write evidence');
  });

  it('applies a hold exactly once, even when the same event is applied twice', async () => {
    const { db, store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';

    const lease = await store.acquireLease({ eventId, workerId: 'worker_a', now: NOW });
    const epoch = lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1;

    const first = await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: epoch,
      now: NOW,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });
    assert.equal(first.kind, 'APPLIED');

    const second = await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: epoch,
      now: NOW,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });
    assert.equal(second.kind, 'LEASE_LOST');
    assert.equal(db.holds.size, 1, 'the hold must not be duplicated');
    assert.equal(db.evidence.size, 1, 'the evidence must not be duplicated');
  });

  it('refuses to wrap the attempt counter at the Int32 limit', async () => {
    const { db, store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';
    const row = db.events.get(eventId);
    assert.ok(row);
    if (row) row.attemptCount = MAX_INT32;

    const lease = await store.acquireLease({ eventId, workerId: 'worker_a', now: NOW });
    const epoch = lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1;
    const applied = await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: epoch,
      now: NOW,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });

    assert.equal(applied.kind, 'REJECTED');
    assert.equal(db.holds.size, 0);
    const after = db.events.get(eventId);
    assert.equal(after?.attemptCount, MAX_INT32, 'the counter must not wrap');
  });

  it('never reports an unknown commit as applied, and a retry does not duplicate it', async () => {
    const { db, store } = makeStore({ loseAnswerOnEventCreate: true, failReads: true });
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;

    const first = await store.recordIncoming(normalized.event);
    assert.equal(first.kind, 'UNKNOWN', 'an unreadable commit must not be reported as stored');

    // The connection recovers: the event is already there, and the retry
    // recognises it instead of creating a second one.
    db.options.failReads = false;
    const second = await store.recordIncoming(normalized.event);
    assert.equal(second.kind, 'DUPLICATE');
    assert.equal(db.events.size, 1);
  });

  it('reports an unknown transaction outcome and reconciles it exactly', async () => {
    const { db, store } = makeStore({ loseAnswerOnTransaction: true });
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';

    const lease = await store.acquireLease({ eventId, workerId: 'worker_a', now: NOW });
    const epoch = lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1;

    const applied = await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: epoch,
      now: NOW,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });
    assert.equal(applied.kind, 'UNKNOWN', 'an unknown commit must not be reported as applied');

    const reconciled = await store.reconcile({ eventId });
    assert.equal(reconciled.kind, 'APPLIED');
    assert.equal(db.holds.size, 1, 'the hold must exist exactly once after reconciliation');
  });

  it('quarantines an event instead of applying it', async () => {
    const { db, store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';

    const lease = await store.acquireLease({ eventId, workerId: 'worker_a', now: NOW });
    const epoch = lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1;

    const quarantined = await store.quarantineEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: epoch,
      reason: 'conflicting payload digest',
      now: NOW,
    });
    assert.equal(quarantined.kind, 'QUARANTINED');
    assert.equal(db.holds.size, 0);

    const attempts = await store.listAttempts(eventId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.outcome, 'QUARANTINED');
  });

  it('refuses to lease an event that was already applied or quarantined', async () => {
    const { store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';

    const lease = await store.acquireLease({ eventId, workerId: 'worker_a', now: NOW });
    const epoch = lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1;
    await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: epoch,
      now: NOW,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });

    const again = await store.acquireLease({ eventId, workerId: 'worker_b', now: NOW });
    assert.equal(again.kind, 'ALREADY_APPLIED');
  });

  it('exposes the active hold for an order', async () => {
    const { db, store } = makeStore();
    const normalized = normalizeAdverseEvent(rawEvent(), NOW);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const stored = await store.recordIncoming(normalized.event);
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';
    const lease = await store.acquireLease({ eventId, workerId: 'worker_a', now: NOW });
    const epoch = lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1;
    await store.applyEvent({
      eventId,
      workerId: 'worker_a',
      leaseEpoch: epoch,
      now: NOW,
      orderId: ORDER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb_9001',
      holdReason: 'CHARGEBACK_CREATED',
    });

    const hold = await store.findActiveHold(ORDER);
    assert.ok(hold);
    assert.equal(hold?.orderId, ORDER);
    assert.equal(hold?.state, 'ACTIVE');
    assert.equal(db.holds.size, 1);
  });
});
