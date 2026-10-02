// ============================================================================
// PHASE 11.7 — ENGAGEMENT ECONOMICS (cost ledger + per-engagement P&L)
// ============================================================================
// Phase 11.3 recorded service revenue but had no engagement-level COST, which
// made per-engagement P&L impossible and turned "margin" into a synonym for
// "price". This module closes that gap without inventing anything.
//
// The whole design turns on one distinction that is enforced here and never
// blurred downstream:
//
//   ACTUAL     — an evidenced cost/revenue. Counted toward realized profit.
//   ESTIMATED  — a planning figure. NEVER counted toward realized profit.
//
// `profit` and `margin` are computed from ACTUAL rows only. A separate
// `projected` block reports the estimate-based view, clearly labelled, so a
// projection can never be read as earnings.
//
// Cost writes are idempotent on a deterministic key, so the same evidenced
// cost (a provider invoice line) cannot be counted twice.
// ============================================================================

import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';

export type EconomicsResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; status: 400 | 404; error: string };

export const ENGAGEMENT_COST_CATEGORIES = [
  'AI_EXECUTION',
  'TOOLING',
  'INFRASTRUCTURE',
  'PLATFORM_FEE',
  'REFUND',
  'OTHER',
] as const;
export type EngagementCostCategory = (typeof ENGAGEMENT_COST_CATEGORIES)[number];

export const COST_BASES = ['ACTUAL', 'ESTIMATED'] as const;
export type CostBasis = (typeof COST_BASES)[number];

export const REVENUE_BASES = ['ACTUAL', 'ESTIMATED', 'PROJECTED', 'SIMULATED'] as const;
export type RevenueBasis = (typeof REVENUE_BASES)[number];

const MAX_COST_USD = 10_000_000;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_EVIDENCE_REFS = 20;

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

/**
 * Record an engagement cost.
 *
 * `basis` is REQUIRED and explicit. A caller cannot write an ACTUAL cost
 * without supplying evidence references — an unevidenced "actual" is exactly
 * the fabricated-cost failure mode the spec forbids. Estimates need no
 * evidence and are stored, but are never summed into realized profit.
 */
export async function recordEngagementCost(options: {
  engagementId: unknown;
  category: unknown;
  amountUsd: unknown;
  basis: unknown;
  description?: unknown;
  evidenceRefs?: unknown;
  /** Stable provider/invoice reference; required for ACTUAL costs. */
  sourceRef?: unknown;
  occurredAt?: unknown;
  surface: string;
}): Promise<EconomicsResult> {
  const engagementId = typeof options.engagementId === 'string' && options.engagementId.length > 0
    ? options.engagementId
    : null;
  if (!engagementId) return { ok: false, status: 400, error: 'engagementId is required.' };

  if (!(ENGAGEMENT_COST_CATEGORIES as readonly string[]).includes(String(options.category))) {
    return { ok: false, status: 400, error: `category must be one of: ${ENGAGEMENT_COST_CATEGORIES.join(', ')}.` };
  }
  const basis = String(options.basis);
  if (!(COST_BASES as readonly string[]).includes(basis)) {
    return { ok: false, status: 400, error: `basis must be one of: ${COST_BASES.join(', ')}. It is never inferred.` };
  }
  if (typeof options.amountUsd !== 'number' || !Number.isFinite(options.amountUsd)) {
    return { ok: false, status: 400, error: 'amountUsd must be a finite number.' };
  }
  const amountUsd = Math.round(options.amountUsd * 100) / 100;
  if (amountUsd === 0) return { ok: false, status: 400, error: 'amountUsd must be non-zero.' };
  if (Math.abs(amountUsd) > MAX_COST_USD) {
    return { ok: false, status: 400, error: `amountUsd exceeds the ${MAX_COST_USD} ceiling.` };
  }

  let evidenceRefs: string[] = [];
  if (Array.isArray(options.evidenceRefs)) {
    evidenceRefs = options.evidenceRefs
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim().slice(0, 300))
      .slice(0, MAX_EVIDENCE_REFS);
  }

  // An ACTUAL cost must be evidenced. This is the anti-fabrication gate.
  if (basis === 'ACTUAL') {
    if (evidenceRefs.length === 0 && (typeof options.sourceRef !== 'string' || options.sourceRef.trim().length === 0)) {
      return {
        ok: false, status: 400,
        error:
          'An ACTUAL cost requires evidence: supply sourceRef (a real provider/invoice reference) or '
          + 'evidenceRefs. Record it as ESTIMATED instead if it is not evidenced.',
      };
    }
  }

  const engagement = await db.serviceEngagement.findUnique({
    where: { id: engagementId },
    select: { id: true, currency: true },
  });
  if (!engagement) return { ok: false, status: 404, error: 'Engagement not found.' };

  const sourceRef = typeof options.sourceRef === 'string' ? options.sourceRef.trim() : '';
  const idempotencyKey = `cost:${engagementId}:${options.category}:${basis}:${sourceRef || 'no-ref'}`;

  try {
    const created = await db.engagementCost.create({
      data: {
        engagementId,
        category: String(options.category),
        description: typeof options.description === 'string' ? options.description.slice(0, MAX_DESCRIPTION_CHARS) : '',
        amountUsd,
        currency: engagement.currency,
        basis,
        evidenceRefs: JSON.stringify(evidenceRefs).slice(0, 2_000),
        idempotencyKey,
        occurredAt: options.occurredAt instanceof Date ? options.occurredAt : new Date(),
      },
    });

    // Only ACTUAL costs roll into the engagement's realized total.
    if (basis === 'ACTUAL') {
      await db.serviceEngagement.update({
        where: { id: engagementId },
        data: { actualCostUsd: { increment: amountUsd } },
      });
    }

    await auditSecurityEvent({
      kind: 'COMMERCIAL_COST_RECORDED',
      surface: options.surface,
      outcome: 'ok',
      detail: `engagement=${engagementId.slice(0, 12)} ${options.category} $${amountUsd} basis=${basis}`,
    });
    return { ok: true, costId: created.id, idempotencyKey, basis };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
      await auditSecurityEvent({
        kind: 'COMMERCIAL_COST_DUPLICATE',
        surface: options.surface,
        outcome: 'ok',
        detail: `engagement=${engagementId.slice(0, 12)} idempotent replay — cost not double-counted`,
      });
      const existing = await db.engagementCost.findUnique({ where: { idempotencyKey }, select: { id: true } });
      return { ok: true, costId: existing?.id ?? null, duplicate: true, idempotencyKey };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Per-engagement P&L
// ---------------------------------------------------------------------------

export interface EngagementPnl {
  engagementId: string;
  currency: string;
  /** Realized revenue: ACTUAL, non-refunded rows only. */
  realized: {
    grossUsd: number;
    refundsUsd: number;
    recognizedUsd: number;
    /** TRUE | UNKNOWN — UNKNOWN when mixed currencies prevent a real total. */
    dataQuality: 'REAL' | 'UNKNOWN';
    revenueRows: number;
  };
  /** Realized cost: ACTUAL cost rows only. Estimates are excluded. */
  cost: {
    actualUsd: number;
    actualRows: number;
    /** The estimate view, kept strictly separate. */
    estimatedUsd: number;
    estimatedRows: number;
    byCategory: Record<string, number>;
    dataQuality: 'REAL' | 'UNKNOWN';
  };
  /** Mathematically derived from realized figures only. */
  profit: { value: number | null; label: 'DERIVED' | 'UNKNOWN'; source: string };
  margin: { value: number | null; label: 'DERIVED' | 'UNKNOWN'; source: string };
  /** The estimate-based view. NEVER presented as earned. */
  projected: { estimatedProfitUsd: number | null; label: 'ESTIMATED'; source: string };
  /** Honest evidence count, so a 1-of-1 result is never a "trend". */
  sampleSize: { revenueRows: number; costRows: number; engagementsInCurrency: number };
}

/**
 * Per-engagement P&L.
 *
 * The derivation rules are explicit and are the reason this is trustworthy:
 *  - profit = recognized revenue − ACTUAL cost. Both sides are real rows.
 *  - margin = profit / recognized revenue, undefined at zero revenue.
 *  - estimates are summed into `projected`, which is labelled ESTIMATED and is
 *    never folded into profit or margin.
 */
export async function getEngagementPnl(engagementId: unknown): Promise<EngagementPnl | null> {
  if (typeof engagementId !== 'string' || engagementId.length === 0) return null;
  const engagement = await db.serviceEngagement.findUnique({
    where: { id: engagementId },
    select: { id: true, currency: true, totalPrice: true, engagementType: true, state: true },
  });
  if (!engagement) return null;

  const [revenueRows, costRows] = await Promise.all([
    db.revenue.findMany({
      where: { serviceEngagementId: engagementId },
      select: {
        id: true, grossRevenue: true, recognizedUsd: true, refundTotalUsd: true,
        revenueBasis: true, currency: true,
      },
    }),
    db.engagementCost.findMany({
      where: { engagementId },
      select: { id: true, category: true, amountUsd: true, basis: true, currency: true },
    }),
  ]);

  const round = (n: number) => Math.round(n * 100) / 100;

  // --- Realized revenue ---------------------------------------------------
  // Only ACTUAL rows are realized revenue. ESTIMATED / PROJECTED / SIMULATED
  // rows are excluded here on purpose, so a projection can never inflate
  // apparent earnings.
  const actualRevenueRows = revenueRows.filter((r) => r.revenueBasis === 'ACTUAL');
  const revenueCurrencies = new Set(actualRevenueRows.map((r) => r.currency));
  const revenueSingleCurrency = revenueCurrencies.size <= 1;
  const grossUsd = round(actualRevenueRows.reduce((s, r) => s + r.grossRevenue, 0));
  const refundsUsd = round(actualRevenueRows.reduce((s, r) => s + r.refundTotalUsd, 0));
  // recognizedUsd was written at record time; fall back to gross for rows that
  // predate the column.
  const recognizedUsd = round(
    actualRevenueRows.reduce((s, r) => s + (Number.isFinite(r.recognizedUsd) && r.recognizedUsd > 0 ? r.recognizedUsd : r.grossRevenue), 0),
  );

  // --- Realized cost ------------------------------------------------------
  const actualCosts = costRows.filter((c) => c.basis === 'ACTUAL');
  const estimatedCosts = costRows.filter((c) => c.basis === 'ESTIMATED');
  const costCurrencies = new Set(actualCosts.map((c) => c.currency));
  const costSingleCurrency = costCurrencies.size <= 1;
  const actualCostUsd = round(actualCosts.reduce((s, c) => s + c.amountUsd, 0));
  const estimatedCostUsd = round(estimatedCosts.reduce((s, c) => s + c.amountUsd, 0));

  const byCategory: Record<string, number> = {};
  for (const c of actualCosts) {
    byCategory[c.category] = round((byCategory[c.category] ?? 0) + c.amountUsd);
  }

  // Mixed currencies are UNKNOWN, never summed into a meaningless number.
  const currencyClean = revenueSingleCurrency && costSingleCurrency;

  const profitValue = currencyClean ? round(recognizedUsd - actualCostUsd) : null;
  const marginValue = currencyClean && recognizedUsd > 0
    ? Math.round((profitValue! / recognizedUsd) * 10000) / 10000
    : null;

  const projectedProfit = currencyClean ? round(engagement.totalPrice - estimatedCostUsd) : null;

  return {
    engagementId: engagement.id,
    currency: engagement.currency,
    realized: {
      grossUsd,
      refundsUsd,
      recognizedUsd,
      dataQuality: actualRevenueRows.length === 0 || !revenueSingleCurrency ? 'UNKNOWN' : 'REAL',
      revenueRows: actualRevenueRows.length,
    },
    cost: {
      actualUsd: actualCostUsd,
      actualRows: actualCosts.length,
      estimatedUsd: estimatedCostUsd,
      estimatedRows: estimatedCosts.length,
      byCategory,
      dataQuality: actualCosts.length === 0 || !costSingleCurrency ? 'UNKNOWN' : 'REAL',
    },
    profit: {
      value: profitValue,
      label: profitValue === null ? 'UNKNOWN' : 'DERIVED',
      source:
        profitValue === null
          ? 'Mixed currencies or no realized revenue — profit is undefined, not zero'
          : `Recognized revenue (${actualRevenueRows.length} ACTUAL Revenue row(s)) minus ACTUAL cost `
            + `(${actualCosts.length} EngagementCost row(s)). Estimates are excluded.`,
    },
    margin: {
      value: marginValue,
      label: marginValue === null ? 'UNKNOWN' : 'DERIVED',
      source: marginValue === null
        ? 'No realized revenue — margin is undefined, not zero'
        : 'profit / recognized revenue over the same engagement',
    },
    projected: {
      estimatedProfitUsd: projectedProfit,
      label: 'ESTIMATED',
      source:
        projectedProfit === null
          ? 'Mixed currencies — projected profit undefined'
          : 'Contract price minus ESTIMATED cost rows. This is a PLAN, not earnings, and is never '
            + 'included in profit or margin.',
    },
    sampleSize: {
      revenueRows: actualRevenueRows.length,
      costRows: actualCosts.length,
      engagementsInCurrency: actualRevenueRows.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Portfolio-level economics across all three income paths
// ---------------------------------------------------------------------------

export interface PortfolioEconomics {
  generatedAt: string;
  /** Realized ACTUAL revenue split by income path. */
  byIncomePath: {
    DIGITAL_PRODUCT: { revenueUsd: number; rows: number; dataQuality: 'REAL' | 'UNKNOWN' };
    MICRO_SERVICE: { revenueUsd: number; rows: number; dataQuality: 'REAL' | 'UNKNOWN' };
    CLIENT_SERVICE: { revenueUsd: number; rows: number; dataQuality: 'REAL' | 'UNKNOWN' };
    UNATTRIBUTED: { revenueUsd: number; rows: number; dataQuality: 'REAL' | 'UNKNOWN' };
  };
  refunds: { totalUsd: number; rows: number; dataQuality: 'REAL' | 'UNKNOWN' };
  costs: {
    actualUsd: number;
    estimatedUsd: number;
    actualRows: number;
    estimatedRows: number;
    byCategory: Record<string, number>;
    dataQuality: 'REAL' | 'UNKNOWN';
  };
  totals: {
    recognizedRevenueUsd: number | null;
    actualCostUsd: number | null;
    profitUsd: number | null;
    margin: number | null;
    labels: Record<string, 'DERIVED' | 'UNKNOWN' | 'REAL'>;
    sources: Record<string, string>;
  };
  /** Explicitly separate, never added into totals. */
  simulated: { rows: number; grossUsd: number; note: string };
  projected: { rows: number; grossUsd: number; note: string };
  sampleSizes: { engagements: number; deliverablesAccepted: number; costsRecorded: number };
  note: string;
}

/**
 * Portfolio economics across DIGITAL PRODUCT, MICRO SERVICE and CLIENT SERVICE.
 *
 * The three income paths are reported separately and are never forced through
 * one lifecycle — they share this economic view, not their state machines.
 * Unattributed revenue stays in its own bucket rather than being smeared across
 * the three paths.
 */
export async function getPortfolioEconomics(): Promise<PortfolioEconomics> {
  const round = (n: number) => Math.round(n * 100) / 100;

  const [revenueRows, costRows, engagements, deliverables] = await Promise.all([
    db.revenue.findMany({
      select: {
        id: true, grossRevenue: true, recognizedUsd: true, refundTotalUsd: true,
        revenueBasis: true, currency: true, serviceEngagementId: true, productId: true,
      },
    }),
    db.engagementCost.findMany({ select: { id: true, category: true, amountUsd: true, basis: true, currency: true } }),
    db.serviceEngagement.findMany({ select: { id: true, engagementType: true, currency: true } }),
    db.deliverable.findMany({ select: { state: true } }),
  ]);

  const actual = revenueRows.filter((r) => r.revenueBasis === 'ACTUAL');
  const engagementTypeById = new Map(engagements.map((e) => [e.id, e.engagementType]));

  const emptyBucket = () => ({ revenueUsd: 0, rows: 0, dataQuality: 'UNKNOWN' as 'REAL' | 'UNKNOWN' });
  const buckets = {
    DIGITAL_PRODUCT: emptyBucket(),
    MICRO_SERVICE: emptyBucket(),
    CLIENT_SERVICE: emptyBucket(),
    UNATTRIBUTED: emptyBucket(),
  };

  for (const row of actual) {
    const bucket = !row.serviceEngagementId
      ? buckets.UNATTRIBUTED
      : engagementTypeById.get(row.serviceEngagementId) === 'MICRO_SERVICE'
        ? buckets.MICRO_SERVICE
        : buckets.CLIENT_SERVICE;
    bucket.revenueUsd = round(bucket.revenueUsd + (row.recognizedUsd > 0 ? row.recognizedUsd : row.grossRevenue));
    bucket.rows += 1;
  }
  // Digital-product revenue is the ACTUAL rows with no service engagement.
  const digitalRows = actual.filter((r) => !r.serviceEngagementId && (r.productId !== null));
  buckets.DIGITAL_PRODUCT.revenueUsd = round(digitalRows.reduce((s, r) => s + (r.recognizedUsd > 0 ? r.recognizedUsd : r.grossRevenue), 0));
  buckets.DIGITAL_PRODUCT.rows = digitalRows.length;
  // Everything ACTUAL with neither a service engagement nor a product is
  // unattributed, not silently credited to a path.
  const unattributed = actual.filter((r) => !r.serviceEngagementId && r.productId === null);
  buckets.UNATTRIBUTED.revenueUsd = round(unattributed.reduce((s, r) => s + (r.recognizedUsd > 0 ? r.recognizedUsd : r.grossRevenue), 0));
  buckets.UNATTRIBUTED.rows = unattributed.length;

  for (const bucket of Object.values(buckets)) {
    if (bucket.rows > 0) bucket.dataQuality = 'REAL';
  }

  const actualCosts = costRows.filter((c) => c.basis === 'ACTUAL');
  const estimatedCosts = costRows.filter((c) => c.basis === 'ESTIMATED');
  const byCategory: Record<string, number> = {};
  for (const c of actualCosts) byCategory[c.category] = round((byCategory[c.category] ?? 0) + c.amountUsd);

  const refundRows = actual.filter((r) => r.refundTotalUsd > 0);
  const refundTotalUsd = round(refundRows.reduce((s, r) => s + r.refundTotalUsd, 0));

  const currencies = new Set([
    ...actual.map((r) => r.currency),
    ...actualCosts.map((c) => c.currency),
  ]);
  const currencyClean = currencies.size <= 1;

  const recognizedRevenueUsd = actual.length === 0 || !currencyClean
    ? null
    : round(actual.reduce((s, r) => s + (r.recognizedUsd > 0 ? r.recognizedUsd : r.grossRevenue), 0));
  const actualCostUsd = actualCosts.length === 0 || !currencyClean
    ? null
    : round(actualCosts.reduce((s, c) => s + c.amountUsd, 0));

  const profitUsd = recognizedRevenueUsd !== null && actualCostUsd !== null
    ? round(recognizedRevenueUsd - actualCostUsd)
    : null;
  const margin = profitUsd !== null && recognizedRevenueUsd !== null && recognizedRevenueUsd > 0
    ? Math.round((profitUsd / recognizedRevenueUsd) * 10000) / 10000
    : null;

  const simulatedRows = revenueRows.filter((r) => r.revenueBasis === 'SIMULATED');
  const projectedRows = revenueRows.filter((r) => r.revenueBasis === 'PROJECTED');

  return {
    generatedAt: new Date().toISOString(),
    byIncomePath: buckets,
    refunds: {
      totalUsd: refundTotalUsd,
      rows: refundRows.length,
      dataQuality: refundRows.length > 0 ? 'REAL' : 'UNKNOWN',
    },
    costs: {
      actualUsd: actualCostUsd ?? 0,
      estimatedUsd: round(estimatedCosts.reduce((s, c) => s + c.amountUsd, 0)),
      actualRows: actualCosts.length,
      estimatedRows: estimatedCosts.length,
      byCategory,
      dataQuality: actualCosts.length > 0 && currencyClean ? 'REAL' : 'UNKNOWN',
    },
    totals: {
      recognizedRevenueUsd,
      actualCostUsd,
      profitUsd,
      margin,
      labels: {
        recognizedRevenueUsd: recognizedRevenueUsd === null ? 'UNKNOWN' : 'REAL',
        actualCostUsd: actualCostUsd === null ? 'UNKNOWN' : 'REAL',
        profitUsd: profitUsd === null ? 'UNKNOWN' : 'DERIVED',
        margin: margin === null ? 'UNKNOWN' : 'DERIVED',
      },
      sources: {
        recognizedRevenueUsd:
          recognizedRevenueUsd === null
            ? 'No ACTUAL revenue rows (or mixed currencies) — unknown, not zero'
            : `Sum of ${actual.length} Revenue rows with revenueBasis=ACTUAL, refunds already deducted`,
        actualCostUsd:
          actualCostUsd === null
            ? 'No ACTUAL EngagementCost rows — unknown, not zero'
            : `Sum of ${actualCosts.length} EngagementCost rows with basis=ACTUAL`,
        profitUsd: profitUsd === null ? 'Undefined without both real revenue and real cost' : 'recognized revenue − ACTUAL cost',
        margin: margin === null ? 'Undefined without recognized revenue' : 'profit / recognized revenue',
      },
    },
    simulated: {
      rows: simulatedRows.length,
      grossUsd: round(simulatedRows.reduce((s, r) => s + r.grossRevenue, 0)),
      note: 'SIMULATED revenue is test/plan data. It is NEVER summed into totals and must never be reported as income.',
    },
    projected: {
      rows: projectedRows.length,
      grossUsd: round(projectedRows.reduce((s, r) => s + r.grossRevenue, 0)),
      note: 'PROJECTED revenue is a forecast. It is NEVER summed into totals and must never be reported as income.',
    },
    sampleSizes: {
      engagements: engagements.length,
      deliverablesAccepted: deliverables.filter((d) => d.state === 'ACCEPTED' || d.state === 'COMPLETED').length,
      costsRecorded: costRows.length,
    },
    note:
      'Totals use ACTUAL rows only. Estimates, projections and simulations are reported separately and are '
      + 'never folded into revenue, profit or margin.',
  };
}

// ---------------------------------------------------------------------------
// Bounded optimization recommendations (Phase 11.7)
// ---------------------------------------------------------------------------

export interface OptimizationRecommendation {
  id: string;
  kind: 'PRICING_EXPERIMENT' | 'SERVICE_CHANGE' | 'DISTRIBUTION_EXPERIMENT' | 'WORKFLOW_IMPROVEMENT';
  rationale: string;
  /** The real evidence count behind this recommendation. */
  sampleSize: number;
  /** False whenever the sample is too small to act on. */
  actionable: boolean;
  /** Always true: nothing here performs a financial or legal action. */
  requiresHumanApproval: true;
  confidence: 'LOW' | 'INSUFFICIENT_DATA';
}

/**
 * Optimization recommendations.
 *
 * Two hard constraints, both enforced in the return type rather than in prose:
 *  - `requiresHumanApproval` is literally typed `true`.
 *  - `actionable` is false unless the sample size clears the bar, so a 1-of-1
 *    result can never be presented as a validated pattern.
 *
 * Every recommendation is a suggestion to a human. None of them move money,
 * change a price, or commit the business to anything.
 */
export async function recommendOptimizations(): Promise<{
  recommendations: OptimizationRecommendation[];
  minSampleForAction: number;
  note: string;
}> {
  const MIN_SAMPLE = 3;
  const [engagements, deliverables, issues] = await Promise.all([
    db.serviceEngagement.findMany({ select: { state: true, engagementType: true, totalPrice: true } }),
    db.deliverable.findMany({ select: { state: true, revisionCount: true } }),
    db.serviceIssue.findMany({ select: { issueType: true, status: true } }),
  ]);

  const completed = engagements.filter((e) => e.state === 'COMPLETED').length;
  const cancelled = engagements.filter((e) => e.state === 'CANCELLED' || e.state === 'TERMINATED').length;
  const revised = deliverables.filter((d) => d.revisionCount > 0).length;
  const scopeIssues = issues.filter((i) => i.issueType === 'DISPUTE' || i.issueType === 'REFUND_REQUESTED').length;

  const build = (
    id: string,
    kind: OptimizationRecommendation['kind'],
    rationale: string,
    sampleSize: number,
  ): OptimizationRecommendation => ({
    id,
    kind,
    rationale,
    sampleSize,
    actionable: sampleSize >= MIN_SAMPLE,
    requiresHumanApproval: true,
    confidence: sampleSize >= MIN_SAMPLE ? 'LOW' : 'INSUFFICIENT_DATA',
  });

  return {
    recommendations: [
      build(
        'pricing-review',
        'PRICING_EXPERIMENT',
        completed > 0
          ? `${completed} engagement(s) reached COMPLETED. Review observed prices before proposing a pricing test.`
          : 'No engagement has completed yet. A pricing test has no evidence base and must not be proposed.',
        completed,
      ),
      build(
        'cancellation-review',
        'SERVICE_CHANGE',
        cancelled > 0
          ? `${cancelled} engagement(s) were cancelled or terminated. Review recorded causes before repeating the pattern.`
          : 'No cancellations recorded. Nothing to review yet.',
        cancelled,
      ),
      build(
        'qa-clarity',
        'WORKFLOW_IMPROVEMENT',
        revised > 0
          ? `${revised} deliverable(s) consumed at least one revision round. Consider clarifying scope wording.`
          : 'No revisions recorded. Scope clarity is not yet measurable.',
        revised,
      ),
      build(
        'dispute-review',
        'SERVICE_CHANGE',
        scopeIssues > 0
          ? `${scopeIssues} dispute/refund issue(s) recorded. Review before expanding service scope.`
          : 'No disputes recorded.',
        scopeIssues,
      ),
    ],
    minSampleForAction: MIN_SAMPLE,
    note:
      'Recommendations are ADVISORY ONLY. They never move money, set a price, or commit the business to '
      + 'anything, and every one requires human approval. Below the minimum sample size a recommendation is '
      + 'reported with actionable=false rather than being presented as a finding.',
  };
}
