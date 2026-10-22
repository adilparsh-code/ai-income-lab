// ============================================================================
// PRIVATE DELIVERY — BUYER-SAFE VIEW
// ============================================================================
// A projection of the durable delivery records into the shape a buyer-facing
// surface may render.
//
// WHY A SEPARATE PROJECTION
// -------------------------
// The durable records are written for the system's own bookkeeping, and they
// legitimately contain things a buyer must never see: the keyed fingerprint
// of the bearer token, the internal revocation reason, the storage-side
// identifiers. A view that simply returns the records would leak all three
// through any route that renders it.
//
// So the view is built from an ALLOW-LIST: every field that reaches the
// buyer is named here on purpose. Anything not named here does not exist in
// the view — not "is stripped later", but "is never copied".
//
// WHAT THE VIEW NEVER CONTAINS
//   - the raw bearer token, or its keyed fingerprint
//   - a private storage handle, or a public URL
//   - the internal revocation reason, or a provider payload
//   - a second buyer's identifiers
//
// The view is pure: it takes records and returns records. It performs no I/O
// and holds no state, so it can be rendered anywhere.
// ============================================================================

import {
  deliveryStatus,
  type DeliveryStatusInput,
} from './private-delivery';
import type {
  DeliveryAsset,
  DeliveryAssetKind,
  DeliveryOutcome,
  DeliveryStatus,
  EntitlementRecord,
  EntitlementState,
  TicketRecord,
  TicketState,
} from './ports';

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** One deliverable asset, as the buyer may see it. */
export interface DeliveryAssetView {
  assetId: string;
  kind: DeliveryAssetKind;
  /** The sha256 the content is pinned to. The buyer can verify it. */
  contentHash: string;
  sizeBytes: number;
  label: string;
}

/** The entitlement, without its internal revocation reason. */
export interface DeliveryEntitlementView {
  entitlementId: string;
  orderId: string;
  productVersionId: string;
  packageId: string | null;
  state: EntitlementState;
  issuedAt: string;
  expiresAt: string | null;
}

/** The ticket, without its fingerprint. */
export interface DeliveryTicketView {
  ticketId: string;
  state: TicketState;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

/** The delivery attempt, without its internal reason. */
export interface DeliveryRecordView {
  deliveryId: string;
  outcome: DeliveryOutcome;
  assetIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Everything a buyer-facing surface may show about one delivery. */
export interface DeliveryView {
  status: DeliveryStatus;
  entitlement: DeliveryEntitlementView | null;
  ticket: DeliveryTicketView | null;
  delivery: DeliveryRecordView | null;
  /** The assets the buyer is entitled to receive. */
  assets: DeliveryAssetView[];
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

function toAssetView(asset: DeliveryAsset): DeliveryAssetView {
  return {
    assetId: asset.assetId,
    kind: asset.kind,
    contentHash: asset.contentHash,
    sizeBytes: asset.sizeBytes,
    label: asset.label,
  };
}

function toEntitlementView(entitlement: EntitlementRecord): DeliveryEntitlementView {
  return {
    entitlementId: entitlement.entitlementId,
    orderId: entitlement.orderId,
    productVersionId: entitlement.productVersionId,
    packageId: entitlement.packageId,
    state: entitlement.state,
    issuedAt: entitlement.issuedAt,
    expiresAt: entitlement.expiresAt,
  };
}

function toTicketView(ticket: TicketRecord): DeliveryTicketView {
  return {
    ticketId: ticket.ticketId,
    state: ticket.state,
    issuedAt: ticket.issuedAt,
    expiresAt: ticket.expiresAt,
    consumedAt: ticket.consumedAt,
  };
}

function toDeliveryView(
  delivery: NonNullable<DeliveryStatusInput['delivery']>,
): DeliveryRecordView {
  return {
    deliveryId: delivery.deliveryId,
    outcome: delivery.outcome,
    assetIds: [...delivery.assetIds],
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

/**
 * Build the buyer-safe view.
 *
 * The status comes from `deliveryStatus()`, which reads the durable facts
 * only: the view can never be more optimistic than the records behind it.
 */
export function buildDeliveryView(input: DeliveryStatusInput): DeliveryView {
  const { entitlement, ticket, delivery } = input;

  // The assets come from the ticket when there is one, because the ticket
  // carries the PINNED list — the exact promise. Without a ticket the
  // entitlement's list is the best available truth.
  const source = ticket?.assets ?? entitlement?.assets ?? [];

  return {
    status: deliveryStatus(input),
    entitlement: entitlement ? toEntitlementView(entitlement) : null,
    ticket: ticket ? toTicketView(ticket) : null,
    delivery: delivery ? toDeliveryView(delivery) : null,
    assets: source.map(toAssetView),
  };
}

// ---------------------------------------------------------------------------
// Buyer-facing copy
// ---------------------------------------------------------------------------

/**
 * One message per status.
 *
 * The copy never says WHY a delivery was refused: a buyer is told what the
 * state is and what to do next, never about internal reasons, provider
 * events or other buyers.
 */
export const DELIVERY_STATUS_MESSAGES: Record<DeliveryStatus, string> = {
  DRAFT: 'Your delivery is still being prepared.',
  REVIEW_READY: 'Your delivery is ready to download.',
  UNAVAILABLE: 'Private delivery is temporarily unavailable. Please try again shortly.',
  PENDING: 'Your delivery is being confirmed. Please try again shortly.',
  FAILED: 'This delivery could not be completed. Please contact support.',
  REVOKED: 'Access to this delivery has been withdrawn.',
  DELIVERED: 'Your delivery is complete.',
};
