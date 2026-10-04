// ============================================================================
// PHASE 11.2 — OFFER STATES + VALIDATION (pure, bounded, offline)
// ============================================================================
// The governed Offer vocabulary that makes DIGITAL PRODUCTS, MICRO-SERVICES
// and CLIENT SERVICES first-class peers of ONE commercial pipeline.
//
// Pure module: no DB, no network, no AI provider, no secrets. Every constant,
// validator and transition here is deterministic and unit tested.
//
// Hard invariants (docs/phase-11-design.md §1, §23):
// - An Offer is an ASK. Nothing in this module can produce a state implying
//   money was received. `paymentState` may only become PAYMENT_VERIFIED through
//   `offerPaymentVerificationGate`, which requires a PaymentVerificationSource
//   (PROVIDER_WEBHOOK | PROVIDER_API | MANUAL_ADMIN_APPROVED).
// - halalStatus defaults to UNVERIFIED. An unscreened offer is NOT halal, and
//   this module has no path from a client-supplied value to HALAL.
// - estimatedMargin is DERIVED server-side (price - cost); it is never read
//   from caller input.
// ============================================================================

// ---------------------------------------------------------------------------
// Offer types — the three income engines
// ---------------------------------------------------------------------------

export const OFFER_TYPES = ['DIGITAL_PRODUCT', 'MICRO_SERVICE', 'CLIENT_SERVICE'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export function isOfferType(value: unknown): value is OfferType {
  return typeof value === 'string' && (OFFER_TYPES as readonly string[]).includes(value);
}

/**
 * DIGITAL_PRODUCT is sold self-serve through the existing Product/publishing
 * pipeline and does not require a Prospect. MICRO_SERVICE and CLIENT_SERVICE
 * are sold through a Proposal to a Prospect. This is the single fork in the
 * commercial architecture — everything downstream (pricing, proposal,
 * engagement, delivery, revenue) is shared.
 */
export const OFFER_TYPE_REQUIRES_PROSPECT: Readonly<Record<OfferType, boolean>> = {
  DIGITAL_PRODUCT: false,
  MICRO_SERVICE: true,
  CLIENT_SERVICE: true,
};

export function offerRequiresProspect(type: OfferType): boolean {
  return OFFER_TYPE_REQUIRES_PROSPECT[type];
}

// ---------------------------------------------------------------------------
// Offer lifecycle
// ---------------------------------------------------------------------------

export const OFFER_STATUSES = ['DRAFT', 'REVIEW_REQUIRED', 'ACTIVE', 'RETIRED', 'BLOCKED'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export function isOfferStatus(value: unknown): value is OfferStatus {
  return typeof value === 'string' && (OFFER_STATUSES as readonly string[]).includes(value);
}

/**
 * Offer transitions are deny-by-default. ACTIVE requires a positive price and
 * a screened (non-BLOCKED, non-UNVERIFIED) halal status: an unscreened offer
 * cannot be offered for sale. RETIRED/BLOCKED are always reachable so the
 * operator can stop selling immediately.
 */
export const OFFER_STATUS_TRANSITIONS: Readonly<Record<OfferStatus, readonly OfferStatus[]>> = {
  DRAFT: ['REVIEW_REQUIRED', 'ACTIVE', 'BLOCKED'],
  REVIEW_REQUIRED: ['DRAFT', 'ACTIVE', 'BLOCKED'],
  ACTIVE: ['RETIRED', 'BLOCKED', 'REVIEW_REQUIRED'],
  RETIRED: ['DRAFT', 'BLOCKED'],
  BLOCKED: ['DRAFT'], // admin-only unblock; never a silent reactivation
};

export interface OfferTransitionInput {
  from: OfferStatus;
  to: OfferStatus;
  price: number;
  halalStatus: OfferHalalStatus;
}

export type OfferTransitionResult =
  | { ok: true; from: OfferStatus; to: OfferStatus }
  | { ok: false; from: OfferStatus; to: OfferStatus; reason: string };

export function canTransitionOffer(input: OfferTransitionInput): OfferTransitionResult {
  const { from, to, price, halalStatus } = input;
  if (!isOfferStatus(from)) return { ok: false, from, to, reason: 'Invalid current offer status.' };
  if (!isOfferStatus(to)) return { ok: false, from, to, reason: 'to must be a valid offer status.' };
  if (from === to) return { ok: false, from, to, reason: `Offer is already ${to}.` };
  if (!(OFFER_STATUS_TRANSITIONS[from] ?? []).includes(to)) {
    return { ok: false, from, to, reason: `Transition ${from} → ${to} is not allowed.` };
  }
  // Selling gate: ACTIVE requires real, screened commercial terms.
  if (to === 'ACTIVE') {
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, from, to, reason: 'An offer must have a price greater than zero before it can go ACTIVE.' };
    }
    if (halalStatus === 'BLOCKED') {
      return { ok: false, from, to, reason: 'A BLOCKED (halal) offer cannot go ACTIVE.' };
    }
    if (halalStatus === 'UNVERIFIED') {
      return { ok: false, from, to, reason: 'An UNVERIFIED offer cannot go ACTIVE — halal screening must run first.' };
    }
  }
  return { ok: true, from, to };
}

// ---------------------------------------------------------------------------
// Halal screening vocabulary (reuses src/lib/halal-filter.ts verdicts)
// ---------------------------------------------------------------------------

/**
 * UNVERIFIED is Phase 11.2's honest default and is DELIBERATELY not one of the
 * three existing Opportunity.halalStatus values: an offer that has never been
 * screened must not masquerade as HALAL.
 */
export const OFFER_HALAL_STATUSES = ['HALAL', 'REVIEW_REQUIRED', 'BLOCKED', 'UNVERIFIED'] as const;
export type OfferHalalStatus = (typeof OFFER_HALAL_STATUSES)[number];

export function isOfferHalalStatus(value: unknown): value is OfferHalalStatus {
  return typeof value === 'string' && (OFFER_HALAL_STATUSES as readonly string[]).includes(value);
}

/** Map the EXISTING screenForHalalCompliance verdict onto an Offer status. */
export function offerHalalStatusFromScreen(screenStatus: string): OfferHalalStatus {
  if (screenStatus === 'HALAL') return 'HALAL';
  if (screenStatus === 'NOT_ALLOWED') return 'BLOCKED';
  if (screenStatus === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED';
  return 'UNVERIFIED';
}

export const OFFER_RISK_STATES = ['UNVERIFIED', 'LOW_RISK', 'NORMAL', 'REVIEW_REQUIRED', 'HIGH_RISK', 'BLOCKED'] as const;
export type OfferRiskState = (typeof OFFER_RISK_STATES)[number];

export function isOfferRiskState(value: unknown): value is OfferRiskState {
  return typeof value === 'string' && (OFFER_RISK_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Payment state — the hard gate
// ---------------------------------------------------------------------------

export const OFFER_PAYMENT_STATES = [
  'NOT_PAYMENT_VERIFIED',
  'PAYMENT_REQUIRED',
  'PAYMENT_PENDING',
  'PAYMENT_VERIFIED',
  'REFUNDED',
] as const;
export type OfferPaymentState = (typeof OFFER_PAYMENT_STATES)[number];

export function isOfferPaymentState(value: unknown): value is OfferPaymentState {
  return typeof value === 'string' && (OFFER_PAYMENT_STATES as readonly string[]).includes(value);
}

/**
 * Payment truth may ONLY originate from a verified provider webhook, a
 * verified provider API, or an explicitly approved admin manual verification.
 * A screenshot, receipt, "I paid" message, or browser flag can never satisfy
 * this gate — it has no source value that passes `isPaymentVerificationSource`.
 */
export function offerPaymentVerificationGate(input: {
  to: OfferPaymentState;
  verificationSource?: unknown;
  verificationRef?: unknown;
}): { ok: true } | { ok: false; reason: string } {
  if (input.to !== 'PAYMENT_VERIFIED') return { ok: true };
  if (
    (typeof input.verificationSource !== 'string'
      || !['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED'].includes(input.verificationSource))
    || typeof input.verificationRef !== 'string'
    || input.verificationRef.trim().length === 0
    || input.verificationRef.length > 300
  ) {
    return {
      ok: false,
      reason:
        'PAYMENT_VERIFIED requires a paymentVerificationSource (PROVIDER_WEBHOOK | PROVIDER_API | '
        + 'MANUAL_ADMIN_APPROVED) and a paymentVerificationRef. Claims, receipts and screenshots are never a source.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pricing / margin — derived, never supplied
// ---------------------------------------------------------------------------

export const MAX_PRICE_USD = 1_000_000;
export const MAX_COST_USD = 1_000_000;
export const MAX_EFFORT_HOURS = 10_000;
export const CURRENCIES = ['USD'] as const;

export function isCurrency(value: unknown): value is (typeof CURRENCIES)[number] {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/** Round to cents; keeps derived margin arithmetic deterministic. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Estimated margin is ALWAYS computed from price − cost; caller input ignored. */
export function deriveEstimatedMargin(price: number, cost: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(cost)) return 0;
  return roundMoney(price - cost);
}

/** Bounded, non-negative finite number check shared by all money inputs. */
export function isBoundedMoney(value: unknown, max = MAX_PRICE_USD): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

export function isBoundedEffort(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_EFFORT_HOURS;
}

// ---------------------------------------------------------------------------
// Bounded field limits (Phase 11.2 spec §16 style — refuse, never truncate)
// ---------------------------------------------------------------------------

export const MAX_OFFER_TITLE_CHARS = 200;
export const MAX_OFFER_DESCRIPTION_CHARS = 4_000;
export const MAX_OFFER_SCOPE_SUMMARY_CHARS = 2_000;
export const MAX_OFFERS_PER_PAGE = 100;