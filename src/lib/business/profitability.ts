// Pure Business Intelligence / profitability layer.
//
// This module is the SINGLE source of truth for profitability math on top of
// the unit-economics helpers (which remain the single source of truth for the
// core formulas). It deliberately has no DB, AI, provider, or UI dependency so
// the Analytics Agent, Business Manager, dashboard actions, and future Ruflo
// workers can all share it.
//
// Provenance rules:
// - Every number here is computed deterministically from stored database
//   records (VERIFIED_DATA). Nothing is invented: no market size, customer
//   counts, prices, or projected revenue.
// - Refunds are DERIVED (see deriveRefundsFromRecords): the Revenue schema has
//   no refunds column, so any gap between stored netRevenue and
//   grossRevenue-minus-recorded-costs is treated as refunds/unattributed
//   deductions, and always reported as such.
// - RECONCILIATION: the stored netRevenue column already includes fee and cost
//   deductions (the app writes net = gross − fees − costs). Under the
//   unit-economics model (net = gross − refunds; contribution = net − fees −
//   costs) a self-consistent record therefore yields contributionProfit equal
//   to the stored netRevenue. "Net Revenue" in this layer means post-refund,
//   pre-fee revenue.
// - The schema records a single `fees` column; it is mapped to platformFees
//   and paymentFees stays 0 rather than inventing a split.
// - AI may narrate these numbers elsewhere, but may never alter them: the
//   calculation is deterministic and authoritative.
//
// NaN/Infinity protection: invalid records are excluded with warnings; every
// ratio returns null (never NaN/Infinity) via the unit-economics helpers.

import {
  calculateUnitEconomics,
  calculateBreakEvenRevenue,
  calculateRoiPercent,
  type UnitEconomicsResult,
} from './unit-economics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors the platform's EvidenceType values without importing agent types. */
export type ProvenanceType = 'VERIFIED_DATA' | 'AI_INFERENCE' | 'USER_ENTERED' | 'MOCKED';

/** Shape of a stored Revenue row (Prisma-compatible, subset that matters). */
export interface RevenueRecordInput {
  id?: string;
  grossRevenue: number;
  fees: number;
  advertisingCost: number;
  otherCosts: number;
  netRevenue: number;
}

/** Shape of a stored Experiment row (subset that matters). */
export interface ExperimentRecordInput {
  id: string;
  hypothesis: string;
  budget: number;
  revenue: number;
  profit: number;
  visitors: number;
  sales: number;
}

/** Shape of a stored Product row (subset that matters). */
export interface ProductRecordInput {
  id: string;
  name: string;
  opportunityId?: string | null;
}

/** Shape of a stored Opportunity row (subset that matters). */
export interface OpportunityRecordInput {
  id: string;
  title: string;
  estimatedStartupCost: number;
}

export interface ProfitabilityMetrics {
  grossRevenue: number;
  refunds: number;
  netRevenue: number;
  platformFees: number;
  paymentFees: number;
  variableCosts: number;
  contributionProfit: number;
  contributionMarginPercent: number | null;
  roiPercent: number | null;
  breakEvenRevenue: number | null;
  recordCount: number;
  excludedRecordCount: number;
  /** True when refunds were derived from the stored net/gross/cost residual. */
  refundsDerived: boolean;
}

export interface ProfitabilityAnalysis {
  metrics: ProfitabilityMetrics;
  warnings: string[];
}

export interface EntityProfitability {
  entityId: string;
  label: string;
  opportunityId: string | null;
  metrics: ProfitabilityMetrics;
  warnings: string[];
}

export interface ExperimentProfitability {
  experimentId: string;
  hypothesis: string;
  grossRevenue: number;
  spend: number;
  contributionProfit: number;
  contributionMarginPercent: number | null;
  roiPercent: number | null;
  storedProfit: number;
  storedProfitMatchesComputed: boolean;
  warnings: string[];
}

export interface BiKpi {
  label: string;
  value: string;
  provenance: ProvenanceType;
}

export interface BiEvidence {
  type: ProvenanceType;
  content: string;
  source: string;
}

export interface BiNextAction {
  action: string;
  reason: string;
}

export interface BusinessIntelligenceResult {
  overall: ProfitabilityMetrics;
  kpis: BiKpi[];
  perOpportunity: EntityProfitability[];
  perProduct: EntityProfitability[];
  perExperiment: ExperimentProfitability[];
  warnings: string[];
  assumptions: string[];
  missingData: string[];
  nextActions: BiNextAction[];
  evidence: BiEvidence[];
  dataQuality: {
    revenueRecords: number;
    excludedRecords: number;
    opportunitiesWithRevenue: number;
    productsWithRevenue: number;
    experimentsWithSpendOrRevenue: number;
  };
}

export interface BuildBusinessIntelligenceInput {
  opportunities?: OpportunityRecordInput[];
  products?: ProductRecordInput[];
  experiments?: ExperimentRecordInput[];
  revenues: RevenueRecordInput[];
  /**
   * Optional fixed-cost basis for break-even (e.g. opportunity
   * estimatedStartupCost). The revenue schema does not track fixed costs, so
   * break-even is only computed when the caller explicitly supplies a basis.
   */
  fixedCosts?: number | null;
}

// ---------------------------------------------------------------------------
// Core aggregation (delegates all formulas to unit-economics)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Derive refunds from a record's residual:
 * refunds ≈ gross − fees − advertising − other − storedNet (floored at 0).
 * The Revenue schema has no refunds column; any unattributed gap (refunds or
 * untracked payment fees) is surfaced honestly instead of being invented.
 * Returns the residual (>= 0) and whether stored net was internally
 * inconsistent (stored net exceeds gross minus recorded costs).
 */
function deriveRefundsFromRecord(record: RevenueRecordInput): {
  refunds: number;
  inconsistent: boolean;
} {
  const gross = isFiniteNumber(record.grossRevenue) ? record.grossRevenue : 0;
  const fees = isFiniteNumber(record.fees) ? Math.max(0, record.fees) : 0;
  const advertising = isFiniteNumber(record.advertisingCost) ? Math.max(0, record.advertisingCost) : 0;
  const other = isFiniteNumber(record.otherCosts) ? Math.max(0, record.otherCosts) : 0;
  const net = isFiniteNumber(record.netRevenue) ? record.netRevenue : 0;

  const costAdjustedGross = gross - fees - advertising - other;
  const residual = costAdjustedGross - net;
  if (residual >= 0) return { refunds: residual, inconsistent: false };
  return { refunds: 0, inconsistent: true };
}

/**
 * Analyze a set of stored revenue records deterministically.
 * Records with non-finite or negative gross revenue are excluded with
 * warnings (never silently folded into totals).
 */
export function analyzeRevenueRecords(
  records: RevenueRecordInput[],
  options?: { fixedCosts?: number | null },
): ProfitabilityAnalysis {
  const warnings: string[] = [];
  const valid: RevenueRecordInput[] = [];
  let excluded = 0;
  let inconsistentCount = 0;

  for (const record of records) {
    const grossInvalid =
      !isFiniteNumber(record.grossRevenue) || record.grossRevenue < 0;
    const fieldsInvalid =
      !isFiniteNumber(record.fees) ||
      !isFiniteNumber(record.advertisingCost) ||
      !isFiniteNumber(record.otherCosts) ||
      !isFiniteNumber(record.netRevenue);
    if (grossInvalid || fieldsInvalid) {
      excluded += 1;
      warnings.push(
        'Excluded ' +
          (record.id ? 'revenue record ' + record.id : 'a revenue record') +
          ' with invalid values (non-numeric or negative gross revenue); it is not included in totals.',
      );
      continue;
    }
    if (record.fees < 0 || record.advertisingCost < 0 || record.otherCosts < 0) {
      warnings.push(
        'Negative fee/cost values on ' +
          (record.id ? 'revenue record ' + record.id : 'a revenue record') +
          ' were clamped to 0.',
      );
    }
    const { inconsistent } = deriveRefundsFromRecord(record);
    if (inconsistent) inconsistentCount += 1;
    valid.push(record);
  }

  if (excluded > 0 && valid.length === 0) {
    warnings.push('All revenue records were invalid; totals reflect no usable data.');
  }
  if (inconsistentCount > 0) {
    warnings.push(
      inconsistentCount +
        ' revenue record(s) have stored netRevenue exceeding gross minus recorded costs; the excess is not attributed to any recorded fee or cost line.',
    );
  }

  // Aggregate raw recorded lines first, then run the unit-economics formula
  // ONCE on the aggregate (no per-record re-derivation drift).
  const grossRevenue = valid.reduce((s, r) => s + r.grossRevenue, 0);
  const platformFees = valid.reduce((s, r) => s + Math.max(0, r.fees), 0);
  const advertising = valid.reduce((s, r) => s + Math.max(0, r.advertisingCost), 0);
  const otherCosts = valid.reduce((s, r) => s + Math.max(0, r.otherCosts), 0);
  const storedNet = valid.reduce((s, r) => s + r.netRevenue, 0);

  const residualRefunds = Math.max(
    0,
    grossRevenue - platformFees - advertising - otherCosts - storedNet,
  );
  const refundsDerived = residualRefunds > 0;

  const economics: UnitEconomicsResult = calculateUnitEconomics({
    grossRevenue,
    refunds: residualRefunds,
    platformFees,
    paymentFees: 0, // the schema does not track payment fees separately
    otherVariableCosts: advertising + otherCosts,
  });

  const variableCosts = economics.otherVariableCosts;
  const roiPercent = calculateRoiPercent(economics.contributionProfit, variableCosts);
  const breakEvenRevenue =
    options?.fixedCosts != null
      ? calculateBreakEvenRevenue(options.fixedCosts, economics.contributionMarginPercent ?? NaN)
      : null;

  const metrics: ProfitabilityMetrics = {
    grossRevenue: economics.grossRevenue,
    refunds: economics.refunds,
    netRevenue: economics.netRevenue,
    platformFees: economics.platformFees,
    paymentFees: economics.paymentFees,
    variableCosts,
    contributionProfit: economics.contributionProfit,
    contributionMarginPercent: economics.contributionMarginPercent,
    roiPercent,
    breakEvenRevenue,
    recordCount: valid.length,
    excludedRecordCount: excluded,
    refundsDerived,
  };

  if (refundsDerived) {
    warnings.push(
      'Refunds of $' +
        economics.refunds.toFixed(2) +
        ' were derived from the gap between stored netRevenue and recorded gross/fees/costs (the schema has no dedicated refunds column).',
    );
  }
  if (variableCosts === 0 && valid.length > 0) {
    warnings.push('No advertising or other variable costs are recorded; ROI is undefined rather than assumed.');
  }
  if (options?.fixedCosts == null) {
    warnings.push('Fixed costs are not tracked in the revenue schema; break-even is not computed unless a fixed-cost basis is supplied.');
  }

  return { metrics, warnings };
}

/** Deterministic revenue health used by the Business Manager decision engine. */
export type RevenueHealth = 'NO_DATA' | 'NON_POSITIVE_NET' | 'UNPROFITABLE' | 'PROFITABLE';

export function resolveRevenueHealth(
  netRevenue: number,
  contributionProfit: number,
  recordCount: number,
): RevenueHealth {
  if (!isFiniteNumber(netRevenue) || !isFiniteNumber(contributionProfit) || recordCount <= 0) {
    return 'NO_DATA';
  }
  if (netRevenue <= 0) return 'NON_POSITIVE_NET';
  if (contributionProfit <= 0) return 'UNPROFITABLE';
  return 'PROFITABLE';
}

// ---------------------------------------------------------------------------
// Per-entity breakdowns (revenue per opportunity / product / experiment)
// ---------------------------------------------------------------------------

export function analyzeOpportunityProfitability(
  opportunities: OpportunityRecordInput[],
  revenues: (RevenueRecordInput & { opportunityId?: string | null })[],
  options?: { fixedCosts?: (opportunity: OpportunityRecordInput) => number | null },
): EntityProfitability[] {
  const summaries: EntityProfitability[] = [];
  for (const opportunity of opportunities) {
    const linked = revenues.filter((r) => r.opportunityId === opportunity.id);
    if (linked.length === 0) continue; // reported as missing data, not fabricated
    const fixedCosts = options?.fixedCosts
      ? options.fixedCosts(opportunity)
      : opportunity.estimatedStartupCost > 0
        ? opportunity.estimatedStartupCost
        : null;
    const { metrics, warnings } = analyzeRevenueRecords(linked, { fixedCosts });
    if (fixedCosts != null && metrics.breakEvenRevenue != null) {
      warnings.push(
        'Break-even uses the opportunity estimatedStartupCost ($' +
          fixedCosts.toFixed(2) +
          ') as the fixed-cost basis; it is a planning estimate, not verified spend.',
      );
    }
    summaries.push({
      entityId: opportunity.id,
      label: opportunity.title,
      opportunityId: opportunity.id,
      metrics,
      warnings,
    });
  }
  return summaries;
}

export function analyzeProductProfitability(
  products: ProductRecordInput[],
  revenues: (RevenueRecordInput & { productId?: string | null })[],
): EntityProfitability[] {
  const summaries: EntityProfitability[] = [];
  for (const product of products) {
    const linked = revenues.filter((r) => r.productId === product.id);
    if (linked.length === 0) continue;
    const { metrics, warnings } = analyzeRevenueRecords(linked);
    summaries.push({
      entityId: product.id,
      label: product.name,
      opportunityId: product.opportunityId ?? null,
      metrics,
      warnings,
    });
  }
  return summaries;
}

/**
 * Experiment economics from stored fields. The budget is treated as spend
 * (documented assumption); the stored profit column is reported alongside the
 * deterministic computation so stale values are visible, never authoritative.
 */
export function analyzeExperimentProfitability(
  experiments: ExperimentRecordInput[],
): ExperimentProfitability[] {
  return experiments.map((experiment) => {
    const warnings: string[] = [];
    const spend = isFiniteNumber(experiment.budget) ? Math.max(0, experiment.budget) : 0;
    const revenue = isFiniteNumber(experiment.revenue) ? experiment.revenue : 0;
    const economics = calculateUnitEconomics({
      grossRevenue: revenue,
      otherVariableCosts: spend,
    });
    const roiPercent = calculateRoiPercent(economics.contributionProfit, spend);
    const storedProfitMatchesComputed =
      isFiniteNumber(experiment.profit) &&
      Math.abs(experiment.profit - economics.contributionProfit) < 0.005;
    if (!storedProfitMatchesComputed) {
      warnings.push(
        'Stored profit ($' +
          experiment.profit.toFixed(2) +
          ') differs from the deterministic computation (revenue − budget = $' +
          economics.contributionProfit.toFixed(2) +
          '); the deterministic value is authoritative here.',
      );
    }
    if (experiment.budget <= 0) {
      warnings.push('No budget/spend recorded; ROI is undefined rather than assumed.');
    }
    return {
      experimentId: experiment.id,
      hypothesis: experiment.hypothesis,
      grossRevenue: economics.grossRevenue,
      spend,
      contributionProfit: economics.contributionProfit,
      contributionMarginPercent: economics.contributionMarginPercent,
      roiPercent,
      storedProfit: experiment.profit,
      storedProfitMatchesComputed,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// Business Intelligence result assembly
// ---------------------------------------------------------------------------

function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + '$' + Math.abs(value).toFixed(2);
}

function formatPercentOrNull(value: number | null): string {
  return value === null ? 'Undefined (insufficient data)' : value.toFixed(2) + '%';
}

/**
 * Assemble the full Business Intelligence result from real records.
 * Deterministic: identical inputs produce identical outputs (no clocks,
 * no randomness, no AI).
 */
export function buildBusinessIntelligence(
  input: BuildBusinessIntelligenceInput,
): BusinessIntelligenceResult {
  const revenues = input.revenues;
  const opportunities = input.opportunities ?? [];
  const products = input.products ?? [];
  const experiments = input.experiments ?? [];

  const overallAnalysis = analyzeRevenueRecords(revenues);
  const overall = overallAnalysis.metrics;
  const warnings = [...overallAnalysis.warnings];

  const perOpportunity = analyzeOpportunityProfitability(opportunities, revenues);
  const perProduct = analyzeProductProfitability(products, revenues);
  const perExperiment = analyzeExperimentProfitability(experiments);

  const assumptions: string[] = [
    'All figures are computed deterministically from stored database records; revenue is not profit.',
    'The stored fees column is mapped to platform fees; payment fees are not tracked separately in the schema.',
    'Refunds are derived from the residual between stored netRevenue and recorded gross/fees/costs when that residual is positive.',
    'Experiment budget is treated as spend for contribution profit and ROI.',
    'AI may narrate these figures elsewhere but never alters them; this calculation is authoritative.',
  ];

  const missingData: string[] = [];
  if (overall.recordCount === 0) {
    missingData.push('No usable revenue records; all profitability figures are zero/null, not estimated.');
  }
  const opportunitiesWithRevenue = perOpportunity.length;
  if (opportunities.length > opportunitiesWithRevenue) {
    missingData.push(
      opportunities.length - opportunitiesWithRevenue +
        ' opportunity(ies) have no linked revenue records; no per-opportunity profitability is inferred for them.',
    );
  }
  const productsWithRevenue = perProduct.length;
  if (products.length > productsWithRevenue) {
    missingData.push(
      products.length - productsWithRevenue +
        ' product(s) have no linked revenue records; no per-product profitability is inferred for them.',
    );
  }
  if (overall.variableCosts === 0 && overall.recordCount > 0) {
    missingData.push('No variable costs (advertising/other) recorded; contribution margin equals net revenue margin and ROI is undefined.');
  }

  const nextActions: BiNextAction[] = [];
  if (overall.recordCount === 0) {
    nextActions.push({
      action: 'Record real revenue entries',
      reason: 'Profitability analysis requires recorded revenue; nothing is estimated in its absence.',
    });
  } else {
    if (overall.contributionProfit <= 0 && overall.netRevenue > 0) {
      nextActions.push({
        action: 'Review fees and variable costs',
        reason:
          'Contribution profit is ' + formatUsd(overall.contributionProfit) +
          ' despite positive net revenue of ' + formatUsd(overall.netRevenue) + '.',
      });
    }
    if (overall.excludedRecordCount > 0) {
      nextActions.push({
        action: 'Fix invalid revenue records',
        reason: overall.excludedRecordCount + ' record(s) were excluded for invalid values.',
      });
    }
    if (opportunities.length > opportunitiesWithRevenue && opportunitiesWithRevenue === 0 && opportunities.length > 0) {
      nextActions.push({
        action: 'Link revenue records to opportunities',
        reason: 'Revenue exists but no records are linked to opportunities, so per-opportunity profitability cannot be computed.',
      });
    }
    if (products.length > productsWithRevenue && productsWithRevenue === 0 && products.length > 0) {
      nextActions.push({
        action: 'Link revenue records to products',
        reason: 'Revenue exists but no records are linked to products, so per-product profitability cannot be computed.',
      });
    }
    if (overall.contributionProfit > 0 && overall.roiPercent === null) {
      nextActions.push({
        action: 'Record advertising/cost data to unlock ROI',
        reason: 'Contribution profit is positive but no spend basis exists to compute ROI.',
      });
    }
  }
  if (nextActions.length === 0) {
    nextActions.push({
      action: 'Continue recording revenue and costs',
      reason: 'Data supports profitability tracking; keep entries linked to opportunities and products.',
    });
  }

  const kpis: BiKpi[] = [
    { label: 'Gross Revenue', value: formatUsd(overall.grossRevenue), provenance: 'VERIFIED_DATA' },
    { label: 'Refunds (derived from stored residual)', value: formatUsd(overall.refunds), provenance: 'VERIFIED_DATA' },
    { label: 'Net Revenue (after refunds)', value: formatUsd(overall.netRevenue), provenance: 'VERIFIED_DATA' },
    { label: 'Platform Fees', value: formatUsd(overall.platformFees), provenance: 'VERIFIED_DATA' },
    { label: 'Payment Fees', value: formatUsd(overall.paymentFees), provenance: 'VERIFIED_DATA' },
    { label: 'Variable Costs', value: formatUsd(overall.variableCosts), provenance: 'VERIFIED_DATA' },
    { label: 'Contribution Profit', value: formatUsd(overall.contributionProfit), provenance: 'VERIFIED_DATA' },
    { label: 'Contribution Margin', value: formatPercentOrNull(overall.contributionMarginPercent), provenance: 'VERIFIED_DATA' },
    { label: 'ROI', value: formatPercentOrNull(overall.roiPercent), provenance: 'VERIFIED_DATA' },
    {
      label: 'Break-even Revenue',
      value: overall.breakEvenRevenue === null ? 'Not computed (no fixed-cost basis)' : formatUsd(overall.breakEvenRevenue),
      provenance: 'VERIFIED_DATA',
    },
  ];

  const evidence: BiEvidence[] = [
    {
      type: 'VERIFIED_DATA',
      content:
        'Profitability computed from ' + overall.recordCount + ' stored revenue record(s)' +
        (overall.excludedRecordCount > 0 ? ' (' + overall.excludedRecordCount + ' invalid record(s) excluded)' : '') + '.',
      source: 'Prisma db.revenue',
    },
    {
      type: 'VERIFIED_DATA',
      content: 'Formulas delegate to the shared unit-economics module (calculateUnitEconomics, calculateRoiPercent, calculateBreakEvenRevenue).',
      source: 'src/lib/business/unit-economics.ts',
    },
    {
      type: 'AI_INFERENCE' as ProvenanceType,
      content: 'Next actions and any narrative interpretation of these figures are inferences, not data.',
      source: 'Business Intelligence layer',
    },
  ];

  return {
    overall,
    kpis,
    perOpportunity,
    perProduct,
    perExperiment,
    warnings,
    assumptions,
    missingData,
    nextActions,
    evidence,
    dataQuality: {
      revenueRecords: revenues.length,
      excludedRecords: overall.excludedRecordCount,
      opportunitiesWithRevenue,
      productsWithRevenue,
      experimentsWithSpendOrRevenue: experiments.filter((e) => e.budget > 0 || e.revenue > 0).length,
    },
  };
}
