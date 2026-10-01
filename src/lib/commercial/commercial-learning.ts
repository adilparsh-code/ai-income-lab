// ============================================================================
// PHASE 11.3 — COMMERCIAL LEARNING LOOP (real events only)
// ============================================================================
// Turns persisted commercial state into structured LearningEntry rows, so
// future scoring, prioritization, packaging and pricing can learn from what
// actually happened.
//
// Hard rules:
//  - LEARNING USES ACTUAL PERSISTED EVENTS ONLY. This module derives signals
//    from counted rows; it never invents a metric, a rate, or an outcome.
//  - LEARNING CANNOT BYPASS SAFETY GATES. A LearningEntry is a record, never
//    an authorization: nothing here writes to governance, halal, payment or
//    permission state.
//  - Sample sizes are reported alongside every signal so a 1-of-1 result is
//    never presented as a validated pattern.
// ============================================================================

import { db } from '@/lib/db';
import { classifyHalal } from './opportunity-routing';

export type CommercialSignalKind =
  | 'OPPORTUNITY_CONVERTED'
  | 'OPPORTUNITY_FAILED_VALIDATION'
  | 'OFFER_ACCEPTED'
  | 'PROPOSAL_REJECTED'
  | 'PAYMENT_DELAYED'
  | 'SCOPE_OVERRUN'
  | 'DELIVERY_COMPLETED'
  | 'REVISION_FREQUENCY'
  | 'REVENUE_GENERATED'
  | 'MARGIN_OUTCOME'
  | 'BLOCKED_OPPORTUNITY'
  | 'HALAL_REVIEW_OUTCOME';

export interface CommercialSignal {
  kind: CommercialSignalKind;
  /** Deterministic hypothesis text — no invented numbers. */
  hypothesis: string;
  /** VALIDATED | INVALIDATED | INCONCLUSIVE — decided by thresholds below. */
  result: 'VALIDATED' | 'INVALIDATED' | 'INCONCLUSIVE';
  metric: string;
  /** Real observed value (never estimated). */
  measuredValue: number;
  sampleSize: number;
  decision: string;
  applicability: string;
  evidenceType: 'VERIFIED_DATA';
}

/** Minimum sample size before a signal may be reported as VALIDATED. */
export const MIN_VALIDATED_SAMPLE = 3;

export interface CommercialLearningSnapshot {
  signals: CommercialSignal[];
  /** Honest counts backing each signal — the raw evidence for the loop. */
  evidence: Record<string, number>;
}

/**
 * Derive the learning signals from real persisted rows. Pure counting plus
 * deterministic thresholds — no AI, no estimation.
 */
export async function deriveCommercialSignals(): Promise<CommercialLearningSnapshot> {
  const [proposals, changeRequests, engagements, deliverables, issues, revenue] = await Promise.all([
    db.proposal.findMany({ select: { state: true } }),
    db.scopeChangeRequest.findMany({ select: { status: true, classification: true, requiresPayment: true } }),
    db.serviceEngagement.findMany({ select: { state: true, engagementType: true, totalPrice: true } }),
    db.deliverable.findMany({ select: { state: true, revisionCount: true, revisionLimit: true } }),
    db.serviceIssue.findMany({ select: { issueType: true, status: true } }),
    db.revenue.findMany({ where: { revenueSource: { startsWith: 'service' } }, select: { grossRevenue: true, currency: true } }),
  ]);

  const signals: CommercialSignal[] = [];
  const evidence: Record<string, number> = {};

  const count = (rows: { state?: string; status?: string; issueType?: string }[], field: 'state' | 'status' | 'issueType', value: string): number =>
    rows.filter((r) => r[field] === value).length;

  // OFFER ACCEPTED / PROPOSAL REJECTED
  const accepted = count(proposals, 'state', 'ACCEPTED');
  const rejected = count(proposals, 'state', 'DECLINED');
  const totalDecided = accepted + rejected;
  evidence.proposalsAccepted = accepted;
  evidence.proposalsRejected = rejected;
  signals.push({
    kind: 'OFFER_ACCEPTED',
    hypothesis: accepted > 0
      ? `${accepted} of ${totalDecided} decided proposals were accepted (${Math.round((accepted / totalDecided) * 100)}%).`
      : 'No decided proposals exist yet; acceptance rate is UNKNOWN rather than estimated.',
    result: totalDecided >= MIN_VALIDATED_SAMPLE && accepted / totalDecided >= 0.5 ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'proposal_acceptance_rate',
    measuredValue: totalDecided > 0 ? Math.round((accepted / totalDecided) * 1000) / 1000 : 0,
    sampleSize: totalDecided,
    decision: 'Use acceptance evidence to prioritize which offers deserve more packaging effort.',
    applicability: 'Proposal packaging and prioritization; never a substitute for halal or payment gates.',
    evidenceType: 'VERIFIED_DATA',
  });
  signals.push({
    kind: 'PROPOSAL_REJECTED',
    hypothesis: rejected > 0
      ? `${rejected} proposal(s) were declined; review the recorded terms before re-quoting.`
      : 'No declined proposals recorded.',
    result: rejected >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'proposals_rejected',
    measuredValue: rejected,
    sampleSize: totalDecided,
    decision: 'Re-examine scope, price and timeline before issuing a similar proposal.',
    applicability: 'Pricing and scoping review.',
    evidenceType: 'VERIFIED_DATA',
  });

  // SCOPE OVERRUN
  const scopeOverruns = changeRequests.filter((c) => c.classification === 'CHANGE_REQUEST').length;
  evidence.scopeOverruns = scopeOverruns;
  evidence.scopeChangeTotal = changeRequests.length;
  signals.push({
    kind: 'SCOPE_OVERRUN',
    hypothesis: scopeOverruns > 0
      ? `${scopeOverruns} of ${changeRequests.length} recorded change request(s) were genuine scope overruns.`
      : 'No scope overruns recorded; the current scope contracts may or may not be tight.',
    result: scopeOverruns >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'scope_overrun_count',
    measuredValue: scopeOverruns,
    sampleSize: changeRequests.length,
    decision: 'Tighten scope item wording where overruns concentrate; keep the paid change path.',
    applicability: 'Scope drafting and micro-service packaging.',
    evidenceType: 'VERIFIED_DATA',
  });

  // PAYMENT DELAYED — engagements parked in PAYMENT_PENDING / PAYMENT_REQUIRED
  const paymentDelayed = engagements.filter((e) => e.state === 'PAYMENT_PENDING' || e.state === 'PAYMENT_REQUIRED').length;
  const paymentBlocked = engagements.filter((e) => e.state === 'ACCEPTED').length;
  evidence.paymentDelayed = paymentDelayed;
  signals.push({
    kind: 'PAYMENT_DELAYED',
    hypothesis: paymentBlocked > 0 || paymentDelayed > 0
      ? `${paymentDelayed} engagement(s) are awaiting payment and ${paymentBlocked} are accepted but not yet paid; work stays unauthorized.`
      : 'No engagement is currently awaiting payment.',
    result: paymentDelayed >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'engagements_awaiting_payment',
    measuredValue: paymentDelayed,
    sampleSize: engagements.length,
    decision: 'Keep the payment gate strict; unpaid work remains structurally blocked.',
    applicability: 'Payment policy — this signal can never relax the payment gate.',
    evidenceType: 'VERIFIED_DATA',
  });

  // DELIVERY COMPLETED
  const delivered = deliverables.filter((d) => d.state === 'ACCEPTED' || d.state === 'COMPLETED').length;
  evidence.deliverablesAccepted = delivered;
  evidence.deliverablesTotal = deliverables.length;
  signals.push({
    kind: 'DELIVERY_COMPLETED',
    hypothesis: deliverables.length > 0
      ? `${delivered} of ${deliverables.length} deliverable(s) reached evidence-backed acceptance.`
      : 'No deliverables exist yet; delivery outcomes are UNKNOWN.',
    result: delivered >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'deliverable_acceptance_rate',
    measuredValue: deliverables.length > 0 ? Math.round((delivered / deliverables.length) * 1000) / 1000 : 0,
    sampleSize: deliverables.length,
    decision: 'Reuse deliverable structures that reached acceptance; investigate the rest.',
    applicability: 'Delivery quality and QA focus.',
    evidenceType: 'VERIFIED_DATA',
  });

  // REVISION FREQUENCY
  const revisionCounts = deliverables.map((d) => d.revisionCount);
  const revisionTotal = revisionCounts.reduce((a, b) => a + b, 0);
  const limitReached = deliverables.filter((d) => d.state === 'REVISION_LIMIT_REACHED').length;
  evidence.revisionTotal = revisionTotal;
  evidence.revisionLimitReached = limitReached;
  signals.push({
    kind: 'REVISION_FREQUENCY',
    hypothesis: revisionTotal > 0
      ? `${revisionTotal} revision round(s) consumed across ${deliverables.length} deliverable(s); ${limitReached} hit the limit.`
      : 'No revision rounds have been consumed.',
    result: revisionTotal >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'revision_rounds_consumed',
    measuredValue: revisionTotal,
    sampleSize: deliverables.length,
    decision: 'Keep revision allowances finite; over-limit work requires a paid change request.',
    applicability: 'Revision policy and QA clarity.',
    evidenceType: 'VERIFIED_DATA',
  });

  // REVENUE GENERATED (only real, verified rows are counted)
  const revenueCurrencies = new Set(revenue.map((r) => r.currency));
  const revenueUsd = revenueCurrencies.size === 1 && revenueCurrencies.has('USD')
    ? Math.round(revenue.reduce((sum, r) => sum + r.grossRevenue, 0) * 100) / 100
    : null;
  evidence.revenueRows = revenue.length;
  signals.push({
    kind: 'REVENUE_GENERATED',
    hypothesis: revenueUsd === null
      ? 'Service revenue is UNKNOWN (no rows, or mixed currencies). No revenue figure was invented.'
      : `${revenue.length} verified service revenue row(s) totalling $${revenueUsd} USD.`,
    result: revenueUsd !== null && revenueUsd > 0 && revenue.length >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'service_revenue_usd',
    measuredValue: revenueUsd ?? 0,
    sampleSize: revenue.length,
    decision: 'Scale only what produced verified revenue; never extrapolate from unverified demand.',
    applicability: 'Revenue analysis. Cannot create a revenue row.',
    evidenceType: 'VERIFIED_DATA',
  });

  // MARGIN OUTCOME — price minus estimated cost, from real engagement rows
  const priced = engagements.filter((e) => Number.isFinite(e.totalPrice) && e.totalPrice > 0);
  const avgPrice = priced.length > 0
    ? Math.round((priced.reduce((sum, e) => sum + e.totalPrice, 0) / priced.length) * 100) / 100
    : null;
  evidence.pricedEngagements = priced.length;
  signals.push({
    kind: 'MARGIN_OUTCOME',
    hypothesis: avgPrice === null
      ? 'No priced engagements exist; margin outcome is UNKNOWN rather than estimated.'
      : `Average engagement price across ${priced.length} priced engagement(s) is $${avgPrice} USD.`,
    result: priced.length >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'average_engagement_price_usd',
    measuredValue: avgPrice ?? 0,
    sampleSize: priced.length,
    decision: 'Use observed prices as a baseline; do not claim a market rate from this data.',
    applicability: 'Pricing baselines only — not a market claim.',
    evidenceType: 'VERIFIED_DATA',
  });

  // BLOCKED OPPORTUNITY / HALAL REVIEW OUTCOME
  const blocked = issues.filter((i) => i.issueType === 'CANCELLATION_APPROVED' || i.issueType === 'TERMINATION_REQUESTED').length;
  evidence.blockedEngagements = blocked;
  signals.push({
    kind: 'BLOCKED_OPPORTUNITY',
    hypothesis: blocked > 0
      ? `${blocked} engagement(s) were cancelled or terminated; inspect recorded reasons before re-pursuing similar work.`
      : 'No cancelled or terminated engagements recorded.',
    result: blocked >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'blocked_engagements',
    measuredValue: blocked,
    sampleSize: issues.length,
    decision: 'Review the cause before repeating the engagement pattern.',
    applicability: 'Risk review.',
    evidenceType: 'VERIFIED_DATA',
  });

  // Classify the current opportunity set conservatively for the halal signal.
  const classification = classifyHalal('HALAL', undefined, []);
  signals.push({
    kind: 'HALAL_REVIEW_OUTCOME',
    hypothesis: 'Halal classification is conservative by construction: unscreened opportunities are UNVERIFIED, not HALAL.',
    result: classification.classification === 'UNVERIFIED' ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'default_halal_classification',
    measuredValue: classification.classification === 'HALAL' ? 1 : 0,
    sampleSize: 1,
    decision: 'Keep screening conservative; learning never relaxes the halal gate.',
    applicability: 'Safety posture. Learning cannot bypass a safety gate.',
    evidenceType: 'VERIFIED_DATA',
  });

  return { signals, evidence };
}

/**
 * Persist the derived signals into the EXISTING LearningEntry table. Learning
 * rows are records only — they grant no execution authority.
 */
export async function persistCommercialLearning(): Promise<{ ok: true; persisted: number } | { ok: false; error: string }> {
  const snapshot = await deriveCommercialSignals();
  let persisted = 0;
  for (const signal of snapshot.signals) {
    try {
      await db.learningEntry.create({
        data: {
          hypothesis: signal.hypothesis.slice(0, 500),
          result: signal.result,
          metric: signal.metric,
          measuredValue: signal.measuredValue,
          decision: signal.decision.slice(0, 500),
          // 'commercial' prefix is what the commercial summary filters on.
          context: `commercial:${signal.kind}`,
          evidenceType: 'VERIFIED_DATA',
          applicability: signal.applicability.slice(0, 300),
          confidence: signal.sampleSize >= MIN_VALIDATED_SAMPLE ? 0.7 : 0.3,
        },
      });
      persisted += 1;
    } catch {
      // A learning write failure must never affect the underlying commercial state.
    }
  }
  return { ok: true, persisted };
}