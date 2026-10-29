// ============================================================================
// PUBLIC EVENT INGESTION POLICY (pure)
// ============================================================================
// POST /api/events must stay reachable by the anonymous storefront (it posts
// PRODUCT_VIEW / CTA_CLICK), but an anonymous caller must never be able to
// assert money or "verified" evidence:
//   - only top-of-funnel types are accepted without a credential;
//   - PURCHASE / REFUND require the operator credential (or the signed payment
//     webhook path), because they carry monetary value;
//   - public events are always labelled USER_ENTERED, never VERIFIED_DATA;
//   - public events carry no amount and cannot self-assert opportunity or
//     experiment linkage (derived from the product server-side).
// ============================================================================

export const PUBLIC_EVENT_TYPES = [
  'VISITOR', 'PAGE_VIEW', 'PRODUCT_VIEW', 'CTA_CLICK', 'CHECKOUT_STARTED',
] as const;

export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

export function isPublicEventType(value: unknown): value is PublicEventType {
  return typeof value === 'string' && (PUBLIC_EVENT_TYPES as readonly string[]).includes(value);
}

export interface PublicEventSanitized {
  evidenceType: 'USER_ENTERED';
  amountUsd: null;
  experimentId: null;
  opportunityId: string | null;
}

/** Fields an anonymous caller is NOT allowed to control. */
export function sanitizePublicEvent(product: { opportunityId: string | null }): PublicEventSanitized {
  return {
    evidenceType: 'USER_ENTERED',
    amountUsd: null,
    experimentId: null,
    opportunityId: product.opportunityId ?? null,
  };
}
