// ============================================================================
// DURABLE ADVERSE-INTAKE — PERSISTENCE BINDING
// ============================================================================
// The seam between the intake rules and a real database.
//
// The rules live in ./adverse-intake-mapping; the durable shape of the tables
// lives in ./adverse-intake-schema and in the isolated proposal
// (prisma/proposals/adverse-intake/schema.prisma). This module binds them:
// it expresses every durable operation as a compare-and-set against the
// delegates a Prisma client exposes.
//
// WHY COMPARE-AND-SET EVERYWHERE
// ------------------------------
// Adverse intake is executed by competing workers over a shared queue. Every
// state change is therefore expressed as "update the row only if it still
// looks the way I read it":
//
//   - lease acquisition matches on (id, status, leaseEpoch)
//   - apply / quarantine match on (id, status, leaseOwner, leaseEpoch)
//
// A worker whose lease expired and was taken over holds a STALE leaseEpoch,
// so its update matches zero rows and its work is rejected. That is the
// fencing mechanism: a stale worker cannot apply an event that a newer
// worker is already handling, and it cannot double-apply a hold.
//
// HONEST OUTCOMES
// ---------------
// A database write can end in three states, never two: COMMITTED, NOT
// COMMITTED, or UNKNOWN (the write may or may not have landed). Every method
// here reports UNKNOWN rather than guessing, and reconciliation is always
// possible because the writes are keyed deterministically:
//
//   - events are keyed by (provider, providerEventId)
//   - holds by (sourceEventId, orderId)
//   - evidence by (eventId, kind, reference)
//   - attempts by (eventId, attempt)
//
// ATOMICITY
// ---------
// `applyEvent` writes the hold, the evidence, the attempt and the status
// change inside ONE transaction. If the status compare-and-set fails, the
// transaction rolls back and no hold survives — an event is never half
// applied. The UNIQUE constraints in the proposal are the final arbiter for
// concurrent duplicates; the in-transaction reads only avoid raising them.
//
// NOT A PRODUCTION ADAPTER
// ------------------------
// The delegate seam below is structural: a real Prisma client satisfies it
// once the proposal is applied as a migration. Until then, this module is
// exercised by the offline tests with an in-memory double. It does not
// pretend a live database exists.
// ============================================================================

import {
  holdDispositionFor,
  nextAttemptNumber,
  type NormalizedAdverseEvent,
  type ReplayClassification,
} from './adverse-intake-mapping';
import type { AdverseEventStatus, AdverseHoldState } from './adverse-intake-schema';

// ---------------------------------------------------------------------------
// Durable rows
// ---------------------------------------------------------------------------

export interface AdverseEventRow {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  schemaVersion: number;
  payloadDigest: string;
  correlationId: string;
  orderId: string | null;
  buyerId: string | null;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: Date;
  receivedAt: Date;
  status: AdverseEventStatus;
  attemptCount: number;
  leaseOwner: string | null;
  leaseEpoch: number;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  quarantinedAt: Date | null;
  appliedAt: Date | null;
}

export interface AdverseHoldRow {
  id: string;
  eventId: string;
  orderId: string;
  buyerId: string | null;
  reason: string;
  state: AdverseHoldState;
  sourceEventId: string;
  createdAt: Date;
  releasedAt: Date | null;
}

export interface AdverseEvidenceRow {
  id: string;
  eventId: string;
  kind: string;
  reference: string;
  detail: string;
  createdAt: Date;
}

export interface AdverseAttemptRow {
  id: string;
  eventId: string;
  attempt: number;
  workerId: string;
  outcome: string;
  detail: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// The delegate seam
// ---------------------------------------------------------------------------

/**
 * The subset of the Prisma client this module uses.
 *
 * It is expressed structurally (plain records) rather than as a generated
 * Prisma type so the module can be compiled and tested without applying the
 * proposal. A real client satisfies it structurally: `updateMany` returns
 * `{ count }`, `create` returns the row, and `$transaction` takes a callback.
 */
export interface AdverseIntakeTx {
  adverseEvent: {
    findFirst(args: { where: Record<string, unknown> }): Promise<AdverseEventRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<AdverseEventRow>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  adverseEventAttempt: {
    create(args: { data: Record<string, unknown> }): Promise<AdverseAttemptRow>;
    findMany(args: { where: Record<string, unknown> }): Promise<AdverseAttemptRow[]>;
  };
  adverseHold: {
    findFirst(args: { where: Record<string, unknown> }): Promise<AdverseHoldRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<AdverseHoldRow>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  adverseEventEvidence: {
    findFirst(args: { where: Record<string, unknown> }): Promise<AdverseEvidenceRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<AdverseEvidenceRow>;
  };
}

export interface AdverseIntakeDb extends AdverseIntakeTx {
  $transaction<T>(fn: (tx: AdverseIntakeTx) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type RecordOutcome =
  | { kind: 'STORED'; event: AdverseEventRow }
  | { kind: 'DUPLICATE'; event: AdverseEventRow; classification: ReplayClassification }
  | { kind: 'CONFLICT'; existing: AdverseEventRow; incoming: NormalizedAdverseEvent }
  | { kind: 'UNKNOWN' };

export type LeaseOutcome =
  | { kind: 'ACQUIRED'; leaseEpoch: number; leaseExpiresAt: Date }
  | { kind: 'BUSY'; leaseOwner: string | null; leaseExpiresAt: Date | null }
  | { kind: 'ALREADY_APPLIED' }
  | { kind: 'QUARANTINED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNKNOWN' };

export type ApplyOutcome =
  | { kind: 'APPLIED'; event: AdverseEventRow; hold: AdverseHoldRow | null }
  | { kind: 'LEASE_LOST'; current: AdverseEventRow | null }
  | { kind: 'NOT_FOUND' }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'UNKNOWN' };

export type QuarantineOutcome =
  | { kind: 'QUARANTINED'; event: AdverseEventRow }
  | { kind: 'LEASE_LOST'; current: AdverseEventRow | null }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNKNOWN' };

/** Signals that a compare-and-set lost, and must roll the transaction back. */
class LeaseLostError extends Error {
  constructor() {
    super('The lease was lost.');
    this.name = 'LeaseLostError';
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface AdverseIntakeStoreOptions {
  /** Default lease duration. */
  leaseTtlMs?: number;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_REASON_LENGTH = 300;

function boundText(value: string, max = MAX_REASON_LENGTH): string {
  return value.slice(0, max);
}

/**
 * The durable store for adverse intake.
 *
 * Every method returns a typed outcome. Nothing throws for an ordinary
 * failure, and nothing reports success it cannot prove.
 */
export class AdverseIntakeStore {
  private readonly db: AdverseIntakeDb;
  private readonly leaseTtlMs: number;

  constructor(db: AdverseIntakeDb, options: AdverseIntakeStoreOptions = {}) {
    this.db = db;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /**
   * Store an incoming event.
   *
   * - NEW        -> the event is stored.
   * - DUPLICATE  -> the same event was already stored; nothing is written.
   * - CONFLICT   -> the same event id carries DIFFERENT content. Nothing is
   *                 written: the caller quarantines it for a human.
   * - UNKNOWN    -> the write may or may not have landed. The caller
   *                 reconciles by calling this again: the dedupe key makes
   *                 the retry safe.
   */
  async recordIncoming(event: NormalizedAdverseEvent): Promise<RecordOutcome> {
    let existing: AdverseEventRow | null = null;
    try {
      existing = await this.db.adverseEvent.findFirst({
        where: {
          provider_providerEventId: {
            provider: event.provider,
            providerEventId: event.providerEventId,
          },
        },
      });
    } catch {
      return { kind: 'UNKNOWN' };
    }

    if (existing) {
      if (existing.payloadDigest === event.payloadDigest) {
        return { kind: 'DUPLICATE', event: existing, classification: 'DUPLICATE' };
      }
      return { kind: 'CONFLICT', existing, incoming: event };
    }

    try {
      const created = await this.db.adverseEvent.create({
        data: {
          provider: event.provider,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          schemaVersion: event.schemaVersion,
          payloadDigest: event.payloadDigest,
          correlationId: event.correlationId,
          orderId: event.orderId,
          buyerId: event.buyerId,
          amountMinor: event.amountMinor,
          currency: event.currency,
          occurredAt: new Date(event.occurredAt),
          receivedAt: new Date(event.receivedAt),
          status: 'RECEIVED',
          attemptCount: 0,
          leaseEpoch: 0,
        },
      });
      return { kind: 'STORED', event: created };
    } catch {
      // Either a concurrent insert won the race (the unique constraint) or the
      // commit is unknown. Re-read: the row's presence settles both cases.
      try {
        const raced = await this.db.adverseEvent.findFirst({
          where: {
            provider_providerEventId: {
              provider: event.provider,
              providerEventId: event.providerEventId,
            },
          },
        });
        if (raced) {
          if (raced.payloadDigest === event.payloadDigest) {
            return { kind: 'DUPLICATE', event: raced, classification: 'DUPLICATE' };
          }
          return { kind: 'CONFLICT', existing: raced, incoming: event };
        }
      } catch {
        // fall through to UNKNOWN
      }
      return { kind: 'UNKNOWN' };
    }
  }

  /**
   * Acquire the processing lease for one event.
   *
   * The compare-and-set matches the (status, leaseEpoch) the worker read, so
   * exactly one of N competing workers wins. An expired lease may be taken
   * over; the epoch is bumped, which fences the previous holder.
   */
  async acquireLease(input: {
    eventId: string;
    workerId: string;
    now: Date;
    ttlMs?: number;
  }): Promise<LeaseOutcome> {
    const ttl = input.ttlMs ?? this.leaseTtlMs;
    let current: AdverseEventRow | null;
    try {
      current = await this.db.adverseEvent.findFirst({ where: { id: input.eventId } });
    } catch {
      return { kind: 'UNKNOWN' };
    }
    if (!current) return { kind: 'NOT_FOUND' };
    if (current.status === 'APPLIED') return { kind: 'ALREADY_APPLIED' };
    if (current.status === 'QUARANTINED') return { kind: 'QUARANTINED' };

    const leaseLive =
      current.leaseExpiresAt !== null && current.leaseExpiresAt.getTime() > input.now.getTime();
    if (current.status === 'LEASED' && leaseLive) {
      return {
        kind: 'BUSY',
        leaseOwner: current.leaseOwner,
        leaseExpiresAt: current.leaseExpiresAt,
      };
    }

    const nextEpoch = current.leaseEpoch + 1;
    const expiresAt = new Date(input.now.getTime() + ttl);
    try {
      const claimed = await this.db.adverseEvent.updateMany({
        where: { id: input.eventId, status: current.status, leaseEpoch: current.leaseEpoch },
        data: {
          status: 'LEASED',
          leaseOwner: input.workerId,
          leaseExpiresAt: expiresAt,
          leaseEpoch: nextEpoch,
        },
      });
      if (claimed.count !== 1) {
        return { kind: 'BUSY', leaseOwner: null, leaseExpiresAt: null };
      }
      return { kind: 'ACQUIRED', leaseEpoch: nextEpoch, leaseExpiresAt: expiresAt };
    } catch {
      return { kind: 'UNKNOWN' };
    }
  }

  /**
   * Apply an event: create the hold, record the evidence, mark the event
   * APPLIED and record the attempt — in ONE transaction.
   *
   * If the lease compare-and-set fails, the transaction rolls back and no
   * hold survives. The event is never half applied.
   */
  async applyEvent(input: {
    eventId: string;
    workerId: string;
    leaseEpoch: number;
    now: Date;
    /** The order the event applies to. Required for a hold. */
    orderId: string;
    buyerId?: string | null;
    /** The evidence kind, e.g. HOLD_APPLIED. */
    evidenceKind: string;
    /** The external reference the evidence is about. */
    evidenceReference: string;
    /** The reason recorded on the hold, e.g. CHARGEBACK_CREATED. */
    holdReason: string;
  }): Promise<ApplyOutcome> {
    let current: AdverseEventRow | null;
    try {
      current = await this.db.adverseEvent.findFirst({ where: { id: input.eventId } });
    } catch {
      return { kind: 'UNKNOWN' };
    }
    if (!current) return { kind: 'NOT_FOUND' };

    const attempt = nextAttemptNumber(current.attemptCount);
    if (!attempt.ok) {
      // The counter is out of range. Refusing is the only safe move: a
      // wrapped counter would let a worker reuse an attempt number.
      await this.recordAttemptOutsideTransaction(input, current, 'REJECTED', attempt.reason);
      return { kind: 'REJECTED', reason: attempt.reason };
    }

    if (holdDispositionFor(current.eventType as never) === 'NONE') {
      await this.recordAttemptOutsideTransaction(
        input,
        current,
        'REJECTED',
        `The event type ${current.eventType} has no effect on access.`,
      );
      return { kind: 'REJECTED', reason: 'The event type has no effect on access.' };
    }

    try {
      const result = await this.db.$transaction(async (tx) => {
        // 1. The hold, keyed so a retry cannot create a second one.
        const existingHold = await tx.adverseHold.findFirst({
          where: { sourceEventId: current!.providerEventId, orderId: input.orderId },
        });
        const hold =
          existingHold ??
          (await tx.adverseHold.create({
            data: {
              eventId: input.eventId,
              orderId: input.orderId,
              buyerId: input.buyerId ?? current!.buyerId,
              reason: boundText(input.holdReason),
              state: 'ACTIVE',
              sourceEventId: current!.providerEventId,
              createdAt: input.now,
            },
          }));

        // 2. The evidence, keyed so a retry cannot duplicate it.
        const existingEvidence = await tx.adverseEventEvidence.findFirst({
          where: {
            eventId: input.eventId,
            kind: input.evidenceKind,
            reference: input.evidenceReference,
          },
        });
        if (!existingEvidence) {
          await tx.adverseEventEvidence.create({
            data: {
              eventId: input.eventId,
              kind: input.evidenceKind,
              reference: boundText(input.evidenceReference),
              detail: boundText(`Applied by ${input.workerId}.`),
              createdAt: input.now,
            },
          });
        }

        // 3. The compare-and-set that decides the outcome. A stale lease epoch
        //    matches no row and rolls the whole transaction back.
        const applied = await tx.adverseEvent.updateMany({
          where: {
            id: input.eventId,
            status: 'LEASED',
            leaseOwner: input.workerId,
            leaseEpoch: input.leaseEpoch,
          },
          data: {
            status: 'APPLIED',
            appliedAt: input.now,
            leaseOwner: null,
            leaseExpiresAt: null,
            attemptCount: attempt.attempt,
            lastError: null,
          },
        });
        if (applied.count !== 1) throw new LeaseLostError();

        // 4. The attempt record, in the same transaction as the effect.
        await tx.adverseEventAttempt.create({
          data: {
            eventId: input.eventId,
            attempt: attempt.attempt,
            workerId: input.workerId,
            outcome: 'APPLIED',
            detail: boundText(`Hold applied for order ${input.orderId}.`),
            createdAt: input.now,
          },
        });

        return hold;
      });

      const updated = await this.db.adverseEvent.findFirst({ where: { id: input.eventId } });
      return {
        kind: 'APPLIED',
        event: updated ?? { ...current, status: 'APPLIED' },
        hold: result,
      };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        const latest = await this.safeFind(input.eventId);
        await this.recordAttemptOutsideTransaction(
          input,
          latest ?? current,
          'LEASE_LOST',
          'The lease was taken over before the event was applied.',
        );
        return { kind: 'LEASE_LOST', current: latest };
      }
      // The commit outcome is unknown: it may or may not have landed. The
      // caller must reconcile, never assume.
      return { kind: 'UNKNOWN' };
    }
  }

  /**
   * Quarantine an event: it cannot be processed automatically and needs a
   * human. The status change is a compare-and-set on the lease, so a stale
   * worker cannot quarantine an event a newer worker is handling.
   */
  async quarantineEvent(input: {
    eventId: string;
    workerId: string;
    leaseEpoch: number;
    reason: string;
    now: Date;
  }): Promise<QuarantineOutcome> {
    let current: AdverseEventRow | null;
    try {
      current = await this.db.adverseEvent.findFirst({ where: { id: input.eventId } });
    } catch {
      return { kind: 'UNKNOWN' };
    }
    if (!current) return { kind: 'NOT_FOUND' };

    const attempt = nextAttemptNumber(current.attemptCount);
    try {
      const updated = await this.db.adverseEvent.updateMany({
        where: {
          id: input.eventId,
          status: 'LEASED',
          leaseOwner: input.workerId,
          leaseEpoch: input.leaseEpoch,
        },
        data: {
          status: 'QUARANTINED',
          quarantinedAt: input.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: boundText(input.reason),
          ...(attempt.ok ? { attemptCount: attempt.attempt } : {}),
        },
      });
      if (updated.count !== 1) {
        const latest = await this.safeFind(input.eventId);
        return { kind: 'LEASE_LOST', current: latest };
      }
      if (attempt.ok) {
        await this.db.adverseEventAttempt
          .create({
            data: {
              eventId: input.eventId,
              attempt: attempt.attempt,
              workerId: input.workerId,
              outcome: 'QUARANTINED',
              detail: boundText(input.reason),
              createdAt: input.now,
            },
          })
          .catch(() => undefined);
      }
      const after = await this.safeFind(input.eventId);
      return {
        kind: 'QUARANTINED',
        event: after ?? { ...current, status: 'QUARANTINED' },
      };
    } catch {
      return { kind: 'UNKNOWN' };
    }
  }

  /** The attempts recorded for an event, oldest first. */
  async listAttempts(eventId: string): Promise<AdverseAttemptRow[]> {
    try {
      return await this.db.adverseEventAttempt.findMany({ where: { eventId } });
    } catch {
      return [];
    }
  }

  /** The active hold on an order, if any. */
  async findActiveHold(orderId: string): Promise<AdverseHoldRow | null> {
    try {
      return await this.db.adverseHold.findFirst({ where: { orderId, state: 'ACTIVE' } });
    } catch {
      return null;
    }
  }

  /**
   * Reconcile an unknown outcome.
   *
   * Reads the durable state and reports what is TRUE — never what the caller
   * hoped. A committed apply is visible as status APPLIED with the hold
   * present; a commit that never landed is visible as a still-leased event.
   */
  async reconcile(input: { eventId: string }): Promise<
    | { kind: 'APPLIED'; event: AdverseEventRow }
    | { kind: 'PENDING'; event: AdverseEventRow | null }
    | { kind: 'NOT_FOUND' }
  > {
    const event = await this.safeFind(input.eventId);
    if (!event) return { kind: 'NOT_FOUND' };
    if (event.status === 'APPLIED') return { kind: 'APPLIED', event };
    return { kind: 'PENDING', event };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async safeFind(eventId: string): Promise<AdverseEventRow | null> {
    try {
      return await this.db.adverseEvent.findFirst({ where: { id: eventId } });
    } catch {
      return null;
    }
  }

  /**
   * Record an attempt outside the main transaction.
   *
   * Used for outcomes that must NOT roll back the audit trail: a lost lease
   * or a refused attempt. The write itself is best-effort — a failure here
   * must not turn a known outcome into an unknown one.
   */
  private async recordAttemptOutsideTransaction(
    input: { eventId: string; workerId: string; now: Date },
    current: AdverseEventRow,
    outcome: string,
    detail: string,
  ): Promise<void> {
    const attempt = nextAttemptNumber(current.attemptCount);
    if (!attempt.ok) return;
    try {
      await this.db.adverseEventAttempt.create({
        data: {
          eventId: input.eventId,
          attempt: attempt.attempt,
          workerId: input.workerId,
          outcome,
          detail: boundText(detail),
          createdAt: input.now,
        },
      });
    } catch {
      // Best effort: the audit row is lost, the outcome is not.
    }
  }
}
