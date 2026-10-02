// ============================================================================
// PHASE 11.2 — OFFER SERVICE (governed commercial writes)
// ============================================================================
// The single write/read path for Offer rows. Every mutation:
//   - validates type/status/halal against the pure constants,
//   - derives estimatedMargin server-side (never from input),
//   - screens halal through the EXISTING screenForHalalCompliance,
//   - gates PAYMENT_VERIFIED behind a PaymentVerificationSource,
//   - is audited via the EXISTING SecurityEvent utility.
//
// An Offer is an ASK. Nothing here can assert that money was received except
// through offerPaymentVerificationGate.
// ============================================================================

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { resolveOfferRouting } from './routing-service';
import {
  OFFER_TYPES,
  OFFER_STATUSES,
  OFFER_HALAL_STATUSES,
  OFFER_PAYMENT_STATES,
  isOfferType,
  isOfferStatus,
  isOfferHalalStatus,
  isOfferRiskState,
  isOfferPaymentState,
  isBoundedMoney,
  isBoundedEffort,
  isCurrency,
  deriveEstimatedMargin,
  offerRequiresProspect,
  offerHalalStatusFromScreen,
  offerPaymentVerificationGate,
  canTransitionOffer,
  MAX_OFFER_TITLE_CHARS,
  MAX_OFFER_DESCRIPTION_CHARS,
  MAX_OFFER_SCOPE_SUMMARY_CHARS,
  MAX_OFFERS_PER_PAGE,
  type OfferType,
  type OfferStatus,
  type OfferHalalStatus,
  type OfferRiskState,
  type OfferPaymentState,
} from './offer-states';

export type CreateOfferResult =
  | { ok: true; offerId: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type OfferMutationOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 404; error: string };

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateOfferInput {
  type: unknown;
  title: unknown;
  description?: unknown;
  scopeSummary?: unknown;
  price: unknown;
  currency?: unknown;
  estimatedEffortHours?: unknown;
  estimatedCost?: unknown;
  opportunityId?: unknown;
  productId?: unknown;
  /** Optional explicit screen verdict; when absent the server screens. */
  halalStatus?: unknown;
  riskState?: unknown;
  status?: unknown;
  actor: string;
  surface: string;
}

export async function createOffer(input: CreateOfferInput): Promise<CreateOfferResult> {
  if (!isOfferType(input.type)) {
    return { ok: false, status: 400, error: `type must be one of: ${OFFER_TYPES.join(', ')}.` };
  }
  const type = input.type as OfferType;
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > MAX_OFFER_TITLE_CHARS) {
    return { ok: false, status: 400, error: `title is required (at most ${MAX_OFFER_TITLE_CHARS} characters).` };
  }
  const description = optionalBoundedString(input.description, MAX_OFFER_DESCRIPTION_CHARS, 'description');
  if (description.error) return { ok: false, status: 400, error: description.error };
  const scopeSummary = optionalBoundedString(input.scopeSummary, MAX_OFFER_SCOPE_SUMMARY_CHARS, 'scopeSummary');
  if (scopeSummary.error) return { ok: false, status: 400, error: scopeSummary.error };

  if (!isBoundedMoney(input.price)) {
    return { ok: false, status: 400, error: 'price must be a non-negative finite number within bounds.' };
  }
  const currency = input.currency === undefined || input.currency === null ? 'USD' : input.currency;
  if (!isCurrency(currency)) {
    return { ok: false, status: 400, error: 'currency must be USD.' };
  }
  const estimatedCost = input.estimatedCost === undefined || input.estimatedCost === null ? 0 : input.estimatedCost;
  if (!isBoundedMoney(estimatedCost)) {
    return { ok: false, status: 400, error: 'estimatedCost must be a non-negative finite number within bounds.' };
  }
  const estimatedEffortHours = input.estimatedEffortHours === undefined || input.estimatedEffortHours === null
    ? 0
    : input.estimatedEffortHours;
  if (!isBoundedEffort(estimatedEffortHours)) {
    return { ok: false, status: 400, error: 'estimatedEffortHours must be a non-negative finite number within bounds.' };
  }

  // Provenance links — verified, never assumed. DIGITAL_PRODUCT offers may
  // link a Product; a MICRO/CLIENT_SERVICE offer must NOT silently claim to be
  // a self-serve product.
  let opportunityId: string | null = null;
  if (input.opportunityId !== undefined && input.opportunityId !== null) {
    if (typeof input.opportunityId !== 'string' || input.opportunityId.length === 0 || input.opportunityId.length > 128) {
      return { ok: false, status: 400, error: 'opportunityId must be a string of at most 128 characters.' };
    }
    const opportunity = await db.opportunity.findUnique({ where: { id: input.opportunityId }, select: { id: true, halalStatus: true } });
    if (!opportunity) return { ok: false, status: 404, error: 'Opportunity not found.' };
    // A BLOCKED opportunity can never back an offer.
    if (opportunity.halalStatus === 'NOT_ALLOWED') {
      await auditSecurityEvent({
        kind: 'COMMERCIAL_OFFER_REFUSED',
        surface: input.surface,
        outcome: 'refused',
        detail: 'opportunity is halalStatus=NOT_ALLOWED; offer not created',
      });
      return { ok: false, status: 400, error: 'The linked opportunity is blocked by halal screening.' };
    }
    opportunityId = opportunity.id;
  }

  let productId: string | null = null;
  if (input.productId !== undefined && input.productId !== null) {
    if (typeof input.productId !== 'string' || input.productId.length === 0 || input.productId.length > 128) {
      return { ok: false, status: 400, error: 'productId must be a string of at most 128 characters.' };
    }
    if (type !== 'DIGITAL_PRODUCT') {
      return { ok: false, status: 400, error: 'Only a DIGITAL_PRODUCT offer may link a Product.' };
    }
    const product = await db.product.findUnique({ where: { id: input.productId }, select: { id: true } });
    if (!product) return { ok: false, status: 404, error: 'Product not found.' };
    productId = product.id;
  }

  // Halal screening — the EXISTING filter, never a second competing system.
  //
  // PHASE 11.6 HARDENING: the server ALWAYS screens the offer text first. A
  // caller-supplied halalStatus can no longer skip screening; it can only be
  // equal to, or MORE CONSERVATIVE than, what the screen decided. This closes
  // the previous path where an admin-supplied 'HALAL' bypassed
  // screenForHalalCompliance entirely.
  const screenVerdict = screenForHalalCompliance(
    input.title.trim(),
    `${description.value ?? ''} ${scopeSummary.value ?? ''}`.trim(),
    type,
    type === 'DIGITAL_PRODUCT' ? 'Direct Sales' : 'Client Service',
    'ONE_TIME_PURCHASE',
  );
  const screenedStatus: OfferHalalStatus = offerHalalStatusFromScreen(screenVerdict.status);

  let halalStatus: OfferHalalStatus;
  if (input.halalStatus !== undefined && input.halalStatus !== null) {
    if (!isOfferHalalStatus(input.halalStatus)) {
      return { ok: false, status: 400, error: `halalStatus must be one of: ${OFFER_HALAL_STATUSES.join(', ')}.` };
    }
    const requested = input.halalStatus;
    // Rank order mirrors the worst-wins rule: a caller may only move the
    // verdict MORE conservative, never less.
    const rank: Record<OfferHalalStatus, number> = { HALAL: 0, UNVERIFIED: 1, REVIEW_REQUIRED: 2, BLOCKED: 3 };
    halalStatus = rank[requested] > rank[screenedStatus] ? requested : screenedStatus;
    if (rank[requested] < rank[screenedStatus]) {
      await auditSecurityEvent({
        kind: 'COMMERCIAL_OFFER_STATUS',
        surface: input.surface,
        outcome: 'ok',
        detail: `caller requested ${requested}; screen decided ${screenedStatus} — screen is authoritative`,
      });
    }
  } else {
    halalStatus = screenedStatus;
  }

  let riskState: OfferRiskState = 'UNVERIFIED';
  if (input.riskState !== undefined && input.riskState !== null) {
    if (!isOfferRiskState(input.riskState)) {
      return { ok: false, status: 400, error: 'Invalid riskState.' };
    }
    riskState = input.riskState;
  }

  let status: OfferStatus = 'DRAFT';
  if (input.status !== undefined && input.status !== null) {
    if (!isOfferStatus(input.status)) {
      return { ok: false, status: 400, error: `status must be one of: ${OFFER_STATUSES.join(', ')}.` };
    }
    status = input.status;
  }
  // A caller cannot ask for an ACTIVE unscreened offer at creation time.
  if (status === 'ACTIVE') {
    const verdict = canTransitionOffer({ from: 'DRAFT', to: 'ACTIVE', price: input.price, halalStatus });
    if (!verdict.ok) return { ok: false, status: 400, error: verdict.reason };
  }

  const price = input.price as number;
  const cost = estimatedCost as number;
  const created = await db.offer.create({
    data: {
      type,
      title: input.title.trim(),
      description: description.value ?? '',
      scopeSummary: scopeSummary.value ?? '',
      price,
      currency,
      estimatedEffortHours: estimatedEffortHours as number,
      estimatedCost: cost,
      // Derived, never supplied.
      estimatedMargin: deriveEstimatedMargin(price, cost),
      opportunityId,
      productId,
      halalStatus,
      riskState,
      status,
      // paymentState is NOT_PAYMENT_VERIFIED by construction; there is no
      // input path that could set a paid state at creation.
      paymentState: 'NOT_PAYMENT_VERIFIED',
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_OFFER_CREATED',
    surface: input.surface,
    outcome: 'ok',
    detail: `offer=${created.id.slice(0, 12)} type=${type} halal=${halalStatus} status=${status}`,
  });

  // PHASE 11.9 (G1) — resolve and PERSIST the routing decision here, on the
  // already-screened offer. This is what makes the Phase 11.3 routing layer
  // reachable from production instead of being a pure-function island.
  //
  // It is deliberately AFTER the halal screen and AFTER the row exists, and it
  // performs no dispatch: it records which EXISTING job types this route runs
  // through. A routing failure never invalidates an offer that was already
  // legally created, so it is reported but not fatal here.
  try {
    const routed = await resolveOfferRouting({ offerId: created.id, surface: input.surface });
    if (routed.ok) {
      await auditSecurityEvent({
        kind: 'COMMERCIAL_OFFER_CREATED',
        surface: input.surface,
        outcome: 'ok',
        detail:
          `offer=${created.id.slice(0, 12)} route=${routed.decision.route} `
          + `executable=${String(routed.decision.executable)} blockers=${routed.decision.blockers.join(',') || 'none'}`,
      });
    }
  } catch {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_OFFER_CREATED',
      surface: input.surface,
      outcome: 'refused',
      detail: `offer=${created.id.slice(0, 12)} routing resolution failed; route left unresolved (no dispatch performed)`,
    });
  }

  return { ok: true, offerId: created.id };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const OFFER_SELECT = {
  id: true,
  type: true,
  title: true,
  description: true,
  scopeSummary: true,
  price: true,
  currency: true,
  estimatedEffortHours: true,
  estimatedCost: true,
  estimatedMargin: true,
  opportunityId: true,
  productId: true,
  halalStatus: true,
  riskState: true,
  status: true,
  paymentState: true,
  paymentVerificationSource: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listOffers(options: { type?: unknown; status?: unknown; limit?: unknown }) {
  const where: Prisma.OfferWhereInput = {};
  if (options.type !== undefined && options.type !== null) {
    if (!isOfferType(options.type)) return { ok: false as const, status: 400 as const, error: 'Invalid type filter.' };
    where.type = options.type;
  }
  if (options.status !== undefined && options.status !== null) {
    if (!isOfferStatus(options.status)) return { ok: false as const, status: 400 as const, error: 'Invalid status filter.' };
    where.status = options.status;
  }
  const limit = Math.max(1, Math.min(typeof options.limit === 'number' ? Math.floor(options.limit) : 50, MAX_OFFERS_PER_PAGE));
  const offers = await db.offer.findMany({ where, orderBy: { updatedAt: 'desc' }, take: limit, select: OFFER_SELECT });
  return { ok: true as const, offers };
}

export async function getOfferById(offerId: unknown) {
  if (typeof offerId !== 'string' || offerId.length === 0 || offerId.length > 128) return null;
  return db.offer.findUnique({ where: { id: offerId }, select: OFFER_SELECT });
}

// ---------------------------------------------------------------------------
// Status transition (deny-by-default + selling gate)
// ---------------------------------------------------------------------------

export async function transitionOfferStatus(options: {
  offerId: unknown;
  to: unknown;
  actor: string;
  surface: string;
}): Promise<OfferMutationOutcome<{ status: OfferStatus }>> {
  const offer = await getOfferById(options.offerId);
  if (!offer) return { ok: false, status: 404, error: 'Offer not found.' };
  if (!isOfferStatus(options.to)) {
    return { ok: false, status: 400, error: `to must be one of: ${OFFER_STATUSES.join(', ')}.` };
  }
  const from = offer.status as OfferStatus;
  const verdict = canTransitionOffer({
    from,
    to: options.to,
    price: offer.price,
    halalStatus: offer.halalStatus as OfferHalalStatus,
  });
  if (!verdict.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_OFFER_TRANSITION_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: `offer=${offer.id.slice(0, 12)} ${from}->${String(options.to)}: ${verdict.reason.slice(0, 100)}`,
    });
    return { ok: false, status: 400, error: verdict.reason };
  }
  await db.offer.update({ where: { id: offer.id }, data: { status: options.to } });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_OFFER_STATUS',
    surface: options.surface,
    outcome: 'ok',
    detail: `offer=${offer.id.slice(0, 12)} ${from}->${options.to}`,
  });
  return { ok: true, status: options.to };
}

// ---------------------------------------------------------------------------
// Payment state — hard gate
// ---------------------------------------------------------------------------

export async function setOfferPaymentState(options: {
  offerId: unknown;
  to: unknown;
  paymentVerificationSource?: unknown;
  paymentVerificationRef?: unknown;
  actor: string;
  surface: string;
}): Promise<OfferMutationOutcome<{ paymentState: OfferPaymentState }>> {
  const offer = await getOfferById(options.offerId);
  if (!offer) return { ok: false, status: 404, error: 'Offer not found.' };
  if (!isOfferPaymentState(options.to)) {
    return { ok: false, status: 400, error: `to must be one of: ${OFFER_PAYMENT_STATES.join(', ')}.` };
  }
  const gate = offerPaymentVerificationGate({
    to: options.to,
    verificationSource: options.paymentVerificationSource,
    verificationRef: options.paymentVerificationRef,
  });
  if (!gate.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_VERIFY_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: `offer=${offer.id.slice(0, 12)} reason=${gate.reason.slice(0, 100)}`,
    });
    return { ok: false, status: 400, error: gate.reason };
  }
  await db.offer.update({
    where: { id: offer.id },
    data: {
      paymentState: options.to,
      paymentVerificationSource: options.to === 'PAYMENT_VERIFIED'
        ? (options.paymentVerificationSource as string)
        : null,
      paymentVerificationRef: options.to === 'PAYMENT_VERIFIED'
        ? (options.paymentVerificationRef as string)
        : null,
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_OFFER_PAYMENT_STATE',
    surface: options.surface,
    outcome: 'ok',
    detail: `offer=${offer.id.slice(0, 12)} ->${options.to}`,
  });
  return { ok: true, paymentState: options.to };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function optionalBoundedString(
  value: unknown,
  max: number,
  field: string,
): { value: string | null; error?: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { value: null, error: `${field} must be a string if provided.` };
  if (value.length > max) return { value: null, error: `${field} must be at most ${max} characters.` };
  return { value };
}

export { offerRequiresProspect };