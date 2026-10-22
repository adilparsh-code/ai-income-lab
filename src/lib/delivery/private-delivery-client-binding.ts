// ============================================================================
// PRIVATE DELIVERY — DURABLE PERSISTENCE BINDING
// ============================================================================
// The seam between the delivery rules (./private-delivery.ts) and a real
// database. The rules are pure decision logic; this module is the only place
// that talks to durable storage.
//
// THE ONE OPERATION THAT MATTERS
// ------------------------------
// `consumeTicket` is the single-use transition. It is expressed as ONE
// conditional update:
//
//     updateMany({ where: { id, state: 'ISSUED', tokenFingerprint, buyerId },
//                  data:  { state: 'CONSUMED', consumedAt, consumedByDeliveryId } })
//
// There is deliberately NO read-then-write. The database decides which of the
// competing callers wins: the loser's update matches zero rows because the
// row no longer reads as ISSUED. A read-then-write would have a window in
// which two callers both see "ISSUED" and both believe they consumed the
// ticket; the compare-and-set has no such window.
//
// The classification reads that follow a zero-row update are NOT part of the
// decision — they only turn "the update matched nothing" into an honest
// outcome (already consumed by me, consumed by somebody else, not consumable,
// or indeterminate). The decision was already made by the database.
//
// HONEST OUTCOMES
// ---------------
// A durable write ends in three states, never two: COMMITTED, NOT COMMITTED,
// or UNKNOWN (it may or may not have landed). Every method here reports
// UNKNOWN rather than guessing:
//   - a failed write returns { ok: false } and the rules answer PENDING;
//   - a lost answer on the consumption returns STORE_UNAVAILABLE, and the
//     caller reconciles with the same deterministic delivery id;
//   - a read that cannot be answered THROWS, so the caller fails closed.
//
// FAIL CLOSED
// -----------
// `findAccessHold` deliberately does NOT catch its errors. A hold means "do
// not hand over the private assets". A store that cannot answer the question
// "is this order held?" must be treated as "maybe held", never as "not
// held" — the rules turn a thrown read into PENDING, which blocks the
// delivery.
//
// THE PROPOSALS THIS BINDS TO
// ---------------------------
// The delivery tables live in prisma/proposals/private-delivery/schema.prisma
// and the access hold lives in prisma/proposals/adverse-intake/schema.prisma.
// NEITHER has been applied: the active schema (prisma/schema.prisma) is
// untouched and no migration has been run against any database. The delegate
// seam below is structural, so this module compiles and is tested without
// either proposal being applied. A real Prisma client satisfies it once the
// proposals are applied as migrations.
//
// NOT A PRODUCTION ADAPTER
// ------------------------
// This module is exercised by the offline tests with an in-memory double
// that emulates the unique constraints and the compare-and-set semantics. It
// does not pretend a live database exists.
// ============================================================================

import type {
  AccessHold,
  ConsumeOutcome,
  DeliveryAsset,
  DeliveryAssetKind,
  DeliveryRecord,
  DeliveryStorePort,
  EntitlementRecord,
  PaymentVerificationSource,
  TicketRecord,
  VerifiedPayment,
} from './ports';

// ---------------------------------------------------------------------------
// Durable rows
// ---------------------------------------------------------------------------

/** The `DeliveryEntitlement` row. */
export interface DeliveryEntitlementRow {
  id: string;
  orderId: string;
  buyerId: string;
  productVersionId: string;
  packageId: string | null;
  assetReviewState: 'DRAFT' | 'REVIEW_READY';
  state: 'PENDING' | 'GRANTED' | 'REVOKED' | 'EXPIRED';
  issuedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The `DeliveryEntitlementAsset` row. */
export interface DeliveryEntitlementAssetRow {
  id: string;
  entitlementId: string;
  assetId: string;
  kind: DeliveryAssetKind;
  contentHash: string;
  sizeBytes: number;
  label: string;
  createdAt: Date;
}

/** The `DeliveryTicket` row. */
export interface DeliveryTicketRow {
  id: string;
  tokenFingerprint: string;
  entitlementId: string;
  orderId: string;
  buyerId: string;
  productVersionId: string;
  packageId: string | null;
  state: 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedByDeliveryId: string | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The `DeliveryTicketAsset` row — the pinned promise. */
export interface DeliveryTicketAssetRow {
  id: string;
  ticketId: string;
  assetId: string;
  kind: DeliveryAssetKind;
  contentHash: string;
  sizeBytes: number;
  label: string;
  createdAt: Date;
}

/** The `DeliveryRecord` row. */
export interface DeliveryRecordRow {
  deliveryId: string;
  ticketId: string;
  entitlementId: string;
  orderId: string;
  buyerId: string;
  outcome: 'PENDING' | 'DELIVERED' | 'FAILED';
  assetIds: string[];
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The `DeliveryTicketEvent` row — the audit ledger. */
export interface DeliveryTicketEventRow {
  id: string;
  ticketId: string;
  kind: string;
  reference: string;
  detail: string;
  createdAt: Date;
}

/**
 * The `AdverseHold` row, read from the adverse-intake proposal.
 *
 * The two proposals are related but independent: the delivery store reads
 * the hold through this delegate so a refund, chargeback, cancellation or
 * dispute blocks a delivery.
 */
export interface DeliveryHoldRow {
  id: string;
  eventId: string;
  orderId: string;
  buyerId: string | null;
  reason: string;
  state: 'ACTIVE' | 'RELEASED';
  sourceEventId: string;
  createdAt: Date;
  releasedAt: Date | null;
}

/** The active schema's `PaymentEvent` row — the payment ledger. */
export interface PaymentEventRow {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  outcome: string;
  signatureVerified: boolean;
  verificationMethod: string;
  amountUsd: number;
  currency: string;
  engagementId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

/**
 * The active schema's `ServiceEngagement` row — the paid order.
 *
 * `prospectId` is the server-derived buyer identity: the client that owns
 * the order. It is never a client-supplied value.
 */
export interface EngagementRow {
  id: string;
  prospectId: string | null;
  state: string;
  paymentState: string;
  verificationSource: string | null;
  totalPrice: number;
  currency: string;
  verifiedAt: Date | null;
}

// ---------------------------------------------------------------------------
// The delegate seam
// ---------------------------------------------------------------------------

/**
 * The subset of the Prisma client this module uses.
 *
 * It is expressed structurally (plain records) rather than as a generated
 * Prisma type so the module compiles and is tested without applying either
 * proposal. A real client satisfies it: `updateMany` returns `{ count }`,
 * `findFirst` returns the row or null, `upsert` takes a `where`, a `create`
 * and an `update`.
 */
export interface DeliveryTx {
  deliveryEntitlement: {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeliveryEntitlementRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<DeliveryEntitlementRow>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  deliveryEntitlementAsset: {
    findMany(args: { where: Record<string, unknown> }): Promise<DeliveryEntitlementAssetRow[]>;
    create(args: { data: Record<string, unknown> }): Promise<DeliveryEntitlementAssetRow>;
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryEntitlementAssetRow>;
  };
  deliveryTicket: {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeliveryTicketRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<DeliveryTicketRow>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  deliveryTicketAsset: {
    findMany(args: { where: Record<string, unknown> }): Promise<DeliveryTicketAssetRow[]>;
    create(args: { data: Record<string, unknown> }): Promise<DeliveryTicketAssetRow>;
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryTicketAssetRow>;
  };
  deliveryRecord: {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeliveryRecordRow | null>;
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryRecordRow>;
  };
  deliveryTicketEvent: {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeliveryTicketEventRow | null>;
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeliveryTicketEventRow>;
  };
  /** The adverse-intake hold table. Read-only from here. */
  adverseHold: {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeliveryHoldRow | null>;
  };
  /** The active schema's payment ledger. */
  paymentEvent: {
    findMany(args: { where: Record<string, unknown> }): Promise<PaymentEventRow[]>;
  };
  /** The active schema's paid order. */
  serviceEngagement: {
    findFirst(args: { where: Record<string, unknown> }): Promise<EngagementRow | null>;
  };
}

export interface DeliveryDb extends DeliveryTx {
  $transaction<T>(fn: (tx: DeliveryTx) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Internal errors
// ---------------------------------------------------------------------------

/** The entitlement exists but is not in a state that may be (re)granted. */
class EntitlementNotGrantableError extends Error {
  constructor() {
    super('The entitlement already exists and is not granted.');
    this.name = 'EntitlementNotGrantableError';
  }
}

/** The entitlement does not exist. */
class EntitlementNotFoundError extends Error {
  constructor() {
    super('No such entitlement.');
    this.name = 'EntitlementNotFoundError';
  }
}

/** The ticket exists but is not in a state that may be replaced. */
class TicketNotReplaceableError extends Error {
  constructor() {
    super('The ticket already exists in a state that cannot be replaced.');
    this.name = 'TicketNotReplaceableError';
  }
}

const MAX_REASON_LENGTH = 300;

function boundText(value: string, max = MAX_REASON_LENGTH): string {
  return value.slice(0, max);
}

// ---------------------------------------------------------------------------
// Row <-> record mapping
// ---------------------------------------------------------------------------

function toEntitlementAsset(row: DeliveryEntitlementAssetRow): DeliveryAsset {
  return {
    assetId: row.assetId,
    kind: row.kind,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    label: row.label,
  };
}

/**
 * The pinned asset of a ticket.
 *
 * The ticket's asset row carries the same promise fields as the
 * entitlement's: the asset id, the kind, and — the part that matters — the
 * content digest the ticket is pinned to.
 */
function toTicketAsset(row: DeliveryTicketAssetRow): DeliveryAsset {
  return {
    assetId: row.assetId,
    kind: row.kind,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    label: row.label,
  };
}

function toEntitlementRecord(
  row: DeliveryEntitlementRow,
  assets: DeliveryEntitlementAssetRow[],
): EntitlementRecord {
  return {
    entitlementId: row.id,
    orderId: row.orderId,
    buyerId: row.buyerId,
    productVersionId: row.productVersionId,
    packageId: row.packageId,
    assets: assets.map(toEntitlementAsset),
    assetReviewState: row.assetReviewState,
    state: row.state,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revocationReason: row.revocationReason ?? '',
  };
}

function toTicketRecord(row: DeliveryTicketRow, assets: DeliveryTicketAssetRow[]): TicketRecord {
  return {
    ticketId: row.id,
    tokenFingerprint: row.tokenFingerprint,
    entitlementId: row.entitlementId,
    orderId: row.orderId,
    buyerId: row.buyerId,
    productVersionId: row.productVersionId,
    packageId: row.packageId,
    assets: assets.map(toTicketAsset),
    state: row.state,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
    consumedByDeliveryId: row.consumedByDeliveryId,
  };
}

function toDeliveryRecord(row: DeliveryRecordRow): DeliveryRecord {
  return {
    deliveryId: row.deliveryId,
    ticketId: row.ticketId,
    entitlementId: row.entitlementId,
    orderId: row.orderId,
    buyerId: row.buyerId,
    outcome: row.outcome,
    assetIds: [...row.assetIds],
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The payment-evidence rule
// ---------------------------------------------------------------------------

/**
 * A payment event counts as evidence only when it was ACCEPTED, carries a
 * positive amount and names a recognized verification method.
 *
 * - `outcome` must be RECORDED. A REJECTED, DUPLICATE, REVERSED or IGNORED
 *   event is not a payment.
 * - A provider method additionally requires a verified signature. A manual
 *   approval does not have a signature: it has a reviewed human decision, so
 *   its `signatureVerified` is false by design and the method alone carries
 *   it.
 */
function isVerifiedPaymentEvent(event: PaymentEventRow): boolean {
  if (event.outcome !== 'RECORDED') return false;
  if (!(event.amountUsd > 0)) return false;
  if (event.verificationMethod === 'MANUAL_ADMIN_APPROVED') return true;
  if (!event.signatureVerified) return false;
  return (
    event.verificationMethod === 'PROVIDER_WEBHOOK' || event.verificationMethod === 'PROVIDER_API'
  );
}

function isPaymentVerificationSource(value: string): value is PaymentVerificationSource {
  return (
    value === 'PROVIDER_WEBHOOK' || value === 'PROVIDER_API' || value === 'MANUAL_ADMIN_APPROVED'
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The durable store for private delivery.
 *
 * It implements `DeliveryStorePort`, so the rules in ./private-delivery.ts
 * are unchanged by the presence of a real database.
 */
export class DurableDeliveryStore implements DeliveryStorePort {
  private readonly db: DeliveryDb;

  constructor(db: DeliveryDb) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // Payment
  // -------------------------------------------------------------------------

  /**
   * The evidence-backed payment for an order, or null when there is none.
   *
   * Three things must hold before an order counts as paid:
   *   1. the order exists;
   *   2. the order carries a server-derived buyer identity (its prospect);
   *   3. the order is in the paid posture the governed state machine set
   *      (`paymentState === 'PAYMENT_VERIFIED'`), and a payment event exists
   *      that was accepted, positive and signed (or manually reviewed).
   *
   * A missing payment means "not paid", never "assume paid". A REFUNDED or
   * otherwise unpaid posture is refused here, and a refund that arrives
   * LATER is stopped by the access hold, not by this read.
   */
  async findVerifiedPayment(orderId: string): Promise<VerifiedPayment | null> {
    const engagement = await this.db.serviceEngagement.findFirst({ where: { id: orderId } });
    if (!engagement) return null;
    if (!engagement.prospectId) return null;
    if (engagement.paymentState !== 'PAYMENT_VERIFIED') return null;

    const events = await this.db.paymentEvent.findMany({ where: { engagementId: orderId } });
    const verified = events
      .filter(isVerifiedPaymentEvent)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];
    if (!verified) return null;
    if (!isPaymentVerificationSource(verified.verificationMethod)) return null;

    return {
      orderId,
      providerEventId: verified.providerEventId,
      buyerId: engagement.prospectId,
      amountUsd: verified.amountUsd,
      currency: verified.currency,
      verificationSource: verified.verificationMethod,
      verifiedAt: (verified.processedAt ?? verified.receivedAt).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Entitlement
  // -------------------------------------------------------------------------

  async findEntitlement(entitlementId: string): Promise<EntitlementRecord | null> {
    const row = await this.db.deliveryEntitlement.findFirst({ where: { id: entitlementId } });
    if (!row) return null;
    const assets = await this.db.deliveryEntitlementAsset.findMany({ where: { entitlementId } });
    return toEntitlementRecord(row, assets);
  }

  async findEntitlementByOrder(orderId: string, buyerId: string): Promise<EntitlementRecord | null> {
    const row = await this.db.deliveryEntitlement.findFirst({ where: { orderId, buyerId } });
    if (!row) return null;
    const assets = await this.db.deliveryEntitlementAsset.findMany({
      where: { entitlementId: row.id },
    });
    return toEntitlementRecord(row, assets);
  }

  /**
   * The active access hold on an order, or null.
   *
   * This method does NOT catch its errors on purpose: a store that cannot
   * answer must throw so the caller fails closed. A hold blocks a delivery;
   * answering "no hold" when the store simply does not know would hand over
   * private assets that a chargeback has already invalidated.
   */
  async findAccessHold(orderId: string): Promise<AccessHold | null> {
    const row = await this.db.adverseHold.findFirst({ where: { orderId, state: 'ACTIVE' } });
    if (!row) return null;
    return {
      orderId: row.orderId,
      reason: row.reason,
      sourceEventId: row.sourceEventId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Store the entitlement and its pinned assets. Idempotent on the
   * deterministic entitlement id.
   *
   * An entitlement that already exists in a state other than GRANTED is NOT
   * replaced: reviving a revoked entitlement would hand back access that was
   * deliberately withdrawn. The refusal makes the caller re-read the real
   * record instead of believing the one it built.
   */
  async saveEntitlement(record: EntitlementRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.db.$transaction(async (tx) => {
        const existing = await tx.deliveryEntitlement.findFirst({
          where: { id: record.entitlementId },
        });
        if (existing) {
          if (existing.state !== 'GRANTED') throw new EntitlementNotGrantableError();
          // Already granted: keep the pinned assets in step, change nothing
          // else. The promise is never silently rewritten.
          for (const asset of record.assets) {
            await tx.deliveryEntitlementAsset.upsert({
              where: {
                entitlementId_assetId: {
                  entitlementId: record.entitlementId,
                  assetId: asset.assetId,
                },
              },
              create: {
                entitlementId: record.entitlementId,
                assetId: asset.assetId,
                kind: asset.kind,
                contentHash: asset.contentHash,
                sizeBytes: asset.sizeBytes,
                label: asset.label,
                createdAt: new Date(record.issuedAt),
              },
              update: {
                kind: asset.kind,
                contentHash: asset.contentHash,
                sizeBytes: asset.sizeBytes,
                label: asset.label,
              },
            });
          }
          return;
        }

        await tx.deliveryEntitlement.create({
          data: {
            id: record.entitlementId,
            orderId: record.orderId,
            buyerId: record.buyerId,
            productVersionId: record.productVersionId,
            packageId: record.packageId,
            assetReviewState: record.assetReviewState,
            state: record.state,
            issuedAt: new Date(record.issuedAt),
            expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
            revokedAt: null,
            revocationReason: null,
            createdAt: new Date(record.issuedAt),
            updatedAt: new Date(record.issuedAt),
          },
        });
        for (const asset of record.assets) {
          await tx.deliveryEntitlementAsset.create({
            data: {
              entitlementId: record.entitlementId,
              assetId: asset.assetId,
              kind: asset.kind,
              contentHash: asset.contentHash,
              sizeBytes: asset.sizeBytes,
              label: asset.label,
              createdAt: new Date(record.issuedAt),
            },
          });
        }
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof EntitlementNotGrantableError) {
        return { ok: false, reason: 'The entitlement already exists and is not granted.' };
      }
      // A concurrent grant may have won the race on the same deterministic
      // id: the unique constraint collapsed it. Re-read and report the truth.
      const existing = await this.safeFindEntitlement(record.entitlementId);
      if (existing) {
        return existing.state === 'GRANTED'
          ? { ok: true }
          : { ok: false, reason: 'The entitlement already exists and is not granted.' };
      }
      return { ok: false, reason: 'The entitlement could not be stored.' };
    }
  }

  /**
   * Revoke an entitlement, and the tickets that were issued from it.
   *
   * Both writes are in ONE transaction, and the tickets die with the
   * entitlement: defence in depth. The redemption re-checks the entitlement
   * state, but a ticket that is dead in its own right cannot be spent even
   * if that check is ever bypassed.
   */
  async revokeEntitlement(
    entitlementId: string,
    reason: string,
    at: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.db.$transaction(async (tx) => {
        const existing = await tx.deliveryEntitlement.findFirst({ where: { id: entitlementId } });
        if (!existing) throw new EntitlementNotFoundError();

        const revokedAt = new Date(at);
        const boundedReason = boundText(reason);

        await tx.deliveryEntitlement.updateMany({
          where: { id: entitlementId },
          data: {
            state: 'REVOKED',
            revokedAt,
            revocationReason: boundedReason,
          },
        });
        await tx.deliveryTicket.updateMany({
          where: { entitlementId, state: 'ISSUED' },
          data: {
            state: 'REVOKED',
            revokedAt,
            revocationReason: boundedReason,
          },
        });
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof EntitlementNotFoundError) return { ok: false, reason: 'not-found' };
      return { ok: false, reason: 'The entitlement could not be revoked.' };
    }
  }

  // -------------------------------------------------------------------------
  // Ticket
  // -------------------------------------------------------------------------

  async findTicket(ticketId: string): Promise<TicketRecord | null> {
    const row = await this.db.deliveryTicket.findFirst({ where: { id: ticketId } });
    if (!row) return null;
    const assets = await this.db.deliveryTicketAsset.findMany({ where: { ticketId } });
    return toTicketRecord(row, assets);
  }

  async findTicketByFingerprint(tokenFingerprint: string): Promise<TicketRecord | null> {
    const row = await this.db.deliveryTicket.findFirst({ where: { tokenFingerprint } });
    if (!row) return null;
    const assets = await this.db.deliveryTicketAsset.findMany({ where: { ticketId: row.id } });
    return toTicketRecord(row, assets);
  }

  /**
   * Store the ticket and the assets it pins. Idempotent on the ticket id.
   *
   * A ticket that already exists in a state other than ISSUED is NOT
   * replaced. Re-saving an ISSUED ticket is a no-op; re-saving a CONSUMED,
   * EXPIRED or REVOKED ticket would resurrect a spent promise.
   */
  async saveTicket(record: TicketRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.db.$transaction(async (tx) => {
        const existing = await tx.deliveryTicket.findFirst({ where: { id: record.ticketId } });
        if (existing) {
          if (existing.state !== 'ISSUED') throw new TicketNotReplaceableError();
          return;
        }

        await tx.deliveryTicket.create({
          data: {
            id: record.ticketId,
            tokenFingerprint: record.tokenFingerprint,
            entitlementId: record.entitlementId,
            orderId: record.orderId,
            buyerId: record.buyerId,
            productVersionId: record.productVersionId,
            packageId: record.packageId,
            state: record.state,
            issuedAt: new Date(record.issuedAt),
            expiresAt: new Date(record.expiresAt),
            consumedAt: null,
            consumedByDeliveryId: null,
            revokedAt: null,
            revocationReason: null,
            createdAt: new Date(record.issuedAt),
            updatedAt: new Date(record.issuedAt),
          },
        });
        for (const asset of record.assets) {
          await tx.deliveryTicketAsset.upsert({
            where: {
              ticketId_assetId: { ticketId: record.ticketId, assetId: asset.assetId },
            },
            create: {
              ticketId: record.ticketId,
              assetId: asset.assetId,
              kind: asset.kind,
              contentHash: asset.contentHash,
              sizeBytes: asset.sizeBytes,
              label: asset.label,
              createdAt: new Date(record.issuedAt),
            },
            update: {
              kind: asset.kind,
              contentHash: asset.contentHash,
              sizeBytes: asset.sizeBytes,
              label: asset.label,
            },
          });
        }
        await this.recordEvent(tx, {
          ticketId: record.ticketId,
          kind: 'ISSUED',
          reference: record.entitlementId,
          detail: 'Ticket issued.',
          at: record.issuedAt,
        });
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof TicketNotReplaceableError) {
        return { ok: false, reason: 'The ticket already exists and cannot be replaced.' };
      }
      return { ok: false, reason: 'The ticket could not be stored.' };
    }
  }

  /**
   * Mark an issued ticket as expired, and record the expiry in the audit
   * ledger. Best effort and idempotent: only an ISSUED ticket moves, so an
   * expired write can never resurrect a spent ticket, and a ticket that was
   * already consumed is left exactly as it is.
   */
  async expireTicket(ticketId: string, at: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.db.$transaction(async (tx) => {
        const expired = await tx.deliveryTicket.updateMany({
          where: { id: ticketId, state: 'ISSUED' },
          data: { state: 'EXPIRED' },
        });
        if (expired.count === 0) return;
        await this.recordEvent(tx, {
          ticketId,
          kind: 'EXPIRED',
          reference: at,
          detail: 'Ticket expired.',
          at,
        });
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'The ticket could not be expired.' };
    }
  }

  /**
   * THE ATOMIC SINGLE-USE TRANSITION.
   *
   * One conditional update decides the outcome. The rows that match are the
   * rows that were still ISSUED, still carried this fingerprint, and still
   * belonged to this buyer. Everything after the update is classification.
   */
  async consumeTicket(input: {
    ticketId: string;
    tokenFingerprint: string;
    buyerId: string;
    deliveryId: string;
    at: string;
  }): Promise<ConsumeOutcome> {
    try {
      return await this.db.$transaction(async (tx) => {
        const claimed = await tx.deliveryTicket.updateMany({
          where: {
            id: input.ticketId,
            state: 'ISSUED',
            tokenFingerprint: input.tokenFingerprint,
            buyerId: input.buyerId,
          },
          data: {
            state: 'CONSUMED',
            consumedAt: new Date(input.at),
            consumedByDeliveryId: input.deliveryId,
          },
        });

        if (claimed.count === 1) {
          await this.recordEvent(tx, {
            ticketId: input.ticketId,
            kind: 'CONSUMED',
            reference: input.deliveryId,
            detail: 'Ticket consumed.',
            at: input.at,
          });
          return 'CONSUMED';
        }

        // The compare-and-set matched no row. Read the row to say WHY. This
        // read does not decide anything: the decision was the update.
        const current = await tx.deliveryTicket.findFirst({ where: { id: input.ticketId } });
        if (!current) return 'NOT_FOUND';
        if (current.tokenFingerprint !== input.tokenFingerprint) return 'NOT_FOUND';
        if (current.buyerId !== input.buyerId) return 'CONFLICT';
        if (current.state === 'CONSUMED') {
          return current.consumedByDeliveryId === input.deliveryId
            ? 'ALREADY_CONSUMED'
            : 'CONFLICT';
        }
        if (current.state !== 'ISSUED') return 'CONFLICT';

        // The row still looks consumable, so the outcome cannot be
        // determined. Report it as unknown so the caller reconciles instead
        // of declaring a failure it cannot prove.
        return 'STORE_UNAVAILABLE';
      });
    } catch {
      // The commit outcome is unknown: it may or may not have landed. The
      // caller records PENDING and reconciles with the same delivery id.
      return 'STORE_UNAVAILABLE';
    }
  }

  // -------------------------------------------------------------------------
  // Delivery record
  // -------------------------------------------------------------------------

  async findDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
    const row = await this.db.deliveryRecord.findFirst({ where: { deliveryId } });
    return row ? toDeliveryRecord(row) : null;
  }

  /**
   * Record the delivery. Idempotent on the deterministic delivery id, so a
   * retry of the same (ticket, buyer) converges on one row: the first write
   * creates it, later writes update it.
   */
  async saveDelivery(record: DeliveryRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.db.deliveryRecord.upsert({
        where: { deliveryId: record.deliveryId },
        create: {
          deliveryId: record.deliveryId,
          ticketId: record.ticketId,
          entitlementId: record.entitlementId,
          orderId: record.orderId,
          buyerId: record.buyerId,
          outcome: record.outcome,
          assetIds: [...record.assetIds],
          reason: record.reason,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
        },
        update: {
          outcome: record.outcome,
          assetIds: [...record.assetIds],
          reason: record.reason,
          updatedAt: new Date(record.updatedAt),
        },
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'The delivery could not be recorded.' };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async safeFindEntitlement(entitlementId: string): Promise<DeliveryEntitlementRow | null> {
    try {
      return await this.db.deliveryEntitlement.findFirst({ where: { id: entitlementId } });
    } catch {
      return null;
    }
  }

  /**
   * Append one audit event. The ledger is unique per (ticket, kind,
   * reference), so the write is an upsert: a retry cannot duplicate it, and
   * a duplicate cannot abort the transaction that carried the real effect.
   */
  private async recordEvent(
    tx: DeliveryTx,
    input: { ticketId: string; kind: string; reference: string; detail: string; at: string },
  ): Promise<void> {
    await tx.deliveryTicketEvent.upsert({
      where: {
        ticketId_kind_reference: {
          ticketId: input.ticketId,
          kind: input.kind,
          reference: input.reference,
        },
      },
      create: {
        ticketId: input.ticketId,
        kind: input.kind,
        reference: input.reference,
        detail: boundText(input.detail),
        createdAt: new Date(input.at),
      },
      update: {},
    });
  }
}
