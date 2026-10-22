// ============================================================================
// PRIVATE DELIVERY — PORTS (interfaces only)
// ============================================================================
// The private-delivery boundary is deliberately split in three:
//
//   ports.ts             — the interfaces every side of the boundary implements
//   private-delivery.ts  — the rules (pure decision logic, no I/O of its own)
//   offline-fakes.ts     — in-memory implementations used by tests and local dev
//
// WHY THE SPLIT
// -------------
// A buyer must only ever receive what they paid for, and only that buyer.
// Those two properties cannot be proven by "we validated the request" — they
// have to be enforced where the durable facts live:
//
//   1. ENTITLEMENT is derived from an EVIDENCE-BACKED PAYMENT (the existing
//      PaymentEvent ledger), never from a client-supplied price, payload or
//      claim. A client assertion is not a source.
//   2. ENTITLEMENT is bound to ONE buyer id. Every later step re-checks that
//      binding, so a substituted buyer id can never redeem another buyer's
//      ticket.
//   3. The DELIVERED ASSET BYTES are pinned by CONTENT HASH at issue time and
//      re-verified against the private storage before a handle is handed out.
//      A swapped file is refused, not delivered.
//   4. The TICKET is SINGLE USE. Consumption is an atomic compare-and-set in
//      the durable store; a second buyer can never consume the same ticket.
//   5. NO PUBLIC URL is ever produced. The storage port returns a short-lived
//      private handle for a buyer-scoped read, and the handle is never persisted.
//
// UNKNOWN-COMMIT CONTRACT
// -----------------------
// Every durable write here can end in three states, never two: COMMITTED,
// NOT COMMITTED, or UNKNOWN (the write may or may not have landed). An
// UNKNOWN outcome is reported as PENDING — never as DELIVERED — and is
// reconciled by retrying with the SAME deterministic delivery id. Retrying is
// safe because the delivery id is derived from (ticket, buyer) and the store's
// consumption step is idempotent for that id.
//
// This file contains NO provider code, NO database code and NO network code.
// ============================================================================

/** The user-visible delivery statuses. Exactly these seven, nothing else. */
export const DELIVERY_STATUSES = [
  'DRAFT',
  'REVIEW_READY',
  'UNAVAILABLE',
  'PENDING',
  'FAILED',
  'REVOKED',
  'DELIVERED',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(value);
}

/** Payment truth sources. A client claim is NOT one of them. */
export const PAYMENT_VERIFICATION_SOURCES = [
  'PROVIDER_WEBHOOK',
  'PROVIDER_API',
  'MANUAL_ADMIN_APPROVED',
] as const;

export type PaymentVerificationSource = (typeof PAYMENT_VERIFICATION_SOURCES)[number];

/**
 * One evidence-backed payment for one order.
 *
 * The durable store is the only thing allowed to produce this record: it is
 * read from the existing payment ledger, never assembled from request data.
 */
export interface VerifiedPayment {
  /** The paid order (an engagement / order id in the existing model). */
  orderId: string;
  /** Provider-scoped event id — the replay guard. */
  providerEventId: string;
  /** The server-derived buyer identity that owns the order. */
  buyerId: string;
  amountUsd: number;
  currency: string;
  verificationSource: PaymentVerificationSource;
  /** ISO timestamp of the verification. */
  verifiedAt: string;
}

export const DELIVERY_ASSET_KINDS = ['PRODUCT_PACKAGE', 'DELIVERABLE_FILE', 'DOCUMENT', 'ARCHIVE'] as const;

export type DeliveryAssetKind = (typeof DELIVERY_ASSET_KINDS)[number];

/**
 * One private asset the buyer is entitled to receive.
 *
 * `contentHash` is the PIN: the sha256 of the bytes, captured when the
 * entitlement is granted and re-verified against the private storage before
 * any handle is handed out.
 */
export interface DeliveryAsset {
  assetId: string;
  kind: DeliveryAssetKind;
  /** Lowercase sha256 hex of the asset bytes (64 hex characters). */
  contentHash: string;
  sizeBytes: number;
  /** Human-safe label. Never a path, never a credential. */
  label: string;
}

export type EntitlementState = 'PENDING' | 'GRANTED' | 'REVOKED' | 'EXPIRED';

/** Whether the assets of an entitlement are final enough to release. */
export type AssetReviewState = 'DRAFT' | 'REVIEW_READY';

/** The durable record: "this buyer paid for this order and owns these assets". */
export interface EntitlementRecord {
  entitlementId: string;
  orderId: string;
  buyerId: string;
  productVersionId: string;
  /**
   * The product package this entitlement is bound to, when the product has
   * one. Null for a product that is not a package. Never mutated once
   * granted: it is part of the promise the ticket repeats.
   */
  packageId: string | null;
  assets: DeliveryAsset[];
  assetReviewState: AssetReviewState;
  state: EntitlementState;
  issuedAt: string;
  /** ISO expiry, or null for an entitlement that does not expire. */
  expiresAt: string | null;
  /** Bounded reason. Never secrets, never buyer content. */
  revocationReason: string;
}

export type TicketState = 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

/**
 * A durable block on access for one order.
 *
 * Produced by the adverse-intake pipeline when a refund, chargeback,
 * cancellation or dispute is reported. A hold means: do not hand over the
 * private assets, even when the buyer holds a valid, unspent ticket. The
 * check is fail-closed — a store that cannot answer "is this order held?"
 * must be treated as "held", never as "not held".
 */
export interface AccessHold {
  orderId: string;
  /** Bounded reason, e.g. CHARGEBACK_CREATED. Never buyer content. */
  reason: string;
  /** The provider event that caused the hold. */
  sourceEventId: string;
  /** ISO timestamp of the hold. */
  createdAt: string;
}

/**
 * The durable record of a single-use delivery ticket.
 *
 * The raw token is NEVER stored: only its fingerprint (a keyed HMAC) is, so a
 * database dump cannot be replayed into a download.
 */
export interface TicketRecord {
  ticketId: string;
  /** Keyed fingerprint of the raw token. The raw token is returned once. */
  tokenFingerprint: string;
  entitlementId: string;
  /** The order the ticket was issued for. Never mutated. */
  orderId: string;
  buyerId: string;
  /** The product version the ticket is bound to. Never mutated. */
  productVersionId: string;
  /**
   * The product package this ticket is bound to, when there is one.
   * Never mutated: the ticket says which package was sold.
   */
  packageId: string | null;
  /** The assets with their pinned content hashes. */
  assets: DeliveryAsset[];
  state: TicketState;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  /** The delivery id that consumed the ticket (the single-use marker). */
  consumedByDeliveryId: string | null;
}

export type DeliveryOutcome = 'PENDING' | 'DELIVERED' | 'FAILED';

/** The durable record of one delivery attempt. */
export interface DeliveryRecord {
  deliveryId: string;
  ticketId: string;
  entitlementId: string;
  /** The order the delivery belongs to. Never a client-supplied value. */
  orderId: string;
  buyerId: string;
  outcome: DeliveryOutcome;
  assetIds: string[];
  /** Bounded, human-safe reason. Never secrets. */
  reason: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Result of the atomic ticket consumption.
 *
 * - CONSUMED          — this call performed the ISSUED → CONSUMED transition.
 * - ALREADY_CONSUMED  — the ticket was consumed by the SAME delivery id;
 *                       this is an idempotent retry, not a second use.
 * - CONFLICT          — the ticket was consumed by a DIFFERENT delivery id.
 * - NOT_FOUND         — no such ticket.
 * - STORE_UNAVAILABLE — the outcome is UNKNOWN; reconciliation is required.
 */
export type ConsumeOutcome = 'CONSUMED' | 'ALREADY_CONSUMED' | 'CONFLICT' | 'NOT_FOUND' | 'STORE_UNAVAILABLE';

/** Why a private read could not be served. */
export type PrivateStorageFailure = 'DENIED' | 'UNAVAILABLE' | 'UNKNOWN';

/** A short-lived, buyer-scoped handle for one private asset. Never a URL. */
export interface PrivateAssetHandle {
  assetId: string;
  contentHash: string;
  sizeBytes: number;
  label: string;
  /** Opaque, non-guessable, short-lived reference for a buyer-scoped read. */
  handle: string;
  expiresAt: string;
}

/**
 * The durable store for entitlements, tickets and deliveries.
 *
 * Implementations MUST make `consumeTicket` atomic: exactly one
 * (ticket, deliveryId) pair may transition ISSUED → CONSUMED, and the
 * comparison and the write must not be separated by an await.
 */
export interface DeliveryStorePort {
  /** The evidence-backed payment for an order, or null when there is none. */
  findVerifiedPayment(orderId: string): Promise<VerifiedPayment | null>;

  findEntitlement(entitlementId: string): Promise<EntitlementRecord | null>;

  /** The entitlement for one order and buyer, or null. */
  findEntitlementByOrder(orderId: string, buyerId: string): Promise<EntitlementRecord | null>;

  /**
   * The active access hold on an order, or null when there is none.
   *
   * A refund, chargeback, cancellation or dispute places a hold; a held
   * order must not deliver. A store that cannot answer must throw, so the
   * caller can fail closed instead of assuming "not held".
   */
  findAccessHold(orderId: string): Promise<AccessHold | null>;

  /** Must be idempotent on `entitlementId`. */
  saveEntitlement(record: EntitlementRecord): Promise<{ ok: true } | { ok: false; reason: string }>;

  revokeEntitlement(
    entitlementId: string,
    reason: string,
    at: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;

  findTicket(ticketId: string): Promise<TicketRecord | null>;

  /** Lookup by the token fingerprint — the raw token is never stored. */
  findTicketByFingerprint(tokenFingerprint: string): Promise<TicketRecord | null>;

  /** Must be idempotent on `ticketId`. */
  saveTicket(record: TicketRecord): Promise<{ ok: true } | { ok: false; reason: string }>;

  /** Mark an issued ticket as expired (best effort, idempotent). */
  expireTicket(ticketId: string, at: string): Promise<{ ok: true } | { ok: false; reason: string }>;

  /** The atomic single-use consumption. See `ConsumeOutcome`. */
  consumeTicket(input: {
    ticketId: string;
    tokenFingerprint: string;
    buyerId: string;
    deliveryId: string;
    at: string;
  }): Promise<ConsumeOutcome>;

  findDelivery(deliveryId: string): Promise<DeliveryRecord | null>;

  /** Must be idempotent on `deliveryId`. */
  saveDelivery(record: DeliveryRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * The private asset store.
 *
 * A real implementation must be private (authenticated, per-buyer, short-lived
 * reads) — a public URL is never an acceptable result of this port.
 */
export interface PrivateStoragePort {
  /** The content hash the storage provider currently sees for the asset. */
  verifyContentHash(asset: DeliveryAsset): Promise<
    { ok: true; contentHash: string } | { ok: false; reason: string; failure: PrivateStorageFailure }
  >;

  /** Open a buyer-scoped, short-lived handle for the asset. */
  openForBuyer(input: {
    asset: DeliveryAsset;
    buyerId: string;
    entitlementId: string;
    deliveryId: string;
  }): Promise<
    { ok: true; handle: PrivateAssetHandle } | { ok: false; reason: string; failure: PrivateStorageFailure }
  >;
}

/**
 * Ticket token signing.
 *
 * `fingerprint` must be a KEYED derivation (HMAC with a server-side secret):
 * a plain hash of a random token would be replayable from a database dump.
 */
export interface TicketSignerPort {
  fingerprint(token: string): string;
}
