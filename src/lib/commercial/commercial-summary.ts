// ============================================================================
// PHASE 11.2 + 11.3 — COMMERCIAL SUMMARY (read-only observability)
// ============================================================================
// One truthful aggregate of the governed commercial pipeline, consumed by the
// Observatory. READ-ONLY: this module performs no writes.
//
// Honesty rules, identical to the rest of the Observatory:
//  - Every count is derived from real persisted rows. Nothing is estimated.
//  - When a figure cannot be reached it is reported as `null` with a
//    `dataQuality` of 'UNKNOWN' — never folded into 0 or into an optimistic
//    bucket.
//  - Communication/provider states come from the providers' own truthful
//    health descriptors. A disconnected provider says NOT_CONNECTED.
// ============================================================================

import { db } from '@/lib/db';
import { describeCommunicationHealth } from './communication-provider';
import { OFFER_TYPES, type OfferType } from './offer-states';

export interface CommercialBucket {
  /** Real row counts by state. */
  counts: Record<string, number>;
  /** Total rows counted in this bucket. */
  total: number;
}

export interface CommercialSummary {
  generatedAt: string;
  prospects: CommercialBucket;
  offers: { total: number; byType: Record<OfferType, number>; byStatus: Record<string, number>; byHalal: Record<string, number> };
  proposals: { total: number; byState: Record<string, number>; pendingApprovals: number; accepted: number };
  scopeChanges: { total: number; reviewRequired: number; converted: number; rejected: number };
  engagements: { total: number; byState: Record<string, number>; byType: Record<string, number> };
  payment: {
    /** Engagements whose payment is genuinely verified. */
    verifiedEngagements: number;
    /** Engagements blocked waiting for payment. */
    paymentRequired: number;
    /** Milestones verified via a real source. */
    verifiedMilestones: number;
    /** Engagement revenue rows, and their real sum. */
    revenueRows: number;
    revenueUsd: number | null;
    dataQuality: 'REAL' | 'UNKNOWN';
  };
  delivery: { byState: Record<string, number>; accepted: number; withheld: number; revisionLimitReached: number };
  issues: { total: number; open: number; requiringHuman: number };
  learning: { commercialLearningEntries: number; recentHypotheses: string[] };
  providers: {
    communication: ReturnType<typeof describeCommunicationHealth>;
  };
  note: string;
}

function countBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? 'UNKNOWN');
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function emptyTypeCounts(): Record<OfferType, number> {
  return { DIGITAL_PRODUCT: 0, MICRO_SERVICE: 0, CLIENT_SERVICE: 0 };
}

/**
 * Assemble the commercial summary. Any storage failure is surfaced to the
 * caller as an explicit failure — it never returns a partial summary that
 * could read as "zero activity" when it is actually "could not read".
 */
export async function getCommercialSummary(): Promise<CommercialSummary> {
  const [
    prospects,
    offers,
    proposals,
    changeRequests,
    engagements,
    milestones,
    deliverables,
    issues,
    revenue,
    learning,
  ] = await Promise.all([
    db.prospect.findMany({ select: { lifecycleState: true, riskState: true } }),
    db.offer.findMany({ select: { type: true, status: true, halalStatus: true } }),
    db.proposal.findMany({ select: { state: true, approvalState: true } }),
    db.scopeChangeRequest.findMany({ select: { status: true } }),
    db.serviceEngagement.findMany({ select: { state: true, engagementType: true } }),
    db.milestone.findMany({ select: { paymentState: true } }),
    db.deliverable.findMany({ select: { state: true } }),
    db.serviceIssue.findMany({ select: { status: true, requiresHuman: true } }),
    // PHASE 11.7: only ACTUAL-basis revenue counts as earned here. Estimates,
    // projections and simulations are excluded so the summary cannot report a
    // plan as income.
    db.revenue.findMany({
      where: { revenueSource: { startsWith: 'service' }, revenueBasis: 'ACTUAL' },
      select: { grossRevenue: true, currency: true },
    }),
    db.learningEntry.findMany({
      where: { context: { startsWith: 'commercial' } },
      orderBy: { createdAt: 'desc' },
      // PHASE 11.7 FIX: this was hard-capped at 5 rows, so the summary could
      // never surface more than the five newest learning entries regardless of
      // how much evidence existed.
      take: 50,
      select: { hypothesis: true },
    }),
  ]);

  const byType = emptyTypeCounts();
  for (const offer of offers) {
    if ((OFFER_TYPES as readonly string[]).includes(offer.type)) {
      byType[offer.type as OfferType] += 1;
    }
  }

  // Revenue quality: mixed currencies are NOT summed into a single number.
  const currencies = new Set(revenue.map((r) => r.currency));
  const revenueUsd = revenue.length === 0
    ? null
    : currencies.size === 1 && currencies.has('USD')
      ? Math.round(revenue.reduce((sum, r) => sum + r.grossRevenue, 0) * 100) / 100
      : null;

  const deliverableStates = countBy(deliverables, 'state');
  const changeStatuses = countBy(changeRequests, 'status');
  const engagementStates = countBy(engagements, 'state');
  const milestoneStates = countBy(milestones, 'paymentState');

  return {
    generatedAt: new Date().toISOString(),
    prospects: {
      counts: {
        ...countBy(prospects, 'lifecycleState'),
        active: prospects.filter((p) => !['LOST', 'BLOCKED'].includes(p.lifecycleState)).length,
        qualified: prospects.filter((p) => p.lifecycleState === 'QUALIFIED').length,
        optedOut: prospects.filter((p) => p.riskState === 'BLOCKED').length,
      },
      total: prospects.length,
    },
    offers: {
      total: offers.length,
      byType,
      byStatus: countBy(offers, 'status'),
      byHalal: countBy(offers, 'halalStatus'),
    },
    proposals: {
      total: proposals.length,
      byState: countBy(proposals, 'state'),
      pendingApprovals: proposals.filter((p) => p.approvalState === 'NOT_APPROVED' && p.state === 'INTERNAL_REVIEW').length,
      accepted: proposals.filter((p) => p.state === 'ACCEPTED').length,
    },
    scopeChanges: {
      total: changeRequests.length,
      reviewRequired: changeStatuses.REVIEW_REQUIRED ?? 0,
      converted: changeStatuses.CONVERTED_TO_VERSION ?? 0,
      rejected: changeStatuses.REJECTED ?? 0,
    },
    engagements: {
      total: engagements.length,
      byState: engagementStates,
      byType: countBy(engagements, 'engagementType'),
    },
    payment: {
      verifiedEngagements: engagements.filter((e) => e.state === 'PAYMENT_VERIFIED' || e.state === 'WORK_AUTHORIZED' || e.state === 'WORK_IN_PROGRESS').length,
      paymentRequired: engagementStates.PAYMENT_REQUIRED ?? 0,
      verifiedMilestones: milestoneStates.PAYMENT_VERIFIED ?? 0,
      revenueRows: revenue.length,
      revenueUsd,
      dataQuality: revenueUsd === null ? 'UNKNOWN' : 'REAL',
    },
    delivery: {
      byState: deliverableStates,
      accepted: deliverableStates.ACCEPTED ?? 0,
      withheld: deliverableStates.WITHHELD ?? 0,
      revisionLimitReached: deliverableStates.REVISION_LIMIT_REACHED ?? 0,
    },
    issues: {
      total: issues.length,
      open: issues.filter((i) => i.status === 'OPEN').length,
      requiringHuman: issues.filter((i) => i.requiresHuman && i.status === 'OPEN').length,
    },
    learning: {
      commercialLearningEntries: learning.length,
      recentHypotheses: learning.map((l) => l.hypothesis.slice(0, 160)),
    },
    providers: { communication: describeCommunicationHealth() },
    note:
      'Counts are derived from persisted rows only; nothing is estimated or fabricated. A provider with no '
      + 'credentialed integration reports NOT_CONNECTED. Revenue is summed only when a single USD currency is '
      + 'present; otherwise it is reported as UNKNOWN rather than guessed.',
  };
}