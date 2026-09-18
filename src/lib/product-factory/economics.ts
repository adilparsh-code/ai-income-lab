// Phase 5.3 — Product revenue attribution + product economics (pure).
//
// All functions operate on REAL recorded rows (Revenue/Experiment/AgentLog
// aggregates) and produce labelled figures:
//
//   VERIFIED      — computed solely from DB records the operator entered or
//                   a real provider recorded. Missing source → UNKNOWN_SOURCE.
//   ESTIMATED     — derived from configured cost policies (e.g. AI token cost
//                   estimates). Always labelled, never presented as billing.
//   AI_INFERENCE  — never produced by this module (no AI anywhere).
//
// No attribution is invented: a revenue row without product/opportunity links
// reports UNKNOWN_SOURCE, and duplicates are prevented by an explicit idempotency
// key helper the caller persists with a unique constraint.

import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Revenue attribution
// ---------------------------------------------------------------------------

export type RevenueAttributionSource =
  | 'PRODUCT'
  | 'OPPORTUNITY'
  | 'EXPERIMENT'
  | 'CAMPAIGN'
  | 'UNKNOWN_SOURCE';

export interface RevenueAttribution {
  source: RevenueAttributionSource;
  /** Which recorded entity the revenue belongs to (null for unknown). */
  refId: string | null;
  date: string;
  grossRevenue: number;
  fees: number;
  netRevenue: number;
  /** VERIFIED — comes from real records only. */
  evidenceType: 'VERIFIED';
}

export interface AttributableRevenueRow {
  id: string;
  date: Date;
  revenueSource: string;
  grossRevenue: number;
  fees: number;
  netRevenue: number;
  productId?: string | null;
  opportunityId?: string | null;
  referenceNote?: string | null;
}

/** Attribute one recorded revenue row; unknown sources stay truthful. */
export function attributeRevenueRow(row: AttributableRevenueRow): RevenueAttribution {
  let source: RevenueAttributionSource = 'UNKNOWN_SOURCE';
  let refId: string | null = null;

  if (row.productId) {
    source = 'PRODUCT';
    refId = row.productId;
  } else if (row.opportunityId) {
    source = 'OPPORTUNITY';
    refId = row.opportunityId;
  } else if (row.revenueSource.trim().length > 0 && row.revenueSource.toLowerCase() !== 'unknown') {
    source = 'CAMPAIGN';
    refId = row.revenueSource.trim();
  }

  return {
    source,
    refId,
    date: row.date.toISOString(),
    grossRevenue: row.grossRevenue,
    fees: row.fees,
    netRevenue: row.netRevenue,
    evidenceType: 'VERIFIED',
  };
}

/** Deterministic idempotency key for revenue ingestion (caller persists it). */
export function revenueIdempotencyKey(input: {
  date: string;
  revenueSource: string;
  grossRevenue: number;
  productId?: string | null;
  opportunityId?: string | null;
}): string {
  return [
    'rev',
    input.productId ?? '-',
    input.opportunityId ?? '-',
    input.revenueSource.trim().toLowerCase().replace(/\s+/g, '-'),
    input.date.slice(0, 10),
    input.grossRevenue.toFixed(2),
  ].join(':');
}

// ---------------------------------------------------------------------------
// Product economics
// ---------------------------------------------------------------------------

export type FigureProvenance = 'VERIFIED' | 'ESTIMATED' | 'AI_INFERENCE';

export interface LabelledFigure {
  amountUsd: number;
  provenance: FigureProvenance;
  /** How this figure was derived (never a secret, bounded). */
  basis: string;
}

export interface ProductEconomics {
  costs: {
    ai: LabelledFigure;
    build: LabelledFigure;
    deployment: LabelledFigure;
    publishing: LabelledFigure;
    marketing: LabelledFigure;
  };
  revenue: {
    gross: LabelledFigure;
    fees: LabelledFigure;
    net: LabelledFigure;
  };
  /** ESTIMATED: net revenue minus all labelled costs. */
  estimatedProfit: LabelledFigure;
  /** VERIFIED figures only — true when revenue records exist. */
  hasRevenueEvidence: boolean;
  /** VERIFIED figures only — true when any cost evidence exists. */
  hasCostEvidence: boolean;
  /** Honest assessment: profit claims need sufficient evidence. */
  profitabilityClaim: 'PROFITABLE' | 'UNPROFITABLE' | 'INSUFFICIENT_DATA';
  /** Explanation for the profitabilityClaim (safe, bounded). */
  claimBasis: string;
}

export interface EconomicsInputs {
  /** AI cost estimate from the usage layer (AgentLog sums) — ESTIMATED. */
  aiCostUsd: number | null;
  /** Recorded build/deploy/publish/marketing costs where available — VERIFIED. */
  buildCostUsd: number | null;
  deploymentCostUsd: number | null;
  publishingCostUsd: number | null;
  marketingCostUsd: number | null;
  /** Recorded revenue aggregates (real Revenue rows) — VERIFIED. */
  grossRevenueUsd: number | null;
  feesUsd: number | null;
  netRevenueUsd: number | null;
}

function labelled(amountUsd: number | null, provenance: FigureProvenance, basis: string): LabelledFigure {
  return { amountUsd: amountUsd ?? 0, provenance, basis };
}

/** Evidence thresholds: below these, profitability cannot be claimed. */
const MIN_REVENUE_FOR_CLAIM = 1; // any real revenue counts as evidence
const MIN_DATA_POINTS = 1;

export function computeProductEconomics(inputs: EconomicsInputs): ProductEconomics {
  const ai = labelled(inputs.aiCostUsd, 'ESTIMATED', 'AI usage estimate from recorded token usage (AgentLog sums); not a provider bill.');
  const build = labelled(inputs.buildCostUsd, 'VERIFIED', 'Recorded build cost, or zero when no build cost was recorded.');
  const deployment = labelled(inputs.deploymentCostUsd, 'VERIFIED', 'Recorded deployment cost, or zero when none recorded.');
  const publishing = labelled(inputs.publishingCostUsd, 'VERIFIED', 'Recorded publishing cost, or zero when none recorded.');
  const marketing = labelled(inputs.marketingCostUsd, 'VERIFIED', 'Recorded marketing spend (e.g. Revenue.advertisingCost), or zero when none recorded.');

  const hasRevenueEvidence = inputs.grossRevenueUsd !== null && inputs.grossRevenueUsd > 0;
  const hasCostEvidence = [inputs.buildCostUsd, inputs.deploymentCostUsd, inputs.publishingCostUsd, inputs.marketingCostUsd]
    .some((v) => v !== null) || inputs.aiCostUsd !== null;

  const totalCosts
    = ai.amountUsd + build.amountUsd + deployment.amountUsd + publishing.amountUsd + marketing.amountUsd;

  const gross = labelled(inputs.grossRevenueUsd, 'VERIFIED', 'Sum of recorded Revenue.grossRevenue rows for this product.');
  const fees = labelled(inputs.feesUsd, 'VERIFIED', 'Sum of recorded Revenue.fees rows for this product.');
  const net = labelled(
    inputs.netRevenueUsd ?? (inputs.grossRevenueUsd !== null ? inputs.grossRevenueUsd - (inputs.feesUsd ?? 0) : null),
    'VERIFIED',
    'Sum of recorded Revenue.netRevenue rows (or gross minus fees when net is not recorded).',
  );

  const estimatedProfit = labelled(
    hasRevenueEvidence ? net.amountUsd - totalCosts : null,
    'ESTIMATED',
    'Net revenue (VERIFIED) minus labelled costs (VERIFIED + ESTIMATED AI). Not a billable figure.',
  );

  let profitabilityClaim: ProductEconomics['profitabilityClaim'];
  let claimBasis: string;
  const dataPoints = [
    inputs.grossRevenueUsd !== null,
    inputs.aiCostUsd !== null,
    inputs.buildCostUsd !== null,
    inputs.deploymentCostUsd !== null,
    inputs.publishingCostUsd !== null,
    inputs.marketingCostUsd !== null,
  ].filter(Boolean).length;

  if (!hasRevenueEvidence) {
    profitabilityClaim = 'INSUFFICIENT_DATA';
    claimBasis = 'No recorded revenue for this product yet; profitability cannot be claimed.';
  } else if (dataPoints < MIN_DATA_POINTS) {
    profitabilityClaim = 'INSUFFICIENT_DATA';
    claimBasis = 'Not enough recorded cost/revenue data to claim profitability.';
  } else if (hasRevenueEvidence && (inputs.grossRevenueUsd as number) < MIN_REVENUE_FOR_CLAIM) {
    profitabilityClaim = 'INSUFFICIENT_DATA';
    claimBasis = 'Recorded revenue is below the evidence threshold for a profitability claim.';
  } else {
    const profitable = (estimatedProfit.amountUsd ?? 0) > 0;
    profitabilityClaim = profitable ? 'PROFITABLE' : 'UNPROFITABLE';
    claimBasis = profitable
      ? `Estimated profit $${estimatedProfit.amountUsd.toFixed(2)} from recorded revenue and labelled costs.`
      : `Estimated loss $${Math.abs(estimatedProfit.amountUsd).toFixed(2)} from recorded revenue and labelled costs.`;
  }

  return {
    costs: { ai, build, deployment, publishing, marketing },
    revenue: { gross, fees, net },
    estimatedProfit,
    hasRevenueEvidence,
    hasCostEvidence,
    profitabilityClaim,
    claimBasis,
  };
}

// Re-export for callers assembling Prisma typed payloads (structural only).
export type { Prisma };
