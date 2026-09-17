// Pure Business Manager profitability decision input.
//
// Bridges the Business Intelligence layer into the Business Manager decision
// engine WITHOUT duplicating decision logic: this module computes only the
// VERIFIED_DATA profitability facts the engine branches on. The agent keeps
// full ownership of gates (NOT_ALLOWED / REVIEW_REQUIRED) and of producing
// exactly one primary next-best-action.

import {
  analyzeOpportunityProfitability,
  resolveRevenueHealth,
  type OpportunityRecordInput,
  type RevenueRecordInput,
} from './profitability';

export interface ProfitabilityDecisionInput {
  opportunity: OpportunityRecordInput;
  revenues: (RevenueRecordInput & { opportunityId?: string | null })[];
}

export interface ProfitabilityDecisionFacts {
  hasRevenueData: boolean;
  netRevenue: number;
  contributionProfit: number;
  revenueHealth: 'NO_DATA' | 'NON_POSITIVE_NET' | 'UNPROFITABLE' | 'PROFITABLE';
  roiPercent: number | null;
  contributionMarginPercent: number | null;
  /** Concise VERIFIED_DATA summary for the agent's analytics section. */
  summary: string;
  evidenceType: 'VERIFIED_DATA' | 'AI_INFERENCE';
  warnings: string[];
}

/**
 * Compute deterministic profitability facts for one opportunity.
 * Never throws on invalid data; returns explicit NO_DATA facts instead.
 */
export function buildProfitabilityDecisionFacts(
  input: ProfitabilityDecisionInput,
): ProfitabilityDecisionFacts {
  const { opportunity, revenues } = input;
  const linked = revenues.filter((r) => r.opportunityId === opportunity.id);

  if (linked.length === 0) {
    return {
      hasRevenueData: false,
      netRevenue: 0,
      contributionProfit: 0,
      revenueHealth: 'NO_DATA',
      roiPercent: null,
      contributionMarginPercent: null,
      summary:
        'No revenue records are linked to this opportunity; profitability is unknown, not zero-profit.',
      evidenceType: 'AI_INFERENCE',
      warnings: ['No revenue data for this opportunity.'],
    };
  }

  const warnings: string[] = [];
  let gross = 0;
  let fees = 0;
  let advertising = 0;
  let other = 0;
  let net = 0;
  for (const record of linked) {
    const valid =
      Number.isFinite(record.grossRevenue) &&
      Number.isFinite(record.netRevenue) &&
      record.grossRevenue >= 0;
    if (!valid) {
      warnings.push('At least one invalid revenue record was excluded from decision facts.');
      continue;
    }
    gross += record.grossRevenue;
    fees += Math.max(0, record.fees);
    advertising += Math.max(0, record.advertisingCost);
    other += Math.max(0, record.otherCosts);
    net += record.netRevenue;
  }
  const refunds = Math.max(0, gross - fees - advertising - other - net);
  // Stored netRevenue already includes fee/cost deductions (the app writes
  // net = gross − fees − costs), so contribution profit reconciles to the
  // stored net for self-consistent records (same convention as the
  // profitability layer).
  const contributionProfit = net - refunds;
  const revenueHealth = resolveRevenueHealth(net, contributionProfit, linked.length);

  const variableSpend = advertising + other;
  const roiPercent =
    variableSpend > 0 && Number.isFinite(contributionProfit)
      ? (contributionProfit / variableSpend) * 100
      : null;
  const contributionMarginPercent =
    net > 0 && Number.isFinite(contributionProfit)
      ? (contributionProfit / net) * 100
      : null;

  const healthLabel: Record<typeof revenueHealth, string> = {
    NO_DATA: 'no usable data',
    NON_POSITIVE_NET: 'net revenue is not positive',
    UNPROFITABLE: 'net revenue is positive but contribution profit is not',
    PROFITABLE: 'contribution profit is positive',
  };

  const summary =
    'Verified profitability for "' +
    opportunity.title +
    '" from ' +
    linked.length +
    ' revenue record(s): gross $' +
    gross.toFixed(2) +
    ', net $' +
    net.toFixed(2) +
    ', contribution profit $' +
    contributionProfit.toFixed(2) +
    (contributionMarginPercent === null ? '' : ', margin ' + contributionMarginPercent.toFixed(1) + '%') +
    (roiPercent === null ? '' : ', ROI ' + roiPercent.toFixed(1) + '%') +
    '. Deterministic analysis: ' +
    healthLabel[revenueHealth] +
    '.';

  return {
    hasRevenueData: true,
    netRevenue: net,
    contributionProfit,
    revenueHealth,
    roiPercent,
    contributionMarginPercent,
    summary,
    evidenceType: 'VERIFIED_DATA',
    warnings,
  };
}

/** Per-opportunity verified profitability summaries for portfolio views. */
export function buildOpportunityProfitSummaries(
  opportunities: OpportunityRecordInput[],
  revenues: (RevenueRecordInput & { opportunityId?: string | null })[],
): { opportunityId: string; label: string; contributionProfit: number; netRevenue: number }[] {
  return analyzeOpportunityProfitability(opportunities, revenues).map((summary) => ({
    opportunityId: summary.entityId,
    label: summary.label,
    contributionProfit: summary.metrics.contributionProfit,
    netRevenue: summary.metrics.netRevenue,
  }));
}
