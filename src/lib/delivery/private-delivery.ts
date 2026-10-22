// ============================================================================
// PRIVATE DELIVERY — RULES
// ============================================================================
// The decision logic for delivering a paid, private asset to exactly one
// buyer. No database, no network, no provider: every side effect goes through
// the ports in ./ports, so the whole rule set is testable offline.
//
// THE CHAIN (each step fails closed; none is skippable from the outside)
// -----------------------------------------------------------------------
//   1. ENTITLEMENT   — derived from an evidence-backed payment, bound to one
//                       buyer, pinned to the content hashes of the assets
//   2. TICKET        — single-use, buyer-bound, short-lived; the raw token is
//                       returned once and never stored (only its fingerprint)
//   3. REDEEM        — buyer re-checked, hashes re-verified against the
//                       private storage, then ONE atomic consumption
//   4. RECORD        — the delivery is recorded durably before it is reported
//
// HONEST OUTCOMES
// ----------------
//   DELIVERED  — the assets were handed over and the fact is durably recorded
//   PENDING     — the outcome is UNKNOWN (the commit may or may not have
//                 landed) or the private storage is not reachable; the buyer
//                 is told "pending", never "delivered"
//   FAILED      — the attempt was refused (wrong buyer, tampered asset, spent
//                 ticket, unknown ticket)
//   UNAVAILABLE — private storage is not configured or not serving
//
// The user-visible status of a delivery over time is computed by
// `deliveryStatus()`, which reads the durable records only.
// ============================================================================

import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@/lib/product-factory/canonical';
import {
  DELIVERY_ASSET_KINDS,
  PAYMENT_VERIFICATION_SOURCES,
  type AccessHold,
  type DeliveryAsset,
  type DeliveryRecord,
  type DeliveryStatus,
  type DeliveryStorePort,
  type EntitlementRecord,
  type PaymentVerificationSource,
  type PrivateStoragePort,
  type TicketRecord,
  type TicketSignerPort,
} from './ports';

const MAX_ID = 128;
const MAX_LABEL = 200;
const MAX_REASON = 300;
const DEFAULT_TICKET_TTL_SECONDS = 900;
const MIN_TICKET_TTL_SECONDS = 60;
const MAX_TICKET_TTL_SECONDS = 86_400;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface DeliveryDeps {
  /** The durable store. */
  store: DeliveryStorePort;
  /**
   * The private asset store. `null` means private delivery is NOT configured:
   * every delivery attempt then fails closed with UNAVAILABLE instead of
   * handing out a public URL.
   */
  storage: PrivateStoragePort | null;
  /** The keyed token deriver. */
  signer: TicketSignerPort;
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

export function isValidDeliveryAsset(value: unknown): value is DeliveryAsset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  if (!isBoundedId(asset.assetId)) return false;
  if (typeof asset.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(asset.contentHash)) return false;
  if (typeof asset.sizeBytes !== 'number' || !Number.isFinite(asset.sizeBytes) || asset.sizeBytes < 0) return false;
  if (!isBoundedText(asset.label, MAX_LABEL)) return false;
  return (DELIVERY_ASSET_KINDS as readonly string[]).includes(asset.kind as string);
}

function isPaymentVerificationSource(value: unknown): value is PaymentVerificationSource {
  return typeof value === 'string' && (PAYMENT_VERIFICATION_SOURCES as readonly string[]).includes(value);
}

/** Read from the store; a throwing store is an UNKNOWN outcome, never a "not found". */
async function readFromStore<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

function boundReason(reason: string): string {
  return reason.slice(0, MAX_REASON);
}

/**
 * The active access hold on an order, if any.
 *
 * `null` means "no hold". A store that cannot answer returns `ok: false` —
 * which is NOT the same as "no hold": the caller must fail closed, because
 * the whole point of the hold is to stop a delivery that would otherwise
 * succeed.
 */
async function readAccessHold(
  deps: DeliveryDeps,
  orderId: string,
): Promise<{ ok: true; hold: AccessHold | null } | { ok: false }> {
  try {
    return { ok: true, hold: await deps.store.findAccessHold(orderId) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// 1. ENTITLEMENT
// ---------------------------------------------------------------------------

export type EntitlementRefusalCode =
  | 'INVALID_REQUEST'
  | 'PAYMENT_NOT_VERIFIED'
  | 'BUYER_MISMATCH'
  | 'ASSET_INVALID'
  | 'NO_ASSETS'
  | 'ACCESS_HELD'
  | 'STORE_UNAVAILABLE';

export interface EntitlementRequest {
  orderId: string;
  /** The server-derived buyer identity. Never a client-supplied value. */
  buyerId: string;
  productVersionId: string;
  /**
   * The product package this entitlement is bound to, when the product has
   * one. It is part of the promise: the ticket repeats it and the redemption
   * re-checks it against the entitlement.
   */
  packageId?: string | null;
  assets: DeliveryAsset[];
  assetReviewState?: 'DRAFT' | 'REVIEW_READY';
  now: Date;
}

export type EntitlementResult =
  | { ok: true; entitlement: EntitlementRecord; created: boolean }
  | { ok: false; code: EntitlementRefusalCode; reason: string; status: DeliveryStatus };

/** Deterministic entitlement id: the same order + buyer + version is one entitlement. */
export function entitlementIdFor(orderId: string, buyerId: string, productVersionId: string): string {
  return `ent_${sha256Hex(`${orderId}|${buyerId}|${productVersionId}`).slice(0, 24)}`;
}

/**
 * Derive (or re-derive) the entitlement for a paid order.
 *
 * The payment is read from the durable ledger, so a client can never grant
 * itself an entitlement by quoting a price or claiming a payment. A buyer id
 * that does not own the order is refused without disclosing whose it is.
 */
export async function evaluateEntitlement(
  request: EntitlementRequest,
  deps: DeliveryDeps,
): Promise<EntitlementResult> {
  const { orderId, buyerId, productVersionId, assets, now } = request;

  if (!isBoundedId(orderId) || !isBoundedId(buyerId) || !isBoundedId(productVersionId)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      reason: 'orderId, buyerId and productVersionId are required.',
      status: 'DRAFT',
    };
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    return {
      ok: false,
      code: 'NO_ASSETS',
      reason: 'An entitlement needs at least one asset to deliver.',
      status: 'DRAFT',
    };
  }
  for (const asset of assets) {
    if (!isValidDeliveryAsset(asset)) {
      return {
        ok: false,
        code: 'ASSET_INVALID',
        reason: 'Every delivered asset needs a stable id and a sha256 content hash.',
        status: 'DRAFT',
      };
    }
  }

  // An entitlement already granted for this order+buyer is returned as-is:
  // granting twice would create a second, divergent entitlement.
  const existing = await readFromStore(() => deps.store.findEntitlementByOrder(orderId, buyerId));
  if (!existing.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement store could not be read. Try again shortly.',
      status: 'PENDING',
    };
  }
  if (existing.value) {
    return { ok: true, entitlement: existing.value, created: false };
  }

  const payment = await readFromStore(() => deps.store.findVerifiedPayment(orderId));
  if (!payment.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The payment ledger could not be read. Try again shortly.',
      status: 'PENDING',
    };
  }
  if (!payment.value) {
    return {
      ok: false,
      code: 'PAYMENT_NOT_VERIFIED',
      reason: 'No evidence-backed payment exists for this order yet.',
      status: 'DRAFT',
    };
  }
  if (!isPaymentVerificationSource(payment.value.verificationSource)) {
    return {
      ok: false,
      code: 'PAYMENT_NOT_VERIFIED',
      reason: 'The payment record has no valid verification source.',
      status: 'DRAFT',
    };
  }
  if (!(payment.value.amountUsd > 0)) {
    return {
      ok: false,
      code: 'PAYMENT_NOT_VERIFIED',
      reason: 'A zero-amount order does not grant a paid entitlement.',
      status: 'DRAFT',
    };
  }
  if (payment.value.buyerId !== buyerId) {
    // Fail closed without disclosing anything about the real owner.
    return {
      ok: false,
      code: 'BUYER_MISMATCH',
      reason: 'This order is not owned by the requesting buyer.',
      status: 'DRAFT',
    };
  }

  // A refund, chargeback, cancellation or dispute places a hold on the
  // order. An entitlement is a promise to deliver; a held order must not
  // receive one.
  const hold = await readAccessHold(deps, orderId);
  if (!hold.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement store could not be read. Try again shortly.',
      status: 'PENDING',
    };
  }
  if (hold.hold) {
    return {
      ok: false,
      code: 'ACCESS_HELD',
      reason: 'Access to this order is currently held.',
      status: 'REVOKED',
    };
  }

  const entitlement: EntitlementRecord = {
    entitlementId: entitlementIdFor(orderId, buyerId, productVersionId),
    orderId,
    buyerId,
    productVersionId,
    packageId: request.packageId ?? null,
    assets: assets.map((asset) => ({ ...asset })),
    assetReviewState: request.assetReviewState ?? 'REVIEW_READY',
    state: 'GRANTED',
    issuedAt: now.toISOString(),
    expiresAt: null,
    revocationReason: '',
  };

  const saved = await readFromStore(() => deps.store.saveEntitlement(entitlement));
  if (!saved.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement could not be stored. Try again shortly.',
      status: 'PENDING',
    };
  }
  if (!saved.value.ok) {
    // A concurrent grant won the race: the deterministic id makes it the same
    // entitlement, so re-read it rather than creating a second one.
    const again = await readFromStore(() => deps.store.findEntitlement(entitlement.entitlementId));
    if (again.ok && again.value) {
      return { ok: true, entitlement: again.value, created: false };
    }
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement could not be stored. Try again shortly.',
      status: 'PENDING',
    };
  }

  return { ok: true, entitlement, created: true };
}

// ---------------------------------------------------------------------------
// 2. TICKET
// ---------------------------------------------------------------------------

export type TicketRefusalCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'BUYER_MISMATCH'
  | 'ENTITLEMENT_NOT_GRANTED'
  | 'ENTITLEMENT_REVOKED'
  | 'ENTITLEMENT_EXPIRED'
  | 'NO_ASSETS'
  | 'ACCESS_HELD'
  | 'STORE_UNAVAILABLE';

export interface TicketRequest {
  entitlementId: string;
  /** The server-derived buyer identity. */
  buyerId: string;
  ttlSeconds?: number;
  now: Date;
}

/** The ticket as handed to the buyer. The raw token is returned exactly once. */
export interface IssuedTicket {
  ticketId: string;
  /** The raw token. Never stored, never logged, never returned twice. */
  token: string;
  entitlementId: string;
  orderId: string;
  buyerId: string;
  /** The product version this ticket is bound to. */
  productVersionId: string;
  /** The product package this ticket is bound to, when there is one. */
  packageId: string | null;
  assets: DeliveryAsset[];
  issuedAt: string;
  expiresAt: string;
}

export type TicketResult =
  | { ok: true; ticket: IssuedTicket }
  | { ok: false; code: TicketRefusalCode; reason: string; status: DeliveryStatus };

function boundTtl(ttlSeconds: unknown): number {
  const value = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : DEFAULT_TICKET_TTL_SECONDS;
  return Math.min(MAX_TICKET_TTL_SECONDS, Math.max(MIN_TICKET_TTL_SECONDS, value));
}

/**
 * Issue a single-use delivery ticket for an entitlement.
 *
 * The ticket is bound to the buyer that owns the entitlement, carries the
 * pinned content hashes of the assets, and expires. The raw token is returned
 * once; only its keyed fingerprint is stored.
 */
export async function issueDeliveryTicket(
  request: TicketRequest,
  deps: DeliveryDeps,
): Promise<TicketResult> {
  const { entitlementId, buyerId, now } = request;
  if (!isBoundedId(entitlementId) || !isBoundedId(buyerId)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      reason: 'entitlementId and buyerId are required.',
      status: 'DRAFT',
    };
  }

  const read = await readFromStore(() => deps.store.findEntitlement(entitlementId));
  if (!read.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement store could not be read. Try again shortly.',
      status: 'PENDING',
    };
  }
  const entitlement = read.value;
  if (!entitlement) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      reason: 'No entitlement exists for this request.',
      status: 'DRAFT',
    };
  }
  if (entitlement.buyerId !== buyerId) {
    return {
      ok: false,
      code: 'BUYER_MISMATCH',
      reason: 'This entitlement is not owned by the requesting buyer.',
      status: 'REVOKED',
    };
  }
  if (entitlement.state === 'REVOKED') {
    return {
      ok: false,
      code: 'ENTITLEMENT_REVOKED',
      reason: 'This entitlement was revoked.',
      status: 'REVOKED',
    };
  }
  if (entitlement.state === 'EXPIRED') {
    return {
      ok: false,
      code: 'ENTITLEMENT_EXPIRED',
      reason: 'This entitlement has expired.',
      status: 'REVOKED',
    };
  }
  if (entitlement.state !== 'GRANTED') {
    return {
      ok: false,
      code: 'ENTITLEMENT_NOT_GRANTED',
      reason: 'This entitlement is not granted yet.',
      status: 'DRAFT',
    };
  }
  if (entitlement.assets.length === 0) {
    return {
      ok: false,
      code: 'NO_ASSETS',
      reason: 'This entitlement has no assets to deliver.',
      status: 'DRAFT',
    };
  }

  // A hold placed between the payment and the ticket (a chargeback, a
  // dispute) must stop the ticket from being issued at all.
  const hold = await readAccessHold(deps, entitlement.orderId);
  if (!hold.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement store could not be read. Try again shortly.',
      status: 'PENDING',
    };
  }
  if (hold.hold) {
    return {
      ok: false,
      code: 'ACCESS_HELD',
      reason: 'Access to this order is currently held.',
      status: 'REVOKED',
    };
  }

  const token = randomBytes(32).toString('base64url');
  const tokenFingerprint = deps.signer.fingerprint(token);
  const ticketId = `tkt_${sha256Hex(tokenFingerprint).slice(0, 24)}`;
  const ttlSeconds = boundTtl(request.ttlSeconds);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const ticket: TicketRecord = {
    ticketId,
    tokenFingerprint,
    entitlementId: entitlement.entitlementId,
    orderId: entitlement.orderId,
    buyerId: entitlement.buyerId,
    productVersionId: entitlement.productVersionId,
    packageId: entitlement.packageId,
    assets: entitlement.assets.map((asset) => ({ ...asset })),
    state: 'ISSUED',
    issuedAt: now.toISOString(),
    expiresAt,
    consumedAt: null,
    consumedByDeliveryId: null,
  };

  const saved = await readFromStore(() => deps.store.saveTicket(ticket));
  if (!saved.ok || !saved.value.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The ticket could not be stored. Try again shortly.',
      status: 'PENDING',
    };
  }

  return {
    ok: true,
    ticket: {
      ticketId: ticket.ticketId,
      token,
      entitlementId: ticket.entitlementId,
      orderId: ticket.orderId,
      buyerId: ticket.buyerId,
      productVersionId: ticket.productVersionId,
      packageId: ticket.packageId,
      assets: ticket.assets,
      issuedAt: ticket.issuedAt,
      expiresAt: ticket.expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. REDEEM
// ---------------------------------------------------------------------------

export type RedemptionRefusalCode =
  | 'INVALID_REQUEST'
  | 'INVALID_TICKET'
  | 'BUYER_MISMATCH'
  | 'ORDER_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'PACKAGE_MISMATCH'
  | 'TICKET_EXPIRED'
  | 'TICKET_REVOKED'
  | 'TICKET_ALREADY_USED'
  | 'ENTITLEMENT_NOT_FOUND'
  | 'ENTITLEMENT_REVOKED'
  | 'ENTITLEMENT_EXPIRED'
  | 'ENTITLEMENT_NOT_GRANTED'
  | 'ACCESS_HELD'
  | 'ASSET_TAMPERED'
  | 'ASSET_NOT_FOUND'
  | 'STORAGE_NOT_CONFIGURED'
  | 'STORAGE_UNAVAILABLE'
  | 'COMMIT_UNKNOWN'
  | 'DELIVERY_RECORD_UNAVAILABLE'
  | 'STORE_UNAVAILABLE';

/** One delivered asset: the pinned hash plus the private, short-lived handle. */
export interface DeliveredAsset {
  assetId: string;
  contentHash: string;
  sizeBytes: number;
  label: string;
  /** Opaque, short-lived, buyer-scoped handle. Never a public URL. */
  handle: string;
  expiresAt: string;
}

export interface RedemptionRequest {
  ticketId: string;
  /** The raw token from the issued ticket. */
  token: string;
  /** The server-derived buyer identity. */
  buyerId: string;
  now: Date;
}

export type RedemptionResult =
  | {
      ok: true;
      status: 'DELIVERED';
      deliveryId: string;
      delivery: DeliveryRecord;
      assets: DeliveredAsset[];
    }
  | {
      ok: false;
      status: DeliveryStatus;
      code: RedemptionRefusalCode;
      reason: string;
      deliveryId?: string;
    };

/** Deterministic delivery id: the same ticket + buyer is one delivery. */
export function deliveryIdFor(ticketId: string, buyerId: string): string {
  return `dlv_${sha256Hex(`${ticketId}|${buyerId}`).slice(0, 24)}`;
}

function isTicketExpired(ticket: TicketRecord, now: Date): boolean {
  const expiry = Date.parse(ticket.expiresAt);
  return Number.isFinite(expiry) && expiry <= now.getTime();
}

/**
 * Redeem a delivery ticket.
 *
 * The order of operations matters: the buyer's binding is re-checked, the
 * pinned hashes are re-verified against the private storage, and only then is
 * the ticket consumed — atomically, exactly once. A refused attempt never
 * consumes anything.
 */
export async function redeemDeliveryTicket(
  request: RedemptionRequest,
  deps: DeliveryDeps,
): Promise<RedemptionResult> {
  const { ticketId, token, buyerId, now } = request;

  if (!isBoundedId(ticketId) || !isBoundedId(buyerId) || !isBoundedText(token, 512) || token.length < 16) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'INVALID_REQUEST',
      reason: 'A ticket id, its token and the buyer identity are required.',
    };
  }

  const tokenFingerprint = deps.signer.fingerprint(token);
  const ticketRead = await readFromStore(() => deps.store.findTicketByFingerprint(tokenFingerprint));
  if (!ticketRead.ok) {
    // The store is unreadable: we do not know whether the ticket was already
    // spent, so the honest answer is PENDING, never DELIVERED and never
    // "invalid ticket".
    return {
      ok: false,
      status: 'PENDING',
      code: 'STORE_UNAVAILABLE',
      reason: 'The ticket store could not be read. Try again shortly.',
    };
  }
  const ticket = ticketRead.value;
  if (!ticket) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'INVALID_TICKET',
      reason: 'This delivery ticket is not valid.',
    };
  }

  // Buyer substitution: a ticket is only redeemable by the buyer it was
  // issued to. This check happens before anything else is disclosed.
  if (ticket.buyerId !== buyerId) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'BUYER_MISMATCH',
      reason: 'This delivery ticket is not owned by the requesting buyer.',
    };
  }

  if (ticket.state === 'REVOKED') {
    return {
      ok: false,
      status: 'REVOKED',
      code: 'TICKET_REVOKED',
      reason: 'This delivery ticket was revoked.',
    };
  }
  if (ticket.state === 'EXPIRED' || (ticket.state === 'ISSUED' && isTicketExpired(ticket, now))) {
    if (ticket.state === 'ISSUED') {
      // Best effort: remember the expiry so the ticket stops being redeemable.
      await readFromStore(() => deps.store.expireTicket(ticket.ticketId, now.toISOString()));
    }
    return {
      ok: false,
      status: 'FAILED',
      code: 'TICKET_EXPIRED',
      reason: 'This delivery ticket has expired. Request a new one.',
    };
  }

  const entitlementRead = await readFromStore(() => deps.store.findEntitlement(ticket.entitlementId));
  if (!entitlementRead.ok) {
    return {
      ok: false,
      status: 'PENDING',
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement store could not be read. Try again shortly.',
    };
  }
  const entitlement = entitlementRead.value;
  if (!entitlement) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'ENTITLEMENT_NOT_FOUND',
      reason: 'The entitlement behind this ticket no longer exists.',
    };
  }
  if (entitlement.buyerId !== buyerId) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'BUYER_MISMATCH',
      reason: 'This delivery ticket is not owned by the requesting buyer.',
    };
  }
  if (entitlement.state === 'REVOKED') {
    return {
      ok: false,
      status: 'REVOKED',
      code: 'ENTITLEMENT_REVOKED',
      reason: 'The entitlement behind this ticket was revoked.',
    };
  }
  if (entitlement.state === 'EXPIRED') {
    return {
      ok: false,
      status: 'REVOKED',
      code: 'ENTITLEMENT_EXPIRED',
      reason: 'The entitlement behind this ticket has expired.',
    };
  }
  if (entitlement.state !== 'GRANTED') {
    return {
      ok: false,
      status: 'DRAFT',
      code: 'ENTITLEMENT_NOT_GRANTED',
      reason: 'The entitlement behind this ticket is not granted yet.',
    };
  }

  // The ticket's binding must still match the entitlement it came from. A
  // ticket that points at another order, or at another product version, was
  // not issued for this entitlement.
  if (ticket.orderId !== entitlement.orderId) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'ORDER_MISMATCH',
      reason: 'This delivery ticket does not match the order it was issued for.',
    };
  }
  if (ticket.productVersionId !== entitlement.productVersionId) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'VERSION_MISMATCH',
      reason: 'This delivery ticket was issued for a different product version.',
    };
  }
  // The package is part of the promise too. A ticket that names a different
  // package than the entitlement it came from was not issued for this buyer.
  if (ticket.packageId !== entitlement.packageId) {
    return {
      ok: false,
      status: 'FAILED',
      code: 'PACKAGE_MISMATCH',
      reason: 'This delivery ticket was issued for a different product package.',
    };
  }

  const deliveryId = deliveryIdFor(ticket.ticketId, buyerId);

  // A previous attempt may already exist for this deterministic id.
  const priorDelivery = await readFromStore(() => deps.store.findDelivery(deliveryId));
  if (!priorDelivery.ok) {
    return {
      ok: false,
      status: 'PENDING',
      code: 'STORE_UNAVAILABLE',
      reason: 'The delivery store could not be read. Try again shortly.',
      deliveryId,
    };
  }
  if (priorDelivery.value && priorDelivery.value.outcome === 'FAILED') {
    return {
      ok: false,
      status: 'FAILED',
      code: 'ASSET_TAMPERED',
      reason: priorDelivery.value.reason || 'A previous delivery attempt for this ticket failed.',
      deliveryId,
    };
  }

  // ---- The access hold, checked as late as possible ------------------------
  // A refund, chargeback, cancellation or dispute that arrived AFTER the
  // ticket was issued must still stop the delivery. The check sits
  // immediately before the private read, which is the last point before
  // bytes can reach the buyer, and a store that cannot answer is treated as
  // "maybe held" — never as "not held".
  const hold = await readAccessHold(deps, ticket.orderId);
  if (!hold.ok) {
    return {
      ok: false,
      status: 'PENDING',
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement store could not be read. Try again shortly.',
      deliveryId,
    };
  }
  if (hold.hold) {
    return {
      ok: false,
      status: 'REVOKED',
      code: 'ACCESS_HELD',
      reason: 'Access to this order is currently held.',
      deliveryId,
    };
  }

  if (!deps.storage) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      code: 'STORAGE_NOT_CONFIGURED',
      reason: 'Private delivery storage is not configured.',
      deliveryId,
    };
  }

  // ---- Verify the pinned content hashes against the private storage -------
  for (const asset of ticket.assets) {
    const verified = await readFromStore(() => deps.storage!.verifyContentHash(asset));
    if (!verified.ok) {
      return {
        ok: false,
        status: 'UNAVAILABLE',
        code: 'STORAGE_UNAVAILABLE',
        reason: 'Private delivery storage could not be reached. Try again shortly.',
        deliveryId,
      };
    }
    if (!verified.value.ok) {
      const failure = verified.value.failure;
      if (failure === 'UNAVAILABLE') {
        return {
          ok: false,
          status: 'UNAVAILABLE',
          code: 'STORAGE_UNAVAILABLE',
          reason: 'Private delivery storage could not be reached. Try again shortly.',
          deliveryId,
        };
      }
      const reason = verified.value.reason || 'The asset could not be read from private storage.';
      const code: RedemptionRefusalCode = failure === 'DENIED' ? 'ASSET_NOT_FOUND' : 'ASSET_TAMPERED';
      await recordDelivery(deps, {
        deliveryId,
        ticketId: ticket.ticketId,
        entitlementId: entitlement.entitlementId,
        orderId: ticket.orderId,
        buyerId,
        outcome: 'FAILED',
        assetIds: ticket.assets.map((asset) => asset.assetId),
        reason: boundReason(reason),
        now,
      });
      return {
        ok: false,
        status: 'FAILED',
        code,
        reason,
        deliveryId,
      };
    }
    if (verified.value.contentHash !== asset.contentHash) {
      const reason =
        `The stored content of ${asset.assetId} does not match the hash pinned at issue time.`;
      await recordDelivery(deps, {
        deliveryId,
        ticketId: ticket.ticketId,
        entitlementId: entitlement.entitlementId,
        orderId: ticket.orderId,
        buyerId,
        outcome: 'FAILED',
        assetIds: ticket.assets.map((asset) => asset.assetId),
        reason: boundReason(reason),
        now,
      });
      return {
        ok: false,
        status: 'FAILED',
        code: 'ASSET_TAMPERED',
        reason,
        deliveryId,
      };
    }
  }

  // ---- Open the private handles (read-only, before the ticket is spent) ---
  const handles: DeliveredAsset[] = [];
  for (const asset of ticket.assets) {
    const opened = await readFromStore(() =>
      deps.storage!.openForBuyer({
        asset,
        buyerId,
        entitlementId: entitlement.entitlementId,
        deliveryId,
      }),
    );
    if (!opened.ok) {
      return {
        ok: false,
        status: 'PENDING',
        code: 'STORAGE_UNAVAILABLE',
        reason: 'Private delivery storage could not be reached. Try again shortly.',
        deliveryId,
      };
    }
    if (!opened.value.ok) {
      const failure = opened.value.failure;
      if (failure === 'UNAVAILABLE') {
        return {
          ok: false,
          status: 'UNAVAILABLE',
          code: 'STORAGE_UNAVAILABLE',
          reason: 'Private delivery storage could not be reached. Try again shortly.',
          deliveryId,
        };
      }
      if (failure === 'UNKNOWN') {
        // The private read may or may not have happened. The ticket has NOT
        // been consumed yet, so the buyer can simply retry.
        return {
          ok: false,
          status: 'PENDING',
          code: 'COMMIT_UNKNOWN',
          reason: 'The private delivery is still being prepared. Try again shortly.',
          deliveryId,
        };
      }
      const reason = opened.value.reason || 'The asset is not available to this buyer.';
      await recordDelivery(deps, {
        deliveryId,
        ticketId: ticket.ticketId,
        entitlementId: entitlement.entitlementId,
        orderId: ticket.orderId,
        buyerId,
        outcome: 'FAILED',
        assetIds: ticket.assets.map((asset) => asset.assetId),
        reason: boundReason(reason),
        now,
      });
      return {
        ok: false,
        status: 'FAILED',
        code: 'ASSET_NOT_FOUND',
        reason,
        deliveryId,
      };
    }
    handles.push({
      assetId: opened.value.handle.assetId,
      contentHash: opened.value.handle.contentHash,
      sizeBytes: opened.value.handle.sizeBytes,
      label: opened.value.handle.label,
      handle: opened.value.handle.handle,
      expiresAt: opened.value.handle.expiresAt,
    });
  }

  // ---- Consume the ticket: atomic, exactly once --------------------------
  const consumed = await readFromStore(() =>
    deps.store.consumeTicket({
      ticketId: ticket.ticketId,
      tokenFingerprint,
      buyerId,
      deliveryId,
      at: now.toISOString(),
    }),
  );
  if (!consumed.ok) {
    return {
      ok: false,
      status: 'PENDING',
      code: 'COMMIT_UNKNOWN',
      reason: 'The delivery is still being confirmed. Try again shortly.',
      deliveryId,
    };
  }
  if (consumed.value === 'STORE_UNAVAILABLE') {
    // UNKNOWN commit: the ticket may or may not be spent. Report PENDING and
    // let reconciliation settle it with the same deterministic delivery id.
    await recordDelivery(deps, {
      deliveryId,
      ticketId: ticket.ticketId,
      entitlementId: entitlement.entitlementId,
      orderId: ticket.orderId,
      buyerId,
      outcome: 'PENDING',
      assetIds: ticket.assets.map((asset) => asset.assetId),
      reason: 'Ticket consumption could not be confirmed.',
      now,
    });
    return {
      ok: false,
      status: 'PENDING',
      code: 'COMMIT_UNKNOWN',
      reason: 'The delivery is still being confirmed. Try again shortly.',
      deliveryId,
    };
  }
  if (consumed.value === 'CONFLICT') {
    return {
      ok: false,
      status: 'FAILED',
      code: 'TICKET_ALREADY_USED',
      reason: 'This delivery ticket has already been used.',
      deliveryId,
    };
  }
  if (consumed.value === 'NOT_FOUND') {
    return {
      ok: false,
      status: 'FAILED',
      code: 'INVALID_TICKET',
      reason: 'This delivery ticket is not valid.',
      deliveryId,
    };
  }
  // CONSUMED or ALREADY_CONSUMED (an idempotent retry of the same delivery).

  // ---- Record the delivery durably BEFORE reporting it -------------------
  const delivery: DeliveryRecord = {
    deliveryId,
    ticketId: ticket.ticketId,
    entitlementId: entitlement.entitlementId,
    orderId: ticket.orderId,
    buyerId,
    outcome: 'DELIVERED',
    assetIds: handles.map((asset) => asset.assetId),
    reason: 'Delivered to the entitled buyer.',
    createdAt: priorDelivery.value?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const recorded = await readFromStore(() => deps.store.saveDelivery(delivery));
  if (!recorded.ok || !recorded.value.ok) {
    // The assets were handed over but the fact could not be recorded. The
    // honest answer is PENDING: reconciliation will settle the record.
    return {
      ok: false,
      status: 'PENDING',
      code: 'DELIVERY_RECORD_UNAVAILABLE',
      reason: 'The delivery could not be recorded yet. Try again shortly.',
      deliveryId,
    };
  }

  return { ok: true, status: 'DELIVERED', deliveryId, delivery, assets: handles };
}

// ---------------------------------------------------------------------------
// 4. RECORDING HELPERS, RECONCILIATION AND REVOCATION
// ---------------------------------------------------------------------------

async function recordDelivery(
  deps: DeliveryDeps,
  input: {
    deliveryId: string;
    ticketId: string;
    entitlementId: string;
    orderId: string;
    buyerId: string;
    outcome: 'PENDING' | 'DELIVERED' | 'FAILED';
    assetIds: string[];
    reason: string;
    now: Date;
  },
): Promise<void> {
  const existing = await readFromStore(() => deps.store.findDelivery(input.deliveryId));
  const createdAt = existing.ok && existing.value ? existing.value.createdAt : input.now.toISOString();
  await readFromStore(() =>
    deps.store.saveDelivery({
      deliveryId: input.deliveryId,
      ticketId: input.ticketId,
      entitlementId: input.entitlementId,
      orderId: input.orderId,
      buyerId: input.buyerId,
      outcome: input.outcome,
      assetIds: input.assetIds,
      reason: boundReason(input.reason),
      createdAt,
      updatedAt: input.now.toISOString(),
    }),
  );
}

export type RevocationResult =
  | { ok: true; entitlement: EntitlementRecord }
  | { ok: false; code: 'NOT_FOUND' | 'STORE_UNAVAILABLE'; reason: string; status: DeliveryStatus };

/** Revoke an entitlement (administrative action). Tickets stop redeeming. */
export async function revokeEntitlement(
  input: { entitlementId: string; reason: string; now: Date },
  deps: DeliveryDeps,
): Promise<RevocationResult> {
  if (!isBoundedId(input.entitlementId)) {
    return { ok: false, code: 'NOT_FOUND', reason: 'entitlementId is required.', status: 'DRAFT' };
  }
  const read = await readFromStore(() => deps.store.findEntitlement(input.entitlementId));
  if (!read.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement store could not be read. Try again shortly.',
      status: 'PENDING',
    };
  }
  if (!read.value) {
    return { ok: false, code: 'NOT_FOUND', reason: 'No entitlement exists for this request.', status: 'DRAFT' };
  }
  const revoked = await readFromStore(() =>
    deps.store.revokeEntitlement(input.entitlementId, boundReason(input.reason), input.now.toISOString()),
  );
  if (!revoked.ok || !revoked.value.ok) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: 'The entitlement could not be revoked. Try again shortly.',
      status: 'PENDING',
    };
  }
  const after = await readFromStore(() => deps.store.findEntitlement(input.entitlementId));
  return {
    ok: true,
    entitlement: after.ok && after.value
      ? after.value
      : { ...read.value, state: 'REVOKED', revocationReason: boundReason(input.reason) },
  };
}

export type ReconciliationResult =
  | { ok: true; status: 'DELIVERED'; deliveryId: string; delivery: DeliveryRecord; assets: DeliveredAsset[] }
  | { ok: false; status: DeliveryStatus; code: RedemptionRefusalCode; reason: string; deliveryId?: string };

/**
 * Settle an unknown delivery outcome.
 *
 * Reconciliation is the same idempotent redemption with the same
 * deterministic delivery id: if the earlier commit landed, the store reports
 * the ticket as consumed by this delivery; if it did not, the ticket is still
 * spendable. Either way the result is exact — never guessed.
 */
export async function reconcileDelivery(
  request: RedemptionRequest,
  deps: DeliveryDeps,
): Promise<ReconciliationResult> {
  const result = await redeemDeliveryTicket(request, deps);
  if (result.ok) {
    return {
      ok: true,
      status: 'DELIVERED',
      deliveryId: result.deliveryId,
      delivery: result.delivery,
      assets: result.assets,
    };
  }
  return {
    ok: false,
    status: result.status,
    code: result.code,
    reason: result.reason,
    ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}),
  };
}

// ---------------------------------------------------------------------------
// 5. USER-VISIBLE STATUS (durable facts only)
// ---------------------------------------------------------------------------

export interface DeliveryStatusInput {
  entitlement: EntitlementRecord | null;
  ticket: TicketRecord | null;
  delivery: DeliveryRecord | null;
  /** Whether private delivery storage is configured and reachable. */
  storageAvailable: boolean;
}

/**
 * The status the buyer sees.
 *
 * Precedence (durable facts first, so the status can never be more optimistic
 * than the records behind it):
 *   1. a recorded delivery decides: DELIVERED / FAILED / PENDING
 *   2. an absent or not-yet-granted entitlement: DRAFT
 *   3. a revoked or expired entitlement: REVOKED
 *   4. an issued ticket: PENDING (awaiting redemption)
 *   5. assets that are not review-ready: DRAFT
 *   6. private storage not configured: UNAVAILABLE
 *   7. otherwise the delivery is ready to run: REVIEW_READY
 */
export function deliveryStatus(input: DeliveryStatusInput): DeliveryStatus {
  const { entitlement, ticket, delivery, storageAvailable } = input;

  if (delivery) {
    if (delivery.outcome === 'DELIVERED') return 'DELIVERED';
    if (delivery.outcome === 'FAILED') return 'FAILED';
    return 'PENDING';
  }
  if (!entitlement) return 'DRAFT';
  if (entitlement.state === 'REVOKED' || entitlement.state === 'EXPIRED') return 'REVOKED';
  if (entitlement.state !== 'GRANTED') return 'DRAFT';
  if (ticket && ticket.state === 'REVOKED') return 'REVOKED';
  if (ticket && (ticket.state === 'ISSUED' || ticket.state === 'EXPIRED')) return 'PENDING';
  if (entitlement.assetReviewState !== 'REVIEW_READY') return 'DRAFT';
  if (!storageAvailable) return 'UNAVAILABLE';
  return 'REVIEW_READY';
}
