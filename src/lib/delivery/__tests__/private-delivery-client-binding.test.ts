// ============================================================================
// PRIVATE DELIVERY — DURABLE PERSISTENCE BINDING — OFFLINE TESTS
// ============================================================================
// Hermetic: no database, no network, no provider. The delegate seam is
// satisfied by an in-memory double that emulates the unique constraints and
// the compare-and-set semantics the contract depends on.
//
// The double is NOT a production adapter and these tests make no claim about
// a live PostgreSQL instance. They prove that the BINDING is correct: that
// the single-use transition is one conditional update, that it is decided by
// the store rather than by a read the caller made first, that an unknown
// commit is never reported as a consumption, and that a hold the store cannot
// answer fails closed.
//
// The identifiers deliberately avoid underscores: the adverse-intake mapping
// bounds its identifiers to a charset that does not include them, so the
// cross-proposal bridge at the bottom of this file uses the same order id on
// both sides.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableDeliveryStore,
  type DeliveryDb,
  type DeliveryEntitlementAssetRow,
  type DeliveryEntitlementRow,
  type DeliveryHoldRow,
  type DeliveryRecordRow,
  type DeliveryTicketAssetRow,
  type DeliveryTicketEventRow,
  type DeliveryTicketRow,
  type EngagementRow,
  type PaymentEventRow,
} from '../private-delivery-client-binding';
import { evaluateEntitlement, issueDeliveryTicket, redeemDeliveryTicket } from '../private-delivery';
import { createHmacTicketSigner, createInMemoryPrivateStorage } from '../offline-fakes';
import type { DeliveryAsset, EntitlementRecord, TicketRecord } from '../ports';
import {
  AdverseIntakeStore,
  type AdverseAttemptRow,
  type AdverseEventRow,
  type AdverseEvidenceRow,
  type AdverseIntakeDb,
} from '@/lib/product-factory/adverse-intake-client-binding';
import { normalizeAdverseEvent } from '@/lib/product-factory/adverse-intake-mapping';

const NOW = new Date('2026-04-01T09:00:00.000Z');
const ORDER = 'eng2001';
const BUYER = 'alice';
const OTHER_BUYER = 'mallory';
const VERSION = 'ver1';
const PACKAGE = 'pkg1';
const SECRET = 'a-very-secret-signing-key';
const TOKEN = 'a-raw-bearer-token-of-at-least-16-chars';

const ASSET: DeliveryAsset = {
  assetId: 'asset1',
  kind: 'PRODUCT_PACKAGE',
  contentHash: 'a'.repeat(64),
  sizeBytes: 2048,
  label: 'The playbook',
};

const SIGNER = createHmacTicketSigner(SECRET);
const STORAGE = createInMemoryPrivateStorage([
  { assetId: ASSET.assetId, contentHash: ASSET.contentHash, sizeBytes: ASSET.sizeBytes, label: ASSET.label },
]);

// ---------------------------------------------------------------------------
// The in-memory delegate double
// ---------------------------------------------------------------------------

/** The commit landed, but the answer was lost on the way back. */
class LostAnswerError extends Error {
  constructor() {
    super('connection reset after commit');
    this.name = 'LostAnswerError';
  }
}

interface FakeOptions {
  /** Make every read throw: the outcome cannot be determined. */
  failReads?: boolean;
  /** Run the transaction body and then throw: the commit may have landed. */
  loseAnswerOnTransaction?: boolean;
  /** Force the consumption compare-and-set to match zero rows. */
  forceConsumeCountZero?: boolean;
}

/**
 * Read one field off a row.
 *
 * The helpers below are generic over the row type, so the doubles never
 * need a cast to a loose "row" shape: `clone` keeps the concrete row type
 * and `matches`/`applyData` go through this one typed indirection.
 */
function readField(row: object, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

/** A copy of a row. The copy is detached from the stored row. */
function clone<T extends object>(row: T): T {
  return { ...row };
}

/** Does a row match the WHERE clause of a delegate call? */
function matches<T extends object>(row: T, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      // A compound unique key: { entitlementId_assetId: { entitlementId, assetId } }.
      for (const [field, value] of Object.entries(expected as Record<string, unknown>)) {
        if (readField(row, field) !== value) return false;
      }
      continue;
    }
    if (readField(row, key) !== expected) return false;
  }
  return true;
}

/** Apply a delegate's `data` to a row. */
function applyData<T extends object>(row: T, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (key === 'assetIds' && Array.isArray(value)) {
      Object.assign(row, { [key]: [...value] });
      continue;
    }
    Object.assign(row, { [key]: value });
  }
}

class FakeDeliveryDb {
  entitlements = new Map<string, DeliveryEntitlementRow>();
  entitlementAssets = new Map<string, DeliveryEntitlementAssetRow>();
  tickets = new Map<string, DeliveryTicketRow>();
  ticketAssets = new Map<string, DeliveryTicketAssetRow>();
  deliveries = new Map<string, DeliveryRecordRow>();
  ticketEvents = new Map<string, DeliveryTicketEventRow>();
  holds = new Map<string, DeliveryHoldRow>();
  paymentEvents: PaymentEventRow[] = [];
  engagements = new Map<string, EngagementRow>();

  // The adverse-intake tables, so the two proposals can be exercised together.
  adverseEvents = new Map<string, AdverseEventRow>();
  adverseAttempts = new Map<string, AdverseAttemptRow>();
  adverseEvidence = new Map<string, AdverseEvidenceRow>();

  /** Every delegate call, in order. Used to prove the shape of a write. */
  statements: string[] = [];

  options: FakeOptions = {};
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private track(statement: string): void {
    this.statements.push(statement);
  }

  // -- entitlements --------------------------------------------------------

  deliveryEntitlement = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<DeliveryEntitlementRow | null> => {
      this.track('deliveryEntitlement.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.entitlements.values()) {
        if (matches(row, args.where)) return clone(row);
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<DeliveryEntitlementRow> => {
      this.track('deliveryEntitlement.create');
      const data = args.data;
      const id = String(data.id);
      if (this.entitlements.has(id)) {
        throw new Error('Unique constraint failed on DeliveryEntitlement.id');
      }
      const row: DeliveryEntitlementRow = {
        id,
        orderId: String(data.orderId),
        buyerId: String(data.buyerId),
        productVersionId: String(data.productVersionId),
        packageId: data.packageId === null || data.packageId === undefined ? null : String(data.packageId),
        assetReviewState: (data.assetReviewState as DeliveryEntitlementRow['assetReviewState']) ?? 'REVIEW_READY',
        state: (data.state as DeliveryEntitlementRow['state']) ?? 'GRANTED',
        issuedAt: new Date(String(data.issuedAt)),
        expiresAt: data.expiresAt ? new Date(String(data.expiresAt)) : null,
        revokedAt: data.revokedAt ? new Date(String(data.revokedAt)) : null,
        revocationReason:
          data.revocationReason === null || data.revocationReason === undefined
            ? null
            : String(data.revocationReason),
        createdAt: new Date(String(data.createdAt)),
        updatedAt: new Date(String(data.updatedAt)),
      };
      this.entitlements.set(id, row);
      return clone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      this.track('deliveryEntitlement.updateMany');
      if (this.options.failReads) throw new Error('read failed');
      let count = 0;
      for (const row of this.entitlements.values()) {
        if (!matches(row, args.where)) continue;
        applyData(row, args.data);
        count += 1;
      }
      return { count };
    },
  };

  deliveryEntitlementAsset = {
    findMany: async (args: { where: Record<string, unknown> }): Promise<DeliveryEntitlementAssetRow[]> => {
      this.track('deliveryEntitlementAsset.findMany');
      if (this.options.failReads) throw new Error('read failed');
      const found: DeliveryEntitlementAssetRow[] = [];
      for (const row of this.entitlementAssets.values()) {
        if (matches(row, args.where)) found.push(clone(row));
      }
      return found;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<DeliveryEntitlementAssetRow> => {
      this.track('deliveryEntitlementAsset.create');
      const data = args.data;
      const entitlementId = String(data.entitlementId);
      const assetId = String(data.assetId);
      for (const row of this.entitlementAssets.values()) {
        if (row.entitlementId === entitlementId && row.assetId === assetId) {
          throw new Error('Unique constraint failed on (entitlementId, assetId)');
        }
      }
      const row: DeliveryEntitlementAssetRow = {
        id: this.nextId('ea'),
        entitlementId,
        assetId,
        kind: data.kind as DeliveryEntitlementAssetRow['kind'],
        contentHash: String(data.contentHash),
        sizeBytes: Number(data.sizeBytes),
        label: String(data.label),
        createdAt: new Date(String(data.createdAt)),
      };
      this.entitlementAssets.set(row.id, row);
      return clone(row);
    },
    upsert: async (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryEntitlementAssetRow> => {
      this.track('deliveryEntitlementAsset.upsert');
      for (const row of this.entitlementAssets.values()) {
        if (matches(row, args.where)) {
          applyData(row, args.update);
          return clone(row);
        }
      }
      return this.deliveryEntitlementAsset.create({ data: args.create });
    },
  };

  // -- tickets -------------------------------------------------------------

  deliveryTicket = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<DeliveryTicketRow | null> => {
      this.track('deliveryTicket.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.tickets.values()) {
        if (matches(row, args.where)) return clone(row);
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<DeliveryTicketRow> => {
      this.track('deliveryTicket.create');
      const data = args.data;
      const id = String(data.id);
      if (this.tickets.has(id)) throw new Error('Unique constraint failed on DeliveryTicket.id');
      const fingerprint = String(data.tokenFingerprint);
      for (const row of this.tickets.values()) {
        if (row.tokenFingerprint === fingerprint) {
          throw new Error('Unique constraint failed on DeliveryTicket.tokenFingerprint');
        }
      }
      const row: DeliveryTicketRow = {
        id,
        tokenFingerprint: fingerprint,
        entitlementId: String(data.entitlementId),
        orderId: String(data.orderId),
        buyerId: String(data.buyerId),
        productVersionId: String(data.productVersionId),
        packageId: data.packageId === null || data.packageId === undefined ? null : String(data.packageId),
        state: (data.state as DeliveryTicketRow['state']) ?? 'ISSUED',
        issuedAt: new Date(String(data.issuedAt)),
        expiresAt: new Date(String(data.expiresAt)),
        consumedAt: data.consumedAt ? new Date(String(data.consumedAt)) : null,
        consumedByDeliveryId:
          data.consumedByDeliveryId === null || data.consumedByDeliveryId === undefined
            ? null
            : String(data.consumedByDeliveryId),
        revokedAt: data.revokedAt ? new Date(String(data.revokedAt)) : null,
        revocationReason:
          data.revocationReason === null || data.revocationReason === undefined
            ? null
            : String(data.revocationReason),
        createdAt: new Date(String(data.createdAt)),
        updatedAt: new Date(String(data.updatedAt)),
      };
      this.tickets.set(id, row);
      return clone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      this.track('deliveryTicket.updateMany');
      if (this.options.failReads) throw new Error('read failed');
      let count = 0;
      for (const row of this.tickets.values()) {
        if (!matches(row, args.where)) continue;
        if (this.options.forceConsumeCountZero && args.data.state === 'CONSUMED') continue;
        applyData(row, args.data);
        count += 1;
      }
      return { count };
    },
  };

  deliveryTicketAsset = {
    findMany: async (args: { where: Record<string, unknown> }): Promise<DeliveryTicketAssetRow[]> => {
      this.track('deliveryTicketAsset.findMany');
      if (this.options.failReads) throw new Error('read failed');
      const found: DeliveryTicketAssetRow[] = [];
      for (const row of this.ticketAssets.values()) {
        if (matches(row, args.where)) found.push(clone(row));
      }
      return found;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<DeliveryTicketAssetRow> => {
      this.track('deliveryTicketAsset.create');
      const data = args.data;
      const ticketId = String(data.ticketId);
      const assetId = String(data.assetId);
      for (const row of this.ticketAssets.values()) {
        if (row.ticketId === ticketId && row.assetId === assetId) {
          throw new Error('Unique constraint failed on (ticketId, assetId)');
        }
      }
      const row: DeliveryTicketAssetRow = {
        id: this.nextId('ta'),
        ticketId,
        assetId,
        kind: data.kind as DeliveryTicketAssetRow['kind'],
        contentHash: String(data.contentHash),
        sizeBytes: Number(data.sizeBytes),
        label: String(data.label),
        createdAt: new Date(String(data.createdAt)),
      };
      this.ticketAssets.set(row.id, row);
      return clone(row);
    },
    upsert: async (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryTicketAssetRow> => {
      this.track('deliveryTicketAsset.upsert');
      for (const row of this.ticketAssets.values()) {
        if (matches(row, args.where)) {
          applyData(row, args.update);
          return clone(row);
        }
      }
      return this.deliveryTicketAsset.create({ data: args.create });
    },
  };

  // -- deliveries and events ----------------------------------------------

  deliveryRecord = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<DeliveryRecordRow | null> => {
      this.track('deliveryRecord.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.deliveries.values()) {
        if (matches(row, args.where)) return clone(row);
      }
      return null;
    },
    upsert: async (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryRecordRow> => {
      this.track('deliveryRecord.upsert');
      for (const row of this.deliveries.values()) {
        if (matches(row, args.where)) {
          applyData(row, args.update);
          return clone(row);
        }
      }
      const data = args.create;
      const row: DeliveryRecordRow = {
        deliveryId: String(data.deliveryId),
        ticketId: String(data.ticketId),
        entitlementId: String(data.entitlementId),
        orderId: String(data.orderId),
        buyerId: String(data.buyerId),
        outcome: data.outcome as DeliveryRecordRow['outcome'],
        assetIds: Array.isArray(data.assetIds) ? [...(data.assetIds as string[])] : [],
        reason: String(data.reason ?? ''),
        createdAt: new Date(String(data.createdAt)),
        updatedAt: new Date(String(data.updatedAt)),
      };
      this.deliveries.set(row.deliveryId, row);
      return clone(row);
    },
  };

  deliveryTicketEvent = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<DeliveryTicketEventRow | null> => {
      this.track('deliveryTicketEvent.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.ticketEvents.values()) {
        if (matches(row, args.where)) return clone(row);
      }
      return null;
    },
    upsert: async (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryTicketEventRow> => {
      this.track('deliveryTicketEvent.upsert');
      for (const row of this.ticketEvents.values()) {
        if (matches(row, args.where)) {
          applyData(row, args.update);
          return clone(row);
        }
      }
      const data = args.create;
      const row: DeliveryTicketEventRow = {
        id: this.nextId('te'),
        ticketId: String(data.ticketId),
        kind: String(data.kind),
        reference: String(data.reference),
        detail: String(data.detail ?? ''),
        createdAt: new Date(String(data.createdAt)),
      };
      this.ticketEvents.set(row.id, row);
      return clone(row);
    },
  };

  // -- the hold, the payment ledger and the order -------------------------

  adverseHold = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<DeliveryHoldRow | null> => {
      this.track('adverseHold.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.holds.values()) {
        if (matches(row, args.where)) return clone(row);
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<DeliveryHoldRow> => {
      this.track('adverseHold.create');
      const data = args.data;
      const sourceEventId = String(data.sourceEventId);
      const orderId = String(data.orderId);
      for (const row of this.holds.values()) {
        if (row.sourceEventId === sourceEventId && row.orderId === orderId) {
          throw new Error('Unique constraint failed on (sourceEventId, orderId)');
        }
      }
      const row: DeliveryHoldRow = {
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
      return clone(row);
    },
    updateMany: async (): Promise<{ count: number }> => ({ count: 0 }),
  };

  paymentEvent = {
    findMany: async (args: { where: Record<string, unknown> }): Promise<PaymentEventRow[]> => {
      this.track('paymentEvent.findMany');
      if (this.options.failReads) throw new Error('read failed');
      return this.paymentEvents.filter((row) => matches(row, args.where)).map((row) => ({ ...row }));
    },
  };

  serviceEngagement = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<EngagementRow | null> => {
      this.track('serviceEngagement.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.engagements.values()) {
        if (matches(row, args.where)) return { ...row };
      }
      return null;
    },
  };

  // -- the adverse-intake tables, for the cross-proposal bridge ------------

  adverseEvent = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<AdverseEventRow | null> => {
      this.track('adverseEvent.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.adverseEvents.values()) {
        if (matches(row, args.where)) return clone(row);
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<AdverseEventRow> => {
      this.track('adverseEvent.create');
      const data = args.data;
      const provider = String(data.provider);
      const providerEventId = String(data.providerEventId);
      for (const row of this.adverseEvents.values()) {
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
          data.amountMinor === null || data.amountMinor === undefined ? null : Number(data.amountMinor),
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
      this.adverseEvents.set(row.id, row);
      return clone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      this.track('adverseEvent.updateMany');
      if (this.options.failReads) throw new Error('read failed');
      let count = 0;
      for (const row of this.adverseEvents.values()) {
        if (!matches(row, args.where)) continue;
        applyData(row, args.data);
        count += 1;
      }
      return { count };
    },
  };

  adverseEventAttempt = {
    create: async (args: { data: Record<string, unknown> }): Promise<AdverseAttemptRow> => {
      this.track('adverseEventAttempt.create');
      const data = args.data;
      const eventId = String(data.eventId);
      const attempt = Number(data.attempt);
      for (const row of this.adverseAttempts.values()) {
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
      this.adverseAttempts.set(row.id, row);
      return clone(row);
    },
    findMany: async (args: { where: Record<string, unknown> }): Promise<AdverseAttemptRow[]> => {
      this.track('adverseEventAttempt.findMany');
      if (this.options.failReads) throw new Error('read failed');
      return [...this.adverseAttempts.values()]
        .filter((row) => matches(row, args.where))
        .map((row) => clone(row));
    },
  };

  adverseEventEvidence = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<AdverseEvidenceRow | null> => {
      this.track('adverseEventEvidence.findFirst');
      if (this.options.failReads) throw new Error('read failed');
      for (const row of this.adverseEvidence.values()) {
        if (matches(row, args.where)) return clone(row);
      }
      return null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<AdverseEvidenceRow> => {
      this.track('adverseEventEvidence.create');
      const data = args.data;
      const eventId = String(data.eventId);
      const kind = String(data.kind);
      const reference = String(data.reference);
      for (const row of this.adverseEvidence.values()) {
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
      this.adverseEvidence.set(row.id, row);
      return clone(row);
    },
  };

  // -- the transaction -----------------------------------------------------

  /**
   * The double emulates a rollback with a snapshot of the mutable tables.
   *
   * That is enough for these tests, and it is honestly a simplification: a
   * real engine gives per-statement snapshots, not per-transaction ones.
   */
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const snapshot = {
      entitlements: new Map(this.entitlements),
      entitlementAssets: new Map(this.entitlementAssets),
      tickets: new Map(this.tickets),
      ticketAssets: new Map(this.ticketAssets),
      deliveries: new Map(this.deliveries),
      ticketEvents: new Map(this.ticketEvents),
      holds: new Map(this.holds),
      adverseEvents: new Map(this.adverseEvents),
      adverseAttempts: new Map(this.adverseAttempts),
      adverseEvidence: new Map(this.adverseEvidence),
    };
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
      this.entitlements = snapshot.entitlements;
      this.entitlementAssets = snapshot.entitlementAssets;
      this.tickets = snapshot.tickets;
      this.ticketAssets = snapshot.ticketAssets;
      this.deliveries = snapshot.deliveries;
      this.ticketEvents = snapshot.ticketEvents;
      this.holds = snapshot.holds;
      this.adverseEvents = snapshot.adverseEvents;
      this.adverseAttempts = snapshot.adverseAttempts;
      this.adverseEvidence = snapshot.adverseEvidence;
      throw error;
    }
  }
}

function makeStore(options: FakeOptions = {}) {
  const db = new FakeDeliveryDb();
  // `loseAnswerOnTransaction` is deliberately NOT copied here: it must fire
  // on one chosen transaction, not on the setup writes.
  db.options = {
    failReads: options.failReads,
    forceConsumeCountZero: options.forceConsumeCountZero,
  };
  const store = new DurableDeliveryStore(db as unknown as DeliveryDb);
  return { db, store };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedPaidOrder(db: FakeDeliveryDb, overrides: Partial<EngagementRow> = {}): void {
  db.engagements.set(ORDER, {
    id: ORDER,
    prospectId: BUYER,
    state: 'WORK_AUTHORIZED',
    paymentState: 'PAYMENT_VERIFIED',
    verificationSource: 'PROVIDER_WEBHOOK',
    totalPrice: 99,
    currency: 'USD',
    verifiedAt: NOW,
    ...overrides,
  });
  db.paymentEvents.push({
    id: 'pe_1',
    provider: 'polar',
    providerEventId: 'evt-paid-1',
    eventType: 'order.paid',
    outcome: 'RECORDED',
    signatureVerified: true,
    verificationMethod: 'PROVIDER_WEBHOOK',
    amountUsd: 99,
    currency: 'USD',
    engagementId: ORDER,
    receivedAt: NOW,
    processedAt: NOW,
  });
}

function entitlementRecord(overrides: Partial<EntitlementRecord> = {}): EntitlementRecord {
  return {
    entitlementId: 'ent1',
    orderId: ORDER,
    buyerId: BUYER,
    productVersionId: VERSION,
    packageId: PACKAGE,
    assets: [ASSET],
    assetReviewState: 'REVIEW_READY',
    state: 'GRANTED',
    issuedAt: NOW.toISOString(),
    expiresAt: null,
    revocationReason: '',
    ...overrides,
  };
}

function ticketRecord(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    ticketId: 'tkt1',
    tokenFingerprint: SIGNER.fingerprint(TOKEN),
    entitlementId: 'ent1',
    orderId: ORDER,
    buyerId: BUYER,
    productVersionId: VERSION,
    packageId: PACKAGE,
    assets: [ASSET],
    state: 'ISSUED',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
    consumedAt: null,
    consumedByDeliveryId: null,
    ...overrides,
  };
}

async function issueTicket(store: DurableDeliveryStore): Promise<void> {
  const saved = await store.saveTicket(ticketRecord());
  assert.equal(saved.ok, true);
}

// ---------------------------------------------------------------------------
// The binding
// ---------------------------------------------------------------------------

describe('durable delivery store — entitlement', () => {
  it('stores an entitlement with its pinned assets and reads them back', async () => {
    const { db, store } = makeStore();
    const record = entitlementRecord();

    assert.equal((await store.saveEntitlement(record)).ok, true);

    const read = await store.findEntitlement('ent1');
    assert.ok(read);
    assert.equal(read?.orderId, ORDER);
    assert.equal(read?.buyerId, BUYER);
    assert.equal(read?.productVersionId, VERSION);
    assert.equal(read?.packageId, PACKAGE);
    assert.equal(read?.assets.length, 1);
    assert.equal(read?.assets[0]?.contentHash, ASSET.contentHash);
    assert.equal(db.entitlementAssets.size, 1);
  });

  it('is idempotent on the deterministic entitlement id', async () => {
    const { db, store } = makeStore();
    const record = entitlementRecord();

    assert.equal((await store.saveEntitlement(record)).ok, true);
    assert.equal((await store.saveEntitlement(record)).ok, true);

    assert.equal(db.entitlements.size, 1);
    assert.equal(db.entitlementAssets.size, 1);
  });

  it('refuses to revive a revoked entitlement', async () => {
    const { store } = makeStore();
    assert.equal((await store.saveEntitlement(entitlementRecord())).ok, true);

    const revoked = await store.revokeEntitlement('ent1', 'chargeback', NOW.toISOString());
    assert.equal(revoked.ok, true);

    // A second grant must not hand the access back.
    const again = await store.saveEntitlement(entitlementRecord());
    assert.equal(again.ok, false);

    const read = await store.findEntitlement('ent1');
    assert.equal(read?.state, 'REVOKED');
  });

  it('finds the entitlement by order and buyer', async () => {
    const { store } = makeStore();
    await store.saveEntitlement(entitlementRecord());

    assert.ok(await store.findEntitlementByOrder(ORDER, BUYER));
    assert.equal(await store.findEntitlementByOrder(ORDER, OTHER_BUYER), null);
  });
});

// ---------------------------------------------------------------------------
// The single-use transition
// ---------------------------------------------------------------------------

describe('durable delivery store — the single-use transition', () => {
  it('consumes a ticket exactly once', async () => {
    const { db, store } = makeStore();
    await issueTicket(store);

    const outcome = await store.consumeTicket({
      ticketId: 'tkt1',
      tokenFingerprint: SIGNER.fingerprint(TOKEN),
      buyerId: BUYER,
      deliveryId: 'dlv1',
      at: NOW.toISOString(),
    });

    assert.equal(outcome, 'CONSUMED');
    const row = db.tickets.get('tkt1');
    assert.equal(row?.state, 'CONSUMED');
    assert.equal(row?.consumedByDeliveryId, 'dlv1');
    assert.equal(row?.consumedAt?.toISOString(), NOW.toISOString());
  });

  it('decides with one conditional update and never reads first', async () => {
    const { db, store } = makeStore();
    await issueTicket(store);
    db.statements = [];

    await store.consumeTicket({
      ticketId: 'tkt1',
      tokenFingerprint: SIGNER.fingerprint(TOKEN),
      buyerId: BUYER,
      deliveryId: 'dlv1',
      at: NOW.toISOString(),
    });

    assert.equal(
      db.statements[0],
      'deliveryTicket.updateMany',
      'the consumption must be decided by the update, not by a prior read',
    );
  });

  it('reports an idempotent retry by the same delivery as already consumed', async () => {
    const { store } = makeStore();
    await issueTicket(store);
    const input = {
      ticketId: 'tkt1',
      tokenFingerprint: SIGNER.fingerprint(TOKEN),
      buyerId: BUYER,
      deliveryId: 'dlv1',
      at: NOW.toISOString(),
    };

    assert.equal(await store.consumeTicket(input), 'CONSUMED');
    assert.equal(await store.consumeTicket(input), 'ALREADY_CONSUMED');
  });

  it('reports a competing delivery as a conflict', async () => {
    const { store } = makeStore();
    await issueTicket(store);

    assert.equal(
      await store.consumeTicket({
        ticketId: 'tkt1',
        tokenFingerprint: SIGNER.fingerprint(TOKEN),
        buyerId: BUYER,
        deliveryId: 'dlv1',
        at: NOW.toISOString(),
      }),
      'CONSUMED',
    );
    assert.equal(
      await store.consumeTicket({
        ticketId: 'tkt1',
        tokenFingerprint: SIGNER.fingerprint(TOKEN),
        buyerId: BUYER,
        deliveryId: 'dlv2',
        at: NOW.toISOString(),
      }),
      'CONFLICT',
    );
  });

  it('reports an unknown ticket as not found', async () => {
    const { store } = makeStore();
    assert.equal(
      await store.consumeTicket({
        ticketId: 'tkt-missing',
        tokenFingerprint: SIGNER.fingerprint(TOKEN),
        buyerId: BUYER,
        deliveryId: 'dlv1',
        at: NOW.toISOString(),
      }),
      'NOT_FOUND',
    );
  });

  it('refuses a ticket whose fingerprint does not match', async () => {
    const { store } = makeStore();
    await issueTicket(store);
    assert.equal(
      await store.consumeTicket({
        ticketId: 'tkt1',
        tokenFingerprint: SIGNER.fingerprint('a-different-token-of-enough-length'),
        buyerId: BUYER,
        deliveryId: 'dlv1',
        at: NOW.toISOString(),
      }),
      'NOT_FOUND',
    );
  });

  it('lets only one of two concurrent redemptions spend the ticket', async () => {
    const { db, store } = makeStore();
    await issueTicket(store);

    const [a, b] = await Promise.all([
      store.consumeTicket({
        ticketId: 'tkt1',
        tokenFingerprint: SIGNER.fingerprint(TOKEN),
        buyerId: BUYER,
        deliveryId: 'dlv1',
        at: NOW.toISOString(),
      }),
      store.consumeTicket({
        ticketId: 'tkt1',
        tokenFingerprint: SIGNER.fingerprint(TOKEN),
        buyerId: BUYER,
        deliveryId: 'dlv2',
        at: NOW.toISOString(),
      }),
    ]);

    const outcomes = [a, b].sort();
    assert.deepEqual(outcomes, ['CONFLICT', 'CONSUMED']);
    assert.equal(db.tickets.get('tkt1')?.state, 'CONSUMED');
    assert.equal(db.tickets.get('tkt1')?.consumedByDeliveryId, 'dlv1');
  });

  it('refuses a concurrent redemption by a second buyer', async () => {
    const { db, store } = makeStore();
    await issueTicket(store);

    const [mine, theirs] = await Promise.all([
      store.consumeTicket({
        ticketId: 'tkt1',
        tokenFingerprint: SIGNER.fingerprint(TOKEN),
        buyerId: BUYER,
        deliveryId: 'dlv1',
        at: NOW.toISOString(),
      }),
      store.consumeTicket({
        ticketId: 'tkt1',
        tokenFingerprint: SIGNER.fingerprint(TOKEN),
        buyerId: OTHER_BUYER,
        deliveryId: 'dlv-other',
        at: NOW.toISOString(),
      }),
    ]);

    assert.equal(mine, 'CONSUMED');
    assert.equal(theirs, 'CONFLICT');
    assert.equal(db.tickets.get('tkt1')?.consumedByDeliveryId, 'dlv1');
  });

  it('never reports a lost commit as a consumption', async () => {
    const { db, store } = makeStore();
    await issueTicket(store);
    db.options.loseAnswerOnTransaction = true;

    const outcome = await store.consumeTicket({
      ticketId: 'tkt1',
      tokenFingerprint: SIGNER.fingerprint(TOKEN),
      buyerId: BUYER,
      deliveryId: 'dlv1',
      at: NOW.toISOString(),
    });

    assert.equal(outcome, 'STORE_UNAVAILABLE', 'an unknown commit must never read as consumed');
    // The write landed even though the answer was lost: reconciling with the
    // same delivery id settles it exactly.
    assert.equal(db.tickets.get('tkt1')?.state, 'CONSUMED');
    const reconciled = await store.consumeTicket({
      ticketId: 'tkt1',
      tokenFingerprint: SIGNER.fingerprint(TOKEN),
      buyerId: BUYER,
      deliveryId: 'dlv1',
      at: NOW.toISOString(),
    });
    assert.equal(reconciled, 'ALREADY_CONSUMED');
  });

  it('reports an indeterminate consumption as unknown, never as a failure', async () => {
    const { store } = makeStore({ forceConsumeCountZero: true });
    await issueTicket(store);

    const outcome = await store.consumeTicket({
      ticketId: 'tkt1',
      tokenFingerprint: SIGNER.fingerprint(TOKEN),
      buyerId: BUYER,
      deliveryId: 'dlv1',
      at: NOW.toISOString(),
    });

    assert.equal(
      outcome,
      'STORE_UNAVAILABLE',
      'a consumption that cannot be determined must be reconciled, not declared a failure',
    );
  });
});

// ---------------------------------------------------------------------------
// Tickets, expiry, revocation, deliveries
// ---------------------------------------------------------------------------

describe('durable delivery store — tickets and deliveries', () => {
  it('issues a ticket with the pinned package, version and asset digest', async () => {
    const { db, store } = makeStore();

    assert.equal((await store.saveTicket(ticketRecord())).ok, true);

    const read = await store.findTicket('tkt1');
    assert.equal(read?.packageId, PACKAGE);
    assert.equal(read?.productVersionId, VERSION);
    assert.equal(read?.assets[0]?.contentHash, ASSET.contentHash);
    assert.equal(db.ticketAssets.size, 1);
  });

  it('never stores the raw token, only its fingerprint', async () => {
    const { db, store } = makeStore();
    await store.saveTicket(ticketRecord({ tokenFingerprint: 'fp-keyed' }));

    const serialized = JSON.stringify([...db.tickets.values()]);
    assert.ok(serialized.includes('fp-keyed'));
    assert.ok(!serialized.includes('a-raw-bearer-token'));
  });

  it('refuses to replace a ticket that is no longer issued', async () => {
    const { store } = makeStore();
    await issueTicket(store);
    await store.consumeTicket({
      ticketId: 'tkt1',
      tokenFingerprint: SIGNER.fingerprint(TOKEN),
      buyerId: BUYER,
      deliveryId: 'dlv1',
      at: NOW.toISOString(),
    });

    const again = await store.saveTicket(ticketRecord());
    assert.equal(again.ok, false, 'a spent ticket must never be reset to ISSUED');
  });

  it('finds a ticket by its fingerprint', async () => {
    const { store } = makeStore();
    await issueTicket(store);
    const read = await store.findTicketByFingerprint(SIGNER.fingerprint(TOKEN));
    assert.equal(read?.ticketId, 'tkt1');
    assert.equal(await store.findTicketByFingerprint('fp-other'), null);
  });

  it('expires only an issued ticket', async () => {
    const { db, store } = makeStore();
    await issueTicket(store);

    assert.equal((await store.expireTicket('tkt1', NOW.toISOString())).ok, true);
    assert.equal(db.tickets.get('tkt1')?.state, 'EXPIRED');
    assert.ok(
      [...db.ticketEvents.values()].some((event) => event.kind === 'EXPIRED'),
      'the expiry must be recorded in the audit ledger',
    );

    // A consumed ticket is never expired back into a dead state.
    await store.saveTicket(ticketRecord({ ticketId: 'tkt2', tokenFingerprint: 'fp-2' }));
    await store.consumeTicket({
      ticketId: 'tkt2',
      tokenFingerprint: 'fp-2',
      buyerId: BUYER,
      deliveryId: 'dlv2',
      at: NOW.toISOString(),
    });
    await store.expireTicket('tkt2', NOW.toISOString());
    assert.equal(db.tickets.get('tkt2')?.state, 'CONSUMED');
  });

  it('revokes the entitlement and its outstanding tickets together', async () => {
    const { db, store } = makeStore();
    await store.saveEntitlement(entitlementRecord());
    await issueTicket(store);

    const revoked = await store.revokeEntitlement('ent1', 'chargeback', NOW.toISOString());
    assert.equal(revoked.ok, true);

    assert.equal(db.entitlements.get('ent1')?.state, 'REVOKED');
    assert.equal(db.entitlements.get('ent1')?.revocationReason, 'chargeback');
    assert.equal(db.tickets.get('tkt1')?.state, 'REVOKED', 'the outstanding ticket must die too');
  });

  it('reports a missing entitlement as not revocable', async () => {
    const { store } = makeStore();
    const revoked = await store.revokeEntitlement('ent-missing', 'x', NOW.toISOString());
    assert.equal(revoked.ok, false);
  });

  it('records the delivery idempotently', async () => {
    const { db, store } = makeStore();
    const record = {
      deliveryId: 'dlv1',
      ticketId: 'tkt1',
      entitlementId: 'ent1',
      orderId: ORDER,
      buyerId: BUYER,
      outcome: 'PENDING' as const,
      assetIds: [ASSET.assetId],
      reason: 'still confirming',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };

    assert.equal((await store.saveDelivery(record)).ok, true);
    assert.equal(
      (await store.saveDelivery({ ...record, outcome: 'DELIVERED', reason: 'delivered' })).ok,
      true,
    );

    assert.equal(db.deliveries.size, 1);
    const read = await store.findDelivery('dlv1');
    assert.equal(read?.outcome, 'DELIVERED');
    assert.equal(read?.orderId, ORDER);
  });
});

// ---------------------------------------------------------------------------
// The hold and the payment ledger
// ---------------------------------------------------------------------------

describe('durable delivery store — the hold and the payment', () => {
  it('exposes the active hold for an order', async () => {
    const { db, store } = makeStore();
    db.holds.set('hold1', {
      id: 'hold1',
      eventId: 'evt1',
      orderId: ORDER,
      buyerId: BUYER,
      reason: 'CHARGEBACK_CREATED',
      state: 'ACTIVE',
      sourceEventId: 'evt1',
      createdAt: NOW,
      releasedAt: null,
    });

    const hold = await store.findAccessHold(ORDER);
    assert.equal(hold?.reason, 'CHARGEBACK_CREATED');
    assert.equal(hold?.sourceEventId, 'evt1');
  });

  it('fails closed when the hold table cannot be answered', async () => {
    const { store } = makeStore({ failReads: true });
    await assert.rejects(
      () => store.findAccessHold(ORDER),
      'a store that cannot answer must throw so the caller fails closed',
    );
  });

  it('reads a verified payment only from an accepted, signed event on a paid order', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db);

    const payment = await store.findVerifiedPayment(ORDER);
    assert.ok(payment);
    assert.equal(payment?.buyerId, BUYER);
    assert.equal(payment?.amountUsd, 99);
    assert.equal(payment?.verificationSource, 'PROVIDER_WEBHOOK');
    assert.equal(payment?.providerEventId, 'evt-paid-1');
  });

  it('refuses a payment whose signature was never verified', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db);
    db.paymentEvents[0]!.signatureVerified = false;

    assert.equal(await store.findVerifiedPayment(ORDER), null);
  });

  it('refuses a rejected or reversed payment event', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db);
    db.paymentEvents[0]!.outcome = 'REVERSED';
    assert.equal(await store.findVerifiedPayment(ORDER), null);

    db.paymentEvents[0]!.outcome = 'REJECTED';
    assert.equal(await store.findVerifiedPayment(ORDER), null);
  });

  it('refuses an order that is no longer in the paid posture', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db, { paymentState: 'REFUNDED' });
    assert.equal(await store.findVerifiedPayment(ORDER), null);
  });

  it('refuses an order with no server-derived buyer identity', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db, { prospectId: null });
    assert.equal(await store.findVerifiedPayment(ORDER), null);
  });
});

// ---------------------------------------------------------------------------
// The rules, running on the durable binding
// ---------------------------------------------------------------------------

describe('private delivery on the durable binding', () => {
  it('issues and redeems a ticket end to end', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db);

    const granted = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: VERSION, packageId: PACKAGE, assets: [ASSET], now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(granted.ok, true);
    if (!granted.ok) return;

    const issued = await issueDeliveryTicket(
      { entitlementId: granted.entitlement.entitlementId, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.equal(issued.ticket.packageId, PACKAGE);

    const redeemed = await redeemDeliveryTicket(
      { ticketId: issued.ticket.ticketId, token: issued.ticket.token, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(redeemed.ok, true);
    if (!redeemed.ok) return;
    assert.equal(redeemed.status, 'DELIVERED');
    assert.equal(redeemed.assets.length, 1);
    assert.equal(db.deliveries.size, 1);
    assert.equal(db.tickets.get(issued.ticket.ticketId)?.state, 'CONSUMED');
  });

  it('is idempotent when the same buyer replays the same token', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db);
    const granted = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: VERSION, assets: [ASSET], now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    if (!granted.ok) return;
    const issued = await issueDeliveryTicket(
      { entitlementId: granted.entitlement.entitlementId, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    if (!issued.ok) return;

    const first = await redeemDeliveryTicket(
      { ticketId: issued.ticket.ticketId, token: issued.ticket.token, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // The same buyer retrying is the same delivery: the deterministic delivery
    // id makes it one record, not two.
    const replay = await redeemDeliveryTicket(
      { ticketId: issued.ticket.ticketId, token: issued.ticket.token, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.deliveryId, first.deliveryId);
    assert.equal(db.deliveries.size, 1, 'the replay must not create a second delivery');
  });

  it('refuses a token replayed by a different buyer', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db);
    const granted = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: VERSION, assets: [ASSET], now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    if (!granted.ok) return;
    const issued = await issueDeliveryTicket(
      { entitlementId: granted.entitlement.entitlementId, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    if (!issued.ok) return;

    const first = await redeemDeliveryTicket(
      { ticketId: issued.ticket.ticketId, token: issued.ticket.token, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(first.ok, true);

    // A stolen token presented by somebody else is refused before anything
    // is disclosed, and the ticket stays spent by its real owner.
    const stolen = await redeemDeliveryTicket(
      { ticketId: issued.ticket.ticketId, token: issued.ticket.token, buyerId: OTHER_BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(stolen.ok, false);
    if (stolen.ok) return;
    assert.equal(stolen.code, 'BUYER_MISMATCH');
    assert.equal(db.deliveries.size, 1);
    assert.equal(db.tickets.get(issued.ticket.ticketId)?.consumedByDeliveryId, first.deliveryId);
  });

  it('refuses a redemption by a different buyer', async () => {
    const { db, store } = makeStore();
    seedPaidOrder(db);
    const granted = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: VERSION, assets: [ASSET], now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    if (!granted.ok) return;
    const issued = await issueDeliveryTicket(
      { entitlementId: granted.entitlement.entitlementId, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    if (!issued.ok) return;

    const stolen = await redeemDeliveryTicket(
      { ticketId: issued.ticket.ticketId, token: issued.ticket.token, buyerId: OTHER_BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(stolen.ok, false);
    if (stolen.ok) return;
    assert.equal(stolen.code, 'BUYER_MISMATCH');
  });

  it('refuses a ticket whose package no longer matches the entitlement', async () => {
    const { store } = makeStore();
    await store.saveEntitlement(entitlementRecord({ packageId: 'pkg2' }));
    await store.saveTicket(ticketRecord({ packageId: 'pkg1' }));

    const redeemed = await redeemDeliveryTicket(
      { ticketId: 'tkt1', token: TOKEN, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(redeemed.ok, false);
    if (redeemed.ok) return;
    assert.equal(redeemed.code, 'PACKAGE_MISMATCH');
  });

  it('refuses a redemption when the adverse-intake pipeline placed a hold', async () => {
    const db = new FakeDeliveryDb();
    const store = new DurableDeliveryStore(db as unknown as DeliveryDb);
    const intake = new AdverseIntakeStore(db as unknown as AdverseIntakeDb);

    // The real adverse-intake pipeline places the hold.
    const normalized = normalizeAdverseEvent(
      {
        provider: 'polar',
        providerEventId: 'evt-chargeback-1',
        eventType: 'CHARGEBACK_CREATED',
        correlationId: 'corr-1',
        orderId: ORDER,
        buyerId: BUYER,
        amountMinor: 9900,
        currency: 'USD',
        occurredAt: NOW.toISOString(),
        payload: { reason: 'fraud' },
      },
      NOW,
    );
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;

    const stored = await intake.recordIncoming(normalized.event);
    assert.equal(stored.kind, 'STORED');
    const eventId = stored.kind === 'STORED' ? stored.event.id : '';
    const lease = await intake.acquireLease({ eventId, workerId: 'worker-a', now: NOW });
    assert.equal(lease.kind, 'ACQUIRED');
    const applied = await intake.applyEvent({
      eventId,
      workerId: 'worker-a',
      leaseEpoch: lease.kind === 'ACQUIRED' ? lease.leaseEpoch : -1,
      now: NOW,
      orderId: ORDER,
      buyerId: BUYER,
      evidenceKind: 'HOLD_APPLIED',
      evidenceReference: 'chb-1',
      holdReason: 'CHARGEBACK_CREATED',
    });
    assert.equal(applied.kind, 'APPLIED');
    assert.equal(db.holds.size, 1);

    // The delivery side must see that hold and refuse.
    await store.saveEntitlement(entitlementRecord());
    await store.saveTicket(ticketRecord());

    const redeemed = await redeemDeliveryTicket(
      { ticketId: 'tkt1', token: TOKEN, buyerId: BUYER, now: NOW },
      { store, storage: STORAGE, signer: SIGNER },
    );
    assert.equal(redeemed.ok, false);
    if (redeemed.ok) return;
    assert.equal(redeemed.code, 'ACCESS_HELD');
    assert.equal(db.tickets.get('tkt1')?.state, 'ISSUED', 'a refused delivery must not spend the ticket');
  });
});
