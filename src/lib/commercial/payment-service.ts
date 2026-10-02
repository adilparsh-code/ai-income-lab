// ============================================================================
// PHASE 11.4 — PAYMENT VERIFICATION SERVICE (evidence → governed state)
// ============================================================================
// The write path that turns payment EVIDENCE into governed commercial state.
//
// It deliberately reuses everything that already exists and adds no second
// system:
//   - the Phase 8 signature boundary (webhook-verification.ts) decides whether
//     bytes are authentic; this module is only called AFTER that returns ok;
//   - the Phase 11.3 engagement state machine (engagement-states.ts) remains
//     the only thing that can move an engagement to PAYMENT_VERIFIED;
//   - the existing Revenue ledger remains the only revenue table;
//   - SecurityEvent remains the audit sink.
//
// What is genuinely new here is the ledger: every claim the system was asked to
// trust gets a PaymentEvent row with a verdict, including the REJECTED ones. A
// refused screenshot claim is auditable, not invisible.
//
// Refusals are explicit and typed. Nothing in this file can authorize work
// without an evidence verdict from payment-evidence.ts.
// ============================================================================

import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import {
  classifyPaymentEvidence,
  isReversalEventType,
  isWithinReplayWindow,
  manualReviewIdempotencyKey,
  paymentEventReplayKey,
  recognizedRevenueAfterReversal,
  validateManualReview,
  validatePaymentAmount,
  type PaymentEvidenceMethod,
  type ReversalOutcome,
} from './payment-evidence';
import { isEngagementState, isMilestonePaymentState } from './engagement-states';

export type PaymentResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; status: 400 | 404 | 409; error: string };

const SURFACE = 'commercial:payment';

// ---------------------------------------------------------------------------
// Internal: record one evidence verdict (accepted or rejected)
// ---------------------------------------------------------------------------

async function recordEvidence(options: {
  provider: string;
  providerEventId: string;
  eventType: string;
  outcome: 'RECORDED' | 'REJECTED' | 'DUPLICATE' | 'REVERSED' | 'IGNORED';
  rejectionReason?: string;
  signatureVerified: boolean;
  verificationMethod: PaymentEvidenceMethod | 'NONE';
  amountUsd?: number;
  currency?: string;
  engagementId?: string | null;
  milestoneId?: string | null;
  offerId?: string | null;
  evidenceRefs?: unknown;
  receivedAt?: Date;
  reversalOfId?: string | null;
  reversalReason?: string;
  surface: string;
}): Promise<{ ok: true; paymentEventId: string; duplicate: boolean }> {
  // Deterministic replay key, derived from the provider + providerEventId pair.
  // It is used as the LOGICAL identity in the audit detail below; the
  // authoritative uniqueness guard is the @@unique([provider, providerEventId])
  // index, which is what makes concurrent deliveries collapse safely.
  const replayKey = paymentEventReplayKey(options.provider, options.providerEventId);

  // An existing row for this (provider, providerEventId) is a REPLAY. It never
  // mutates engagement state a second time.
  const existing = await db.paymentEvent.findFirst({
    where: { provider: options.provider, providerEventId: options.providerEventId },
    select: { id: true, outcome: true },
  });
  if (existing) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_REPLAY_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: `replayed ${replayKey.slice(0, 60)} — already ${existing.outcome}; no state change applied`,
    });
    return { ok: true, paymentEventId: existing.id, duplicate: true };
  }

  try {
    const created = await db.paymentEvent.create({
      data: {
        provider: options.provider,
        providerEventId: options.providerEventId,
        eventType: options.eventType,
        outcome: options.outcome,
        rejectionReason: options.rejectionReason?.slice(0, 300) ?? '',
        signatureVerified: options.signatureVerified,
        verificationMethod: options.verificationMethod,
        amountUsd: options.amountUsd ?? 0,
        currency: options.currency ?? 'USD',
        engagementId: options.engagementId ?? null,
        milestoneId: options.milestoneId ?? null,
        offerId: options.offerId ?? null,
        evidenceRefs: JSON.stringify(options.evidenceRefs ?? []).slice(0, 2_000),
        receivedAt: options.receivedAt ?? new Date(),
        processedAt: new Date(),
        reversalOfId: options.reversalOfId ?? null,
        reversalReason: options.reversalReason?.slice(0, 300) ?? '',
      },
    });
    return { ok: true, paymentEventId: created.id, duplicate: false };
  } catch (error) {
    // Concurrent delivery of the same event: the unique index collapsed it.
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
      const row = await db.paymentEvent.findFirst({
        where: { provider: options.provider, providerEventId: options.providerEventId },
        select: { id: true },
      });
      return { ok: true, paymentEventId: row?.id ?? '', duplicate: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 11.4 — Apply a signature-verified provider payment event
// ---------------------------------------------------------------------------

/**
 * Apply a payment event that has ALREADY passed signature verification.
 *
 * The caller is responsible for having verified the signature; this function
 * still refuses to accept `signatureVerified !== true`, so a future caller
 * cannot skip that step by accident.
 *
 * It performs, in order: replay window → replay key → event type → amount and
 * currency → ownership (the event's engagement/milestone must be the intended
 * target) → evidence classification → governed state transition.
 */
export async function applyVerifiedPaymentEvent(options: {
  provider: string;
  providerEventId: unknown;
  eventType: unknown;
  signatureVerified: boolean;
  amount: unknown;
  currency?: unknown;
  amountUnit?: 'MAJOR' | 'MINOR';
  eventTimestampMs?: number;
  engagementId?: unknown;
  milestoneId?: unknown;
  offerId?: unknown;
  evidenceRefs?: unknown;
  surface?: string;
}): Promise<PaymentResult> {
  const surface = options.surface ?? SURFACE;

  // --- Replay window -------------------------------------------------------
  if (typeof options.eventTimestampMs === 'number') {
    const window = isWithinReplayWindow({ eventTimestampMs: options.eventTimestampMs });
    if (!window.ok) {
      await recordEvidence({
        provider: options.provider,
        providerEventId: String(options.providerEventId ?? 'unknown'),
        eventType: String(options.eventType ?? 'unknown'),
        outcome: 'REJECTED',
        rejectionReason: window.reason,
        signatureVerified: options.signatureVerified === true,
        verificationMethod: 'NONE',
        surface,
      });
      return { ok: false, status: 400, error: window.reason };
    }
  }

  // --- Event identity ------------------------------------------------------
  if (typeof options.providerEventId !== 'string' || options.providerEventId.trim().length === 0) {
    return { ok: false, status: 400, error: 'providerEventId is required.' };
  }
  if (typeof options.eventType !== 'string' || options.eventType.trim().length === 0) {
    return { ok: false, status: 400, error: 'eventType is required.' };
  }

  // A reversal is handled by its own path so a refund can never be treated as
  // a fresh payment (and a payment can never be treated as a refund).
  if (isReversalEventType(options.eventType)) {
    return applyVerifiedReversalEvent({ ...options, surface });
  }

  // --- Amount / currency ---------------------------------------------------
  const amount = validatePaymentAmount({
    amount: options.amount,
    currency: options.currency,
    unit: options.amountUnit ?? 'MAJOR',
  });
  if (!amount.ok) {
    await recordEvidence({
      provider: options.provider,
      providerEventId: options.providerEventId,
      eventType: options.eventType,
      outcome: 'REJECTED',
      rejectionReason: amount.reason,
      signatureVerified: options.signatureVerified === true,
      verificationMethod: 'NONE',
      surface,
    });
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_VERIFY_REFUSED',
      surface,
      outcome: 'refused',
      detail: amount.reason.slice(0, 100),
    });
    return { ok: false, status: 400, error: amount.reason };
  }

  // --- Evidence classification --------------------------------------------
  const verdict = classifyPaymentEvidence({
    method: 'PROVIDER_WEBHOOK',
    signatureVerified: options.signatureVerified === true,
  });
  if (!verdict.ok) {
    await recordEvidence({
      provider: options.provider,
      providerEventId: options.providerEventId,
      eventType: options.eventType,
      outcome: 'REJECTED',
      rejectionReason: verdict.reason,
      signatureVerified: options.signatureVerified === true,
      verificationMethod: 'NONE',
      amountUsd: amount.amountUsd,
      currency: amount.currency,
      surface,
    });
    return { ok: false, status: 400, error: verdict.reason };
  }

  // --- Ownership: the event must target an engagement we actually own ----
  const engagementId = typeof options.engagementId === 'string' && options.engagementId.length > 0
    ? options.engagementId
    : null;
  const milestoneId = typeof options.milestoneId === 'string' && options.milestoneId.length > 0
    ? options.milestoneId
    : null;

  if (engagementId) {
    const engagement = await db.serviceEngagement.findUnique({
      where: { id: engagementId },
      select: { id: true, state: true, paymentState: true, currency: true },
    });
    if (!engagement) {
      return { ok: false, status: 404, error: 'Engagement not found.' };
    }
    if (!isEngagementState(engagement.state)) {
      return { ok: false, status: 400, error: 'Engagement has an invalid state.' };
    }
    // A payment in a different currency than the engagement was priced in is
    // NOT silently accepted as settlement.
    if (amount.currency !== engagement.currency) {
      await recordEvidence({
        provider: options.provider,
        providerEventId: options.providerEventId,
        eventType: options.eventType,
        outcome: 'REJECTED',
        rejectionReason: `currency ${amount.currency} does not match engagement currency ${engagement.currency}`,
        signatureVerified: true,
        verificationMethod: 'PROVIDER_WEBHOOK',
        amountUsd: amount.amountUsd,
        currency: amount.currency,
        engagementId,
        milestoneId,
        surface,
      });
      return {
        ok: false, status: 400,
        error: `Payment currency ${amount.currency} does not match the engagement currency ${engagement.currency}.`,
      };
    }
  } else {
    // A verified payment with no engagement is still recorded as evidence, but
    // it can never authorize service work.
    await recordEvidence({
      provider: options.provider,
      providerEventId: options.providerEventId,
      eventType: options.eventType,
      outcome: 'RECORDED',
      signatureVerified: true,
      verificationMethod: 'PROVIDER_WEBHOOK',
      amountUsd: amount.amountUsd,
      currency: amount.currency,
      offerId: typeof options.offerId === 'string' ? options.offerId : null,
      evidenceRefs: options.evidenceRefs,
      surface,
    });
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_UNLINKED_RECORDED',
      surface,
      outcome: 'ok',
      detail: `verified payment $${amount.amountUsd} ${amount.currency} had no engagement target; recorded, nothing authorized`,
    });
    return { ok: true, unlinked: true, amountUsd: amount.amountUsd, currency: amount.currency };
  }

  // Milestone ownership.
  if (milestoneId) {
    const milestone = await db.milestone.findUnique({
      where: { id: milestoneId },
      select: { id: true, engagementId: true, amountUsd: true, paymentState: true },
    });
    if (!milestone) return { ok: false, status: 404, error: 'Milestone not found.' };
    if (milestone.engagementId !== engagementId) {
      return { ok: false, status: 400, error: 'Milestone does not belong to this engagement.' };
    }
    if (!isMilestonePaymentState(milestone.paymentState)) {
      return { ok: false, status: 400, error: 'Milestone has an invalid payment state.' };
    }
    // Overpayment beyond the milestone value is not silently accepted as full
    // settlement of a different amount; it is recorded and reported.
    if (milestone.amountUsd > 0 && amount.amountUsd < milestone.amountUsd) {
      await recordEvidence({
        provider: options.provider,
        providerEventId: options.providerEventId,
        eventType: options.eventType,
        outcome: 'REJECTED',
        rejectionReason: `underpayment: ${amount.amountUsd} < milestone ${milestone.amountUsd}`,
        signatureVerified: true,
        verificationMethod: 'PROVIDER_WEBHOOK',
        amountUsd: amount.amountUsd,
        currency: amount.currency,
        engagementId,
        milestoneId,
        surface,
      });
      return {
        ok: false, status: 400,
        error: `Payment of ${amount.amountUsd} does not cover the milestone amount of ${milestone.amountUsd}.`,
      };
    }
  }

  // --- Record, then apply -------------------------------------------------
  const recorded = await recordEvidence({
    provider: options.provider,
    providerEventId: options.providerEventId,
    eventType: options.eventType,
    outcome: 'RECORDED',
    signatureVerified: true,
    verificationMethod: 'PROVIDER_WEBHOOK',
    amountUsd: amount.amountUsd,
    currency: amount.currency,
    engagementId,
    milestoneId,
    offerId: typeof options.offerId === 'string' ? options.offerId : null,
    evidenceRefs: options.evidenceRefs,
    surface,
  });

  if (recorded.duplicate) {
    // A replay must NOT re-apply the state transition.
    return { ok: true, duplicate: true, replay: true, paymentEventId: recorded.paymentEventId };
  }

  // Milestone-level verification.
  if (milestoneId) {
    await db.milestone.update({
      where: { id: milestoneId },
      data: {
        paymentState: 'PAYMENT_VERIFIED',
        verificationSource: 'PROVIDER_WEBHOOK',
        providerRef: options.providerEventId,
        verifiedAt: new Date(),
      },
    });
  }

  // Engagement-level verification: the transition table still governs this.
  const engagement = await db.serviceEngagement.findUnique({
    where: { id: engagementId },
    select: { state: true },
  });
  let appliedEngagementState: string | null = null;
  if (engagement && (engagement.state === 'PAYMENT_REQUIRED' || engagement.state === 'PAYMENT_PENDING'
    || engagement.state === 'FINAL_PAYMENT_REQUIRED')) {
    await db.serviceEngagement.update({
      where: { id: engagementId },
      data: {
        state: 'PAYMENT_VERIFIED',
        paymentState: 'PAYMENT_VERIFIED',
        verificationSource: 'PROVIDER_WEBHOOK',
        providerRef: options.providerEventId,
        verifiedAt: new Date(),
      },
    });
    appliedEngagementState = 'PAYMENT_VERIFIED';
  }

  await auditSecurityEvent({
    kind: 'COMMERCIAL_PAYMENT_VERIFIED',
    surface,
    outcome: 'ok',
    detail:
      `engagement=${engagementId.slice(0, 12)} milestone=${milestoneId ? milestoneId.slice(0, 12) : 'none'} `
      + `amount=$${amount.amountUsd} ${amount.currency} method=PROVIDER_WEBHOOK`,
  });

  return {
    ok: true,
    paymentEventId: recorded.paymentEventId,
    amountUsd: amount.amountUsd,
    currency: amount.currency,
    engagementState: appliedEngagementState,
  };
}

// ---------------------------------------------------------------------------
// 11.4 — Controlled manual admin verification
// ---------------------------------------------------------------------------

/**
 * MANUAL_ADMIN_APPROVED as a *controlled* review path.
 *
 * Requires: an authenticated admin caller, a named reviewer, a reason, real
 * evidence references, a timestamp, and a positive amount — all validated by
 * validateManualReview. It is idempotent on (engagement, milestone, provider
 * reference), so re-running the same review is a no-op rather than a second
 * approval. Refunds and chargebacks are NEVER reachable here: those are
 * financial actions a human performs in the provider, and the system only
 * records the outcome.
 */
export async function recordManualPaymentVerification(options: {
  engagementId: unknown;
  milestoneId?: unknown;
  providerRef: unknown;
  reviewer: unknown;
  reason: unknown;
  evidenceRefs: unknown;
  amountUsd: unknown;
  currency?: unknown;
  approved: boolean;
  surface?: string;
}): Promise<PaymentResult> {
  const surface = options.surface ?? SURFACE;

  // A reviewer must be an authenticated admin identity — a free-text name is
  // not a reviewer.
  if (typeof options.reviewer !== 'string' || options.reviewer.trim().length === 0) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_VERIFY_REFUSED',
      surface,
      outcome: 'refused',
      detail: 'manual verification refused: no authenticated reviewer identity',
    });
    return { ok: false, status: 400, error: 'A manual verification requires an authenticated admin reviewer.' };
  }
  if (typeof options.providerRef !== 'string' || options.providerRef.trim().length === 0) {
    return { ok: false, status: 400, error: 'providerRef is required (the real provider reference you examined).' };
  }

  const review = validateManualReview({
    reviewer: options.reviewer,
    reason: options.reason,
    evidenceRefs: options.evidenceRefs,
    reviewedAt: new Date(),
  });
  if (!review.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_VERIFY_REFUSED',
      surface,
      outcome: 'refused',
      detail: `manual verification refused: missing ${review.missing.join(',') || 'review attributes'}`,
    });
    return { ok: false, status: 400, error: review.reason };
  }

  const amount = validatePaymentAmount({ amount: options.amountUsd, currency: options.currency });
  if (!amount.ok) return { ok: false, status: 400, error: amount.reason };

  const engagementId = typeof options.engagementId === 'string' && options.engagementId.length > 0
    ? options.engagementId
    : null;
  if (!engagementId) return { ok: false, status: 400, error: 'engagementId is required.' };

  const engagement = await db.serviceEngagement.findUnique({
    where: { id: engagementId },
    select: { id: true, state: true, currency: true },
  });
  if (!engagement) return { ok: false, status: 404, error: 'Engagement not found.' };

  const milestoneId = typeof options.milestoneId === 'string' && options.milestoneId.length > 0
    ? options.milestoneId
    : null;
  if (milestoneId) {
    const milestone = await db.milestone.findUnique({
      where: { id: milestoneId },
      select: { id: true, engagementId: true, amountUsd: true },
    });
    if (!milestone) return { ok: false, status: 404, error: 'Milestone not found.' };
    if (milestone.engagementId !== engagementId) {
      return { ok: false, status: 400, error: 'Milestone does not belong to this engagement.' };
    }
  }

  const idempotencyKey = manualReviewIdempotencyKey({
    engagementId,
    milestoneId,
    providerRef: options.providerRef,
  });

  // Idempotent: the same review recorded twice is one review.
  const existing = await db.manualPaymentVerification.findUnique({
    where: { idempotencyKey },
    select: { id: true, outcome: true },
  });
  if (existing) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_MANUAL_DUPLICATE',
      surface,
      outcome: 'ok',
      detail: `idempotent replay of manual review ${existing.id.slice(0, 12)} (${existing.outcome})`,
    });
    return { ok: true, verificationId: existing.id, duplicate: true, outcome: existing.outcome };
  }

  // The evidence verdict still runs: MANUAL_ADMIN_APPROVED is a method, and it
  // only counts when the review attributes are present (validated above).
  const verdict = classifyPaymentEvidence({
    method: 'MANUAL_ADMIN_APPROVED',
  });
  if (!verdict.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_VERIFY_REFUSED',
      surface,
      outcome: 'refused',
      detail: verdict.reason.slice(0, 100),
    });
    return { ok: false, status: 400, error: verdict.reason };
  }

  const approved = options.approved === true;
  const record = await db.manualPaymentVerification.create({
    data: {
      engagementId,
      milestoneId,
      reviewer: review.reviewer,
      reviewedAt: review.reviewedAt,
      reason: review.reason,
      evidenceRefs: JSON.stringify(review.evidenceRefs).slice(0, 2_000),
      amountUsd: amount.amountUsd,
      currency: amount.currency,
      outcome: approved ? 'APPROVED' : 'REFUSED',
      idempotencyKey,
    },
  });

  if (!approved) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_MANUAL_REFUSED',
      surface,
      outcome: 'refused',
      detail: `reviewer=${review.reviewer.slice(0, 40)} engagement=${engagementId.slice(0, 12)} — review recorded as REFUSED`,
    });
    return { ok: true, verificationId: record.id, outcome: 'REFUSED' };
  }

  // Approved: record the evidence ledger row, then apply governed state.
  const recorded = await recordEvidence({
    provider: 'MANUAL',
    providerEventId: options.providerRef,
    eventType: 'manual.verified',
    outcome: 'RECORDED',
    signatureVerified: false,
    verificationMethod: 'MANUAL_ADMIN_APPROVED',
    amountUsd: amount.amountUsd,
    currency: amount.currency,
    engagementId,
    milestoneId,
    evidenceRefs: review.evidenceRefs,
    surface,
  });

  if (milestoneId) {
    const milestone = await db.milestone.findUnique({
      where: { id: milestoneId },
      select: { paymentState: true },
    });
    if (milestone && (milestone.paymentState === 'PAYMENT_REQUIRED' || milestone.paymentState === 'PAYMENT_PENDING')) {
      await db.milestone.update({
        where: { id: milestoneId },
        data: {
          paymentState: 'PAYMENT_VERIFIED',
          verificationSource: 'MANUAL_ADMIN_APPROVED',
          providerRef: options.providerRef,
          verifiedAt: new Date(),
        },
      });
    }
  }

  if (
    engagement.state === 'PAYMENT_REQUIRED'
    || engagement.state === 'PAYMENT_PENDING'
    || engagement.state === 'FINAL_PAYMENT_REQUIRED'
  ) {
    await db.serviceEngagement.update({
      where: { id: engagementId },
      data: {
        state: 'PAYMENT_VERIFIED',
        paymentState: 'PAYMENT_VERIFIED',
        verificationSource: 'MANUAL_ADMIN_APPROVED',
        providerRef: options.providerRef,
        verifiedAt: new Date(),
      },
    });
  }

  await auditSecurityEvent({
    kind: 'COMMERCIAL_PAYMENT_VERIFIED',
    surface,
    outcome: 'ok',
    detail:
      `engagement=${engagementId.slice(0, 12)} amount=$${amount.amountUsd} `
      + `method=MANUAL_ADMIN_APPROVED reviewer=${review.reviewer.slice(0, 30)}`,
  });

  return {
    ok: true,
    verificationId: record.id,
    paymentEventId: recorded.paymentEventId,
    outcome: 'APPROVED',
    amountUsd: amount.amountUsd,
    currency: amount.currency,
  };
}

// ---------------------------------------------------------------------------
// 11.4 — Refund / chargeback / reversal
// ---------------------------------------------------------------------------

/**
 * Apply a verified reversal event. A refund must NOT leave the engagement
 * silently "paid": the milestone drops out of PAYMENT_VERIFIED, the engagement
 * paymentState drops to REFUNDED, and recognized revenue is reduced.
 */
export async function applyVerifiedReversalEvent(options: {
  provider: string;
  providerEventId: unknown;
  eventType: unknown;
  signatureVerified: boolean;
  amount?: unknown;
  currency?: unknown;
  amountUnit?: 'MAJOR' | 'MINOR';
  engagementId?: unknown;
  milestoneId?: unknown;
  outcome?: unknown;
  reason?: unknown;
  surface?: string;
}): Promise<PaymentResult> {
  const surface = options.surface ?? SURFACE;
  const providerEventId = typeof options.providerEventId === 'string' ? options.providerEventId.trim() : '';
  if (providerEventId.length === 0) return { ok: false, status: 400, error: 'providerEventId is required.' };
  if (typeof options.eventType !== 'string' || !isReversalEventType(options.eventType)) {
    return { ok: false, status: 400, error: 'eventType must be a recognized reversal event type.' };
  }
  if (options.signatureVerified !== true) {
    return { ok: false, status: 400, error: 'A reversal requires a verified provider signature.' };
  }

  const engagementId = typeof options.engagementId === 'string' && options.engagementId.length > 0
    ? options.engagementId
    : null;
  if (!engagementId) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PAYMENT_VERIFY_REFUSED',
      surface,
      outcome: 'refused',
      detail: `reversal ${providerEventId.slice(0, 30)} had no engagement target; nothing changed`,
    });
    return { ok: false, status: 400, error: 'A reversal must identify the engagement it reverses.' };
  }

  const outcome: ReversalOutcome = options.outcome === 'PARTIALLY_REFUNDED' ? 'PARTIALLY_REFUNDED' : 'REFUNDED';

  const recorded = await recordEvidence({
    provider: options.provider,
    providerEventId,
    eventType: options.eventType,
    outcome: 'REVERSED',
    signatureVerified: true,
    verificationMethod: 'PROVIDER_WEBHOOK',
    engagementId,
    milestoneId: typeof options.milestoneId === 'string' ? options.milestoneId : null,
    reversalReason: typeof options.reason === 'string' ? options.reason : '',
    surface,
  });
  if (recorded.duplicate) {
    return { ok: true, duplicate: true, replay: true, paymentEventId: recorded.paymentEventId };
  }

  const refundUsd = typeof options.amount === 'number'
    ? (options.amountUnit === 'MINOR' ? options.amount / 100 : options.amount)
    : 0;

  // Reduce recognized revenue on the linked rows. Revenue is never negative.
  const rows = await db.revenue.findMany({
    where: { serviceEngagementId: engagementId },
    select: { id: true, recognizedUsd: true, revenueBasis: true },
  });
  let remaining = outcome === 'PARTIALLY_REFUNDED' ? Math.max(0, refundUsd) : Number.POSITIVE_INFINITY;
  for (const row of rows) {
    // Only ACTUAL rows carry recognized value; estimates are never netted down
    // as if they had been earned.
    if (row.revenueBasis !== 'ACTUAL') continue;
    const next = recognizedRevenueAfterReversal({
      recognizedUsd: row.recognizedUsd,
      refundUsd: Number.isFinite(remaining) ? remaining : Number.POSITIVE_INFINITY,
      outcome: outcome === 'PARTIALLY_REFUNDED' ? 'PARTIALLY_REFUNDED' : 'REFUNDED',
    });
    await db.revenue.update({
      where: { id: row.id },
      data: { recognizedUsd: next.recognizedUsd, refundTotalUsd: next.refundTotalUsd },
    });
    if (Number.isFinite(remaining)) {
      remaining = Math.max(0, remaining - next.refundTotalUsd);
      if (remaining === 0) break;
    }
  }

  // The milestone must stop reporting as paid.
  if (typeof options.milestoneId === 'string' && options.milestoneId.length > 0) {
    await db.milestone.update({
      where: { id: options.milestoneId },
      data: { paymentState: outcome === 'PARTIALLY_REFUNDED' ? 'PARTIALLY_REFUNDED' : 'REFUNDED' },
    });
  }

  // The engagement must stop reporting as paid.
  await db.serviceEngagement.update({
    where: { id: engagementId },
    data: { paymentState: outcome === 'PARTIALLY_REFUNDED' ? 'REFUNDED' : 'REFUNDED' },
  });

  await auditSecurityEvent({
    kind: 'COMMERCIAL_PAYMENT_REVERSED',
    surface,
    outcome: 'ok',
    detail: `engagement=${engagementId.slice(0, 12)} outcome=${outcome} event=${providerEventId.slice(0, 30)}`,
  });

  return { ok: true, reversalOutcome: outcome, paymentEventId: recorded.paymentEventId };
}

// ---------------------------------------------------------------------------
// Read: truthful payment posture for an engagement
// ---------------------------------------------------------------------------

export async function getPaymentPosture(engagementId: unknown) {
  if (typeof engagementId !== 'string' || engagementId.length === 0) return null;
  const engagement = await db.serviceEngagement.findUnique({
    where: { id: engagementId },
    select: {
      id: true, state: true, paymentState: true, verificationSource: true,
      providerRef: true, verifiedAt: true, currency: true,
    },
  });
  if (!engagement) return null;
  const events = await db.paymentEvent.findMany({
    where: { engagementId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true, provider: true, eventType: true, outcome: true, amountUsd: true,
      currency: true, signatureVerified: true, verificationMethod: true, createdAt: true, rejectionReason: true,
    },
  });
  const reviews = await db.manualPaymentVerification.findMany({
    where: { engagementId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, reviewer: true, outcome: true, amountUsd: true, currency: true, reviewedAt: true },
  });
  return { engagement, paymentEvents: events, manualVerifications: reviews };
}
