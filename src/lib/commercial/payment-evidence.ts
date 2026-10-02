// ============================================================================
// PHASE 11.4 — PAYMENT EVIDENCE CLASSIFICATION (pure)
// ============================================================================
// This module is the single place that answers one question: "is this a
// legitimate basis for believing that money arrived?"
//
// It is PURE — no DB, no network, no clock beyond an injected `now`, no AI.
// That is deliberate: the payment trust boundary must be testable in isolation,
// and it must be impossible for a caller to skip it.
//
// The untrusted-input classes below are the ones the Phase 11 spec names
// explicitly. Each is refused outright and named in the refusal, so a refusal
// is auditable rather than a generic "invalid".
//
// Nothing here grants authority. It classifies evidence; the service layer
// decides what to do with a PASS, and the existing engagement state machine
// remains the only thing that can move an engagement to PAYMENT_VERIFIED.
// ============================================================================

/** Sources that may legitimately establish payment truth. */
export const PAYMENT_EVIDENCE_METHODS = ['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED'] as const;
export type PaymentEvidenceMethod = (typeof PAYMENT_EVIDENCE_METHODS)[number];

export function isPaymentEvidenceMethod(value: unknown): value is PaymentEvidenceMethod {
  return typeof value === 'string' && (PAYMENT_EVIDENCE_METHODS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Untrusted input classes
// ---------------------------------------------------------------------------

/**
 * Inputs that are NOT payment evidence. The Phase 11.4 contract names these
 * explicitly; each is refused rather than downgraded, so a caller can never
 * argue "well, it's only a screenshot".
 */
export const UNTRUSTED_PAYMENT_CLAIM_KINDS = [
  'CLIENT_SCREENSHOT',
  'CLIENT_MESSAGE',
  'CLIENT_ASSERTED_STATUS',
  'BROWSER_PARAMETER',
  'FRONTEND_FLAG',
  'AI_GENERATED_CLAIM',
  'ARBITRARY_API_PAYLOAD',
  'SCREENSHOT_ATTACHMENT',
  'VERBAL_CONFIRMATION',
] as const;
export type UntrustedPaymentClaimKind = (typeof UNTRUSTED_PAYMENT_CLAIM_KINDS)[number];

export function isUntrustedPaymentClaimKind(value: unknown): value is UntrustedPaymentClaimKind {
  return typeof value === 'string' && (UNTRUSTED_PAYMENT_CLAIM_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Evidence strength
// ---------------------------------------------------------------------------

/**
 * How strong an evidence class is.
 *  - CRYPTOGRAPHIC: a provider signature was verified over the raw body.
 *  - PROVIDER_READ: a server-to-server provider API confirmed the charge.
 *  - HUMAN_REVIEW:  an authenticated admin examined real evidence.
 */
export const EVIDENCE_STRENGTH = ['CRYPTOGRAPHIC', 'PROVIDER_READ', 'HUMAN_REVIEW'] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTH)[number];

const STRENGTH_BY_METHOD: Readonly<Record<PaymentEvidenceMethod, EvidenceStrength>> = {
  PROVIDER_WEBHOOK: 'CRYPTOGRAPHIC',
  PROVIDER_API: 'PROVIDER_READ',
  MANUAL_ADMIN_APPROVED: 'HUMAN_REVIEW',
};

export function evidenceStrengthFor(method: PaymentEvidenceMethod): EvidenceStrength {
  return STRENGTH_BY_METHOD[method];
}

// ---------------------------------------------------------------------------
// Event authenticity
// ---------------------------------------------------------------------------

/** Provider event types that can establish payment truth. */
export const PAYMENT_EVENT_TYPES = [
  'order.paid',
  'order.confirmed',
  'checkout.completed',
  'payment.succeeded',
  'charge.succeeded',
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export function isPaymentEventType(value: unknown): value is PaymentEventType {
  return typeof value === 'string' && (PAYMENT_EVENT_TYPES as readonly string[]).includes(value);
}

/** Event types that REVERSE a payment. A reversal must never be ignored. */
export const REVERSAL_EVENT_TYPES = [
  'order.refunded',
  'refund.created',
  'charge.refunded',
  'charge.dispute.created',
  'chargeback.created',
  'payment.refunded',
] as const;
export type ReversalEventType = (typeof REVERSAL_EVENT_TYPES)[number];

export function isReversalEventType(value: unknown): value is ReversalEventType {
  return typeof value === 'string' && (REVERSAL_EVENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

/** How long a payment event stays eligible to be first-processed. */
export const PAYMENT_EVENT_TOLERANCE_SECONDS = 900; // 15 minutes

/**
 * Replay window check. Phase 8's webhook layer enforces a 5-minute signature
 * tolerance; this is the independent application-layer window on top of it, so
 * a captured event that is replayed inside the signature window still cannot be
 * applied twice.
 *
 * `now` is injected so replay behaviour is testable without a real clock.
 */
export function isWithinReplayWindow(options: {
  eventTimestampMs: number;
  now?: Date;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: string } {
  const now = options.now ?? new Date();
  const tolerance = options.toleranceSeconds ?? PAYMENT_EVENT_TOLERANCE_SECONDS;
  if (!Number.isFinite(options.eventTimestampMs) || options.eventTimestampMs <= 0) {
    return { ok: false, reason: 'Event timestamp is missing or invalid.' };
  }
  const ageSeconds = (now.getTime() - options.eventTimestampMs) / 1000;
  if (ageSeconds > tolerance) {
    return { ok: false, reason: `Event is ${Math.round(ageSeconds)}s old; the ${tolerance}s replay window has elapsed.` };
  }
  // A timestamp meaningfully in the future is a forged-clock signal, not a
  // fast delivery. Refused rather than clamped.
  if (ageSeconds < -tolerance) {
    return { ok: false, reason: 'Event timestamp is too far in the future; refusing to trust the clock.' };
  }
  return { ok: true };
}

/**
 * Deterministic replay key for a provider event. Two deliveries of the same
 * logical event produce the same key, which is what makes replay collapse to a
 * single recorded row.
 */
export function paymentEventReplayKey(provider: string, providerEventId: string): string {
  return `pay:${provider.trim().toLowerCase()}:${providerEventId.trim()}`;
}

// ---------------------------------------------------------------------------
// Amount / currency validation
// ---------------------------------------------------------------------------

export const MAX_SINGLE_PAYMENT_USD = 10_000_000;

export type AmountValidation =
  | { ok: true; amountUsd: number; currency: string }
  | { ok: false; reason: string };

/**
 * Validate a claimed amount. Providers disagree about minor vs major units, so
 * the caller must declare which it has — an ambiguous amount is refused rather
 * than guessed, because a 100x error here is a 100x financial error.
 */
export function validatePaymentAmount(input: {
  amount: unknown;
  currency?: unknown;
  unit?: 'MAJOR' | 'MINOR';
  maxUsd?: number;
}): AmountValidation {
  const unit = input.unit === 'MINOR' ? 'MINOR' : 'MAJOR';
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
    return { ok: false, reason: 'Payment amount must be a finite number.' };
  }
  const major = unit === 'MINOR' ? input.amount / 100 : input.amount;
  // Round to cents: sub-cent precision is never real payment evidence.
  const amountUsd = Math.round(major * 100) / 100;
  if (amountUsd <= 0) {
    return { ok: false, reason: 'Payment amount must be positive.' };
  }
  const max = input.maxUsd ?? MAX_SINGLE_PAYMENT_USD;
  if (amountUsd > max) {
    return { ok: false, reason: `Payment amount exceeds the ${max} ceiling; refusing to record it.` };
  }
  const currency = typeof input.currency === 'string' && input.currency.trim().length > 0
    ? input.currency.trim().toUpperCase()
    : 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, reason: 'Currency must be a three-letter ISO code.' };
  }
  return { ok: true, amountUsd, currency };
}

// ---------------------------------------------------------------------------
// Manual verification review shape
// ---------------------------------------------------------------------------

/**
 * What a controlled admin manual verification MUST carry. All four are
 * mandatory: an approval that cannot name who decided, what they looked at,
 * why they concluded it, or when, is not a review.
 */
export const REQUIRED_MANUAL_REVIEW_FIELDS = ['reviewer', 'reason', 'evidenceRefs', 'reviewedAt'] as const;

export type ManualReviewInput = {
  reviewer?: unknown;
  reason?: unknown;
  evidenceRefs?: unknown;
  reviewedAt?: Date | string;
};

export type ManualReviewVerdict =
  | { ok: true; reviewer: string; reason: string; evidenceRefs: string[]; reviewedAt: Date }
  | { ok: false; reason: string; missing: string[] };

export const MAX_MANUAL_REASON_CHARS = 1_000;
export const MAX_MANUAL_EVIDENCE_REFS = 20;

/**
 * Validate the four mandatory attributes of a manual review. Pure so the
 * "manual verification is admin-only and fully attributable" rule is testable
 * without a database.
 */
export function validateManualReview(input: ManualReviewInput): ManualReviewVerdict {
  const missing: string[] = [];

  const reviewer = typeof input.reviewer === 'string' ? input.reviewer.trim() : '';
  if (reviewer.length === 0) missing.push('reviewer');

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0) missing.push('reason');
  if (reason.length > MAX_MANUAL_REASON_CHARS) {
    return { ok: false, reason: `reason exceeds ${MAX_MANUAL_REASON_CHARS} characters.`, missing };
  }

  let evidenceRefs: string[] = [];
  if (Array.isArray(input.evidenceRefs)) {
    evidenceRefs = input.evidenceRefs
      .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
      .map((ref) => ref.trim().slice(0, 300));
    if (evidenceRefs.length > MAX_MANUAL_EVIDENCE_REFS) {
      return { ok: false, reason: `evidenceRefs exceeds ${MAX_MANUAL_EVIDENCE_REFS} entries.`, missing };
    }
  }
  if (evidenceRefs.length === 0) missing.push('evidenceRefs');

  let reviewedAt: Date | null = null;
  if (input.reviewedAt instanceof Date) reviewedAt = input.reviewedAt;
  else if (typeof input.reviewedAt === 'string' && input.reviewedAt.trim().length > 0) {
    const parsed = new Date(input.reviewedAt);
    reviewedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (!reviewedAt) missing.push('reviewedAt');

  if (missing.length > 0 || !reviewedAt) {
    return {
      ok: false,
      missing,
      reason:
        `A manual payment verification requires ${REQUIRED_MANUAL_REVIEW_FIELDS.join(', ')}. `
        + `Missing: ${missing.join(', ')}. An unattributed approval is not an approval.`,
    };
  }
  return { ok: true, reviewer, reason, evidenceRefs, reviewedAt };
}

/** Deterministic idempotency key for a manual review. */
export function manualReviewIdempotencyKey(input: {
  engagementId: string;
  milestoneId?: string | null;
  providerRef: string;
}): string {
  return `manual:${input.engagementId}:${input.milestoneId ?? 'engagement'}:${input.providerRef.trim()}`;
}

// ---------------------------------------------------------------------------
// The central verdict
// ---------------------------------------------------------------------------

export type PaymentEvidenceVerdict =
  | {
      ok: true;
      method: PaymentEvidenceMethod;
      strength: EvidenceStrength;
      /** Safe to feed to the engagement state machine. */
      establishesPaymentTruth: boolean;
    }
  | { ok: false; reason: string; untrustedKind?: UntrustedPaymentClaimKind };

/**
 * The single gate. Every path that wants to establish payment truth must pass
 * through here first.
 *
 * Ordering matters: an explicitly-named untrusted class is refused FIRST, so a
 * caller cannot supply `claimKind: 'CLIENT_SCREENSHOT'` alongside a valid
 * looking method string and have it slip through on the method alone.
 */
export function classifyPaymentEvidence(input: {
  method: unknown;
  /** Optional explicit classification of the caller's claim. */
  claimKind?: unknown;
  /** True only for a signature-verified provider event. */
  signatureVerified?: boolean;
  /** True only when a server-to-server provider read confirmed the charge. */
  providerReadVerified?: boolean;
}): PaymentEvidenceVerdict {
  // 1. Named untrusted inputs are refused by name, whatever else is supplied.
  if (isUntrustedPaymentClaimKind(input.claimKind)) {
    return {
      ok: false,
      untrustedKind: input.claimKind,
      reason:
        `${input.claimKind} is not payment evidence. Payment truth requires a signature-verified provider `
        + 'webhook, a server-side provider API read, or a fully attributable admin manual review.',
    };
  }
  if (input.claimKind !== undefined && input.claimKind !== null && typeof input.claimKind !== 'string') {
    return { ok: false, reason: 'claimKind must be a string when supplied.' };
  }

  // 2. The method must be one of the three approved sources.
  if (!isPaymentEvidenceMethod(input.method)) {
    return {
      ok: false,
      reason:
        `Payment truth requires a verification method of ${PAYMENT_EVIDENCE_METHODS.join(' | ')}. `
        + 'A browser flag, a client message, or an AI-generated claim is never one of these.',
    };
  }
  const method = input.method;

  // 3. The method's own precondition must hold. A method name is a claim about
  //    the evidence; these checks are what stop it from being just a string.
  if (method === 'PROVIDER_WEBHOOK' && input.signatureVerified !== true) {
    return {
      ok: false,
      reason:
        'PROVIDER_WEBHOOK requires a verified webhook signature over the raw request body. An unsigned '
        + 'payload claiming to be a webhook is refused.',
    };
  }
  if (method === 'PROVIDER_API' && input.providerReadVerified !== true) {
    return {
      ok: false,
      reason: 'PROVIDER_API requires a confirmed server-to-server read of the charge from the provider.',
    };
  }
  // MANUAL_ADMIN_APPROVED's four mandatory attributes are validated by
  // validateManualReview(); by the time we get here they have passed.

  return {
    ok: true,
    method,
    strength: STRENGTH_BY_METHOD[method],
    establishesPaymentTruth: true,
  };
}

// ---------------------------------------------------------------------------
// Reversal handling
// ---------------------------------------------------------------------------

export const REVERSAL_OUTCOMES = ['REFUNDED', 'CHARGEBACK', 'REVERSED', 'PARTIALLY_REFUNDED'] as const;
export type ReversalOutcome = (typeof REVERSAL_OUTCOMES)[number];

export function isReversalOutcome(value: unknown): value is ReversalOutcome {
  return typeof value === 'string' && (REVERSAL_OUTCOMES as readonly string[]).includes(value);
}

/**
 * How a reversal changes recognized revenue. A partial refund reduces what is
 * recognized; a full refund or chargeback takes it to zero. The clamp at zero
 * matters: a double refund must never make revenue negative.
 */
export function recognizedRevenueAfterReversal(input: {
  recognizedUsd: number;
  refundUsd: number;
  outcome: ReversalOutcome;
}): { recognizedUsd: number; refundTotalUsd: number } {
  const recognized = Number.isFinite(input.recognizedUsd) ? Math.max(0, input.recognizedUsd) : 0;
  const refund = Number.isFinite(input.refundUsd) ? Math.max(0, input.refundUsd) : 0;
  const isFull = input.outcome === 'REFUNDED' || input.outcome === 'CHARGEBACK' || input.outcome === 'REVERSED';
  const next = isFull ? 0 : Math.max(0, Math.round((recognized - refund) * 100) / 100);
  // The refund actually applied is the amount REMOVED from recognized revenue,
  // not the amount requested. On a partial refund these are equal; on a
  // full refund the requested amount may exceed what was left to take, and
  // reporting the request would double-count it.
  const refundAppliedUsd = Math.round(Math.max(0, recognized - next) * 100) / 100;
  return {
    recognizedUsd: next,
    refundTotalUsd: refundAppliedUsd,
  };
}
