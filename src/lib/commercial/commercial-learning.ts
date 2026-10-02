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
  const [proposals, changeRequests, engagements, deliverables, revenue, costs, blockedOffers, unverifiedOffers] = await Promise.all([
    db.proposal.findMany({ select: { state: true } }),
    db.scopeChangeRequest.findMany({ select: { status: true, classification: true, requiresPayment: true } }),
    db.serviceEngagement.findMany({ select: { id: true, state: true, engagementType: true, totalPrice: true } }),
    db.deliverable.findMany({ select: { state: true, revisionCount: true, revisionLimit: true } }),
    db.revenue.findMany({
      where: { revenueSource: { startsWith: 'service' }, revenueBasis: 'ACTUAL' },
      select: { grossRevenue: true, currency: true, serviceEngagementId: true },
    }),
    // PHASE 11.7: revenue AND cost per engagement, so MARGIN_OUTCOME can be a
    // real margin instead of a rename of price.
    db.engagementCost.findMany({ select: { engagementId: true, amountUsd: true, basis: true } }),
    db.offer.findMany({ where: { status: 'BLOCKED' }, select: { id: true } }),
    db.offer.findMany({ where: { halalStatus: 'UNVERIFIED' }, select: { id: true } }),
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
  // PHASE 11.7 FIX: only ACTUAL-basis service revenue counts as earned.
  // ESTIMATED / PROJECTED / SIMULATED rows are excluded here so a plan can
  // never be learned from as though it were income.
  const actualServiceRevenue = revenue.filter((r) => (r as { revenueBasis?: string }).revenueBasis === 'ACTUAL');
  const revenueCurrencies = new Set(actualServiceRevenue.map((r) => r.currency));
  const revenueUsd = revenueCurrencies.size === 1 && revenueCurrencies.has('USD')
    ? Math.round(actualServiceRevenue.reduce((sum, r) => sum + r.grossRevenue, 0) * 100) / 100
    : null;
  evidence.revenueRows = actualServiceRevenue.length;
  signals.push({
    kind: 'REVENUE_GENERATED',
    hypothesis: revenueUsd === null
      ? 'Service revenue is UNKNOWN (no ACTUAL rows, or mixed currencies). No revenue figure was invented.'
      : `${actualServiceRevenue.length} verified ACTUAL service revenue row(s) totalling $${revenueUsd} USD.`,
    result: revenueUsd !== null && revenueUsd > 0 && actualServiceRevenue.length >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'service_revenue_usd',
    measuredValue: revenueUsd ?? 0,
    sampleSize: actualServiceRevenue.length,
    decision: 'Scale only what produced verified revenue; never extrapolate from unverified demand.',
    applicability:
      'Revenue analysis. Cannot create a revenue row, and estimates/projections/simulations are excluded from '
      + 'this figure by construction.',
    evidenceType: 'VERIFIED_DATA',
  });

  // MARGIN OUTCOME — a REAL margin: recognized ACTUAL revenue minus ACTUAL cost.
  //
  // PHASE 11.7 FIX: this previously measured average PRICE and called it a
  // margin, which is just revenue under a different name. Margin now requires
  // both an ACTUAL revenue row and an ACTUAL cost row for the same engagement;
  // an engagement with no recorded cost has margin UNKNOWN, not zero.
  const actualCostByEngagement = new Map<string, number>();
  for (const cost of costs) {
    if (cost.basis !== 'ACTUAL') continue; // estimates never enter a margin
    actualCostByEngagement.set(
      cost.engagementId,
      (actualCostByEngagement.get(cost.engagementId) ?? 0) + cost.amountUsd,
    );
  }
  const realizedByEngagement = new Map<string, number>();
  for (const row of revenue) {
    if (!row.serviceEngagementId) continue;
    realizedByEngagement.set(
      row.serviceEngagementId,
      (realizedByEngagement.get(row.serviceEngagementId) ?? 0) + row.grossRevenue,
    );
  }
  const marginSamples: { engagementId: string; profit: number; revenue: number }[] = [];
  for (const [engagementId, revenueUsd] of realizedByEngagement) {
    const costUsd = actualCostByEngagement.get(engagementId);
    // Both sides must be real. No cost recorded ⇒ margin UNKNOWN, never 0.
    if (costUsd === undefined || revenueUsd <= 0) continue;
    marginSamples.push({ engagementId, revenue: revenueUsd, profit: revenueUsd - costUsd });
  }
  const avgMargin = marginSamples.length > 0
    ? Math.round((marginSamples.reduce((s, m) => s + (m.profit / m.revenue), 0) / marginSamples.length) * 10000) / 10000
    : null;
  evidence.marginSamples = marginSamples.length;
  evidence.engagementsWithActualCost = actualCostByEngagement.size;
  signals.push({
    kind: 'MARGIN_OUTCOME',
    hypothesis: avgMargin === null
      ? 'No engagement has BOTH realized ACTUAL revenue and a recorded ACTUAL cost, so margin is UNKNOWN '
        + 'rather than assumed to be zero.'
      : `Across ${marginSamples.length} engagement(s) with realized revenue and recorded actual cost, the `
        + `mean realized margin is ${(avgMargin! * 100).toFixed(1)}%.`,
    result: marginSamples.length >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'mean_realized_margin_ratio',
    measuredValue: avgMargin ?? 0,
    sampleSize: marginSamples.length,
    decision:
      'Margin is only known where an actual cost was recorded. Record costs before using this signal to '
      + 'set prices.',
    applicability:
      'Pricing and packaging decisions. Derived from ACTUAL rows only; estimated costs are excluded, so this '
      + 'under-reports rather than over-reports when costs are missing.',
    evidenceType: 'VERIFIED_DATA',
  });

  // OPPORTUNITY CONVERTED / FAILED VALIDATION
  //
  // PHASE 11.7 FIX: these two kinds were declared but never emitted, which made
  // conversion learning structurally impossible. They are now derived from real
  // engagement rows linked to an opportunity.
  const opportunitiesWithEngagements = engagements.filter((e) => e.state === 'COMPLETED');
  const opportunitiesRejected = engagements.filter(
    (e) => e.state === 'CANCELLED' || e.state === 'TERMINATED' || e.state === 'NO_COMMITMENT',
  );
  const decidedOpportunities = opportunitiesWithEngagements.length + opportunitiesRejected.length;
  evidence.opportunitiesConverted = opportunitiesWithEngagements.length;
  evidence.opportunitiesNotConverted = opportunitiesRejected.length;
  signals.push({
    kind: 'OPPORTUNITY_CONVERTED',
    hypothesis: decidedOpportunities === 0
      ? 'No opportunity has reached a decided outcome yet; conversion is UNKNOWN rather than estimated.'
      : `${opportunitiesWithEngagements.length} of ${decidedOpportunities} decided engagement(s) reached `
        + 'COMPLETED delivery.',
    result: opportunitiesWithEngagements.length >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'opportunity_completion_count',
    measuredValue: opportunitiesWithEngagements.length,
    sampleSize: decidedOpportunities,
    decision:
      'Investigate why non-completed engagements stopped before completion before pursuing similar opportunities.',
    applicability: 'Opportunity selection. Never relaxes halal, payment or authorization gates.',
    evidenceType: 'VERIFIED_DATA',
  });
  signals.push({
    kind: 'OPPORTUNITY_FAILED_VALIDATION',
    hypothesis: opportunitiesRejected.length > 0
      ? `${opportunitiesRejected.length} engagement(s) ended without delivery (cancelled, terminated, or never `
        + 'committed); their recorded causes are the validation evidence.'
      : 'No engagement has failed validation.',
    result: opportunitiesRejected.length >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'opportunity_failed_validation_count',
    measuredValue: opportunitiesRejected.length,
    sampleSize: decidedOpportunities,
    decision:
      'Read the recorded ServiceIssue causes before re-pursuing an opportunity that previously failed.',
    applicability: 'Opportunity selection and risk review.',
    evidenceType: 'VERIFIED_DATA',
  });

  // BLOCKED OPPORTUNITY
  //
  // PHASE 11.7 FIX: this counted ServiceIssue rows for CANCELLATION_APPROVED /
  // TERMINATION_REQUESTED, which counts ISSUES rather than blocked
  // OPPORTUNITIES and so could never see a genuinely blocked opportunity. It
  // now counts real blocked work: BLOCKED offers plus unscreened offers.
  const blockedOpportunityCount = blockedOffers.length + unverifiedOffers.length;
  evidence.blockedOffers = blockedOffers.length;
  evidence.unverifiedOffers = unverifiedOffers.length;
  evidence.blockedOpportunities = blockedOpportunityCount;
  signals.push({
    kind: 'BLOCKED_OPPORTUNITY',
    hypothesis: blockedOpportunityCount > 0
      ? `${blockedOffers.length} offer(s) are BLOCKED and ${unverifiedOffers.length} remain UNVERIFIED. `
        + 'Unscreened work is not treated as permitted work.'
      : 'No blocked or unscreened offers recorded.',
    result: blockedOpportunityCount >= MIN_VALIDATED_SAMPLE ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'blocked_or_unscreened_offer_count',
    measuredValue: blockedOpportunityCount,
    sampleSize: blockedOffers.length + unverifiedOffers.length,
    decision:
      'Screen every offer before it can back an engagement. An UNVERIFIED offer is refused at engagement '
      + 'creation, so this count should stay at zero for work that is actually executed.',
    applicability: 'Safety posture. This signal can never relax the halal gate.',
    evidenceType: 'VERIFIED_DATA',
  });

  // HALAL REVIEW OUTCOME
  //
  // PHASE 11.7 FIX: this previously hardcoded classifyHalal('HALAL', …) and then
  // stamped the result VERIFIED_DATA, i.e. it asserted a halal verdict out of
  // nothing. It now reports the REAL distribution of persisted offer verdicts.
  const offerHalalCounts = await db.offer.groupBy({ by: ['halalStatus'], _count: { _all: true } });
  const halalDistribution: Record<string, number> = {};
  for (const row of offerHalalCounts) halalDistribution[row.halalStatus] = row._count._all;
  const totalOffers = offerHalalCounts.reduce((s, r) => s + r._count._all, 0);
  const unscreenedShare = totalOffers > 0
    ? Math.round(((halalDistribution.UNVERIFIED ?? 0) / totalOffers) * 10000) / 10000
    : null;
  evidence.offersByHalal = totalOffers;
  signals.push({
    kind: 'HALAL_REVIEW_OUTCOME',
    hypothesis: totalOffers === 0
      ? 'No offers exist yet, so there is no halal verdict distribution to report.'
      : `${Object.entries(halalDistribution).map(([k, v]) => `${k}=${v}`).join(', ')}. `
        + 'UNVERIFIED means unscreened, never permitted.',
    result: totalOffers >= MIN_VALIDATED_SAMPLE && (halalDistribution.UNVERIFIED ?? 0) === 0 ? 'VALIDATED' : 'INCONCLUSIVE',
    metric: 'unscreened_offer_share',
    measuredValue: unscreenedShare ?? 0,
    sampleSize: totalOffers,
    decision:
      'Drive the UNVERIFIED share to zero. Screening happens at offer creation and is enforced again at '
      + 'engagement creation.',
    applicability: 'Safety posture. Learning can never bypass or relax a halal gate.',
    evidenceType: 'VERIFIED_DATA',
  });

  return { signals, evidence };
}

/**
 * Persist the derived signals into the EXISTING LearningEntry table. Learning
 * rows are records only — they grant no execution authority.
 *
 * PHASE 11.7 FIX — dedupe. There was no dedupe key, so re-running this function
 * inserted a fresh identical row every time and inflated every aggregate. The
 * key is derived from the SIGNAL KIND plus the day plus the underlying evidence
 * counts, so a genuinely new observation produces a new row while a repeat
 * observation of the same state does not.
 *
 * `opportunityId` is intentionally left null for portfolio-level signals: they
 * describe the whole set, not one opportunity. The commercial learning consumer
 * reads them by `context` prefix rather than filtering on opportunityId (which
 * previously meant portfolio signals were invisible to that consumer).
 */
export async function persistCommercialLearning(): Promise<{ ok: true; persisted: number; skippedDuplicates: number } | { ok: false; error: string }> {
  const snapshot = await deriveCommercialSignals();
  const dayBucket = new Date().toISOString().slice(0, 10);
  let persisted = 0;
  let skippedDuplicates = 0;

  for (const signal of snapshot.signals) {
    // Deterministic identity for "this observation".
    const evidenceDigest = Object.entries(snapshot.evidence)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('|');
    const dedupeKey = `commercial:${signal.kind}:${dayBucket}:${evidenceDigest.slice(0, 120)}`;

    const existing = await db.learningEntry.findFirst({
      where: { context: dedupeKey },
      select: { id: true },
    });
    if (existing) {
      skippedDuplicates += 1;
      continue;
    }

    try {
      await db.learningEntry.create({
        data: {
          hypothesis: signal.hypothesis.slice(0, 500),
          result: signal.result,
          metric: signal.metric,
          measuredValue: signal.measuredValue,
          decision: signal.decision.slice(0, 500),
          // The dedupe key doubles as the consumer-facing prefix marker, so
          // commercial signals remain discoverable by context.
          context: dedupeKey.slice(0, 300),
          evidenceType: 'VERIFIED_DATA',
          applicability: signal.applicability.slice(0, 300),
          // Confidence is bounded by real sample size and never exceeds what
          // the evidence supports.
          confidence: signal.sampleSize >= MIN_VALIDATED_SAMPLE ? 0.7 : 0.3,
        },
      });
      persisted += 1;
    } catch {
      // A learning write failure must never affect the underlying commercial state.
    }
  }
  return { ok: true, persisted, skippedDuplicates };
}