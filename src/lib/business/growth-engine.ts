// Phase 4.5.3 — Growth Engine (pure layer).
//
// Inputs are REAL recorded business data (revenue, experiments, products,
// pipeline, AI costs). Outputs are evidence-labelled recommendations:
// SCALE / IMPROVE / TEST / PAUSE / STOP / REINVEST / NEW_OPPORTUNITY —
// or an explicit INSUFFICIENT_DATA status. This engine NEVER predicts
// revenue, NEVER invents expected sales, and NEVER promotes a weak signal
// into a permanent "winner" label.
//
// Evidence thresholds are env-configurable; defaults are deliberately
// conservative. All classification is deterministic and inspectable.

// ---------------------------------------------------------------------------
// Evidence thresholds (env-configurable)
// ---------------------------------------------------------------------------

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Minimum visitors recorded before any winner state is possible. Default 100. */
export function getMinSampleVisitors(): number {
  return Math.floor(readPositiveNumber('GROWTH_MIN_SAMPLE_VISITORS', 100));
}

/** Minimum revenue (USD) recorded before PROMISING/PROVEN states. Default 50. */
export function getMinRevenueForPromising(): number {
  return readPositiveNumber('GROWTH_MIN_REVENUE_USD', 50);
}

/** Minimum revenue (USD) for PROVEN (sustained, decisive evidence). Default 500. */
export function getMinRevenueForProven(): number {
  return readPositiveNumber('GROWTH_MIN_REVENUE_PROVEN_USD', 500);
}

// ---------------------------------------------------------------------------
// Winner / Loser evidence states
// ---------------------------------------------------------------------------

export type EvidenceState = 'TESTING' | 'PROMISING' | 'PROVEN' | 'UNDERPERFORMING' | 'PAUSED';

/** Input describing one entity's recorded performance evidence. */
export interface PerformanceEvidence {
  /** Days since the first record (0 when unknown — treated conservatively). */
  ageDays: number | null;
  visitors: number;
  revenue: number;
  costs: number;
  conversions: number;
  /** Experiment decision recorded by a human, when one exists. */
  experimentDecision: 'SCALE' | 'ITERATE' | 'PAUSE' | 'KILL' | null;
  /** Explicitly paused by a human (status PAUSED). */
  manuallyPaused: boolean;
}

export interface EvidenceClassification {
  state: EvidenceState;
  /** Why this state was reached (deterministic reasons). */
  reasons: string[];
  /** Threshold values applied, for transparent display. */
  thresholds: { minVisitors: number; minRevenuePromising: number; minRevenueProven: number };
  sampleSizeKnown: boolean;
}

/**
 * Classify recorded evidence into a conservative state. Order of evaluation:
 * human pause → human decision → data thresholds. A human KILL/PAUSE always
 * dominates numeric signals; a human SCALE still needs sample-size evidence
 * to be labelled PROVEN (data-supported, never one weak signal).
 */
export function classifyEvidence(evidence: PerformanceEvidence): EvidenceClassification {
  const thresholds = {
    minVisitors: getMinSampleVisitors(),
    minRevenuePromising: getMinRevenueForPromising(),
    minRevenueProven: getMinRevenueForProven(),
  };
  const reasons: string[] = [];
  const sampleSizeKnown = Number.isFinite(evidence.visitors) && evidence.visitors > 0;

  if (evidence.manuallyPaused) {
    reasons.push('Paused by explicit human decision; numeric evidence is not overridden.');
    return { state: 'PAUSED', reasons, thresholds, sampleSizeKnown };
  }
  if (evidence.experimentDecision === 'PAUSE' || evidence.experimentDecision === 'KILL') {
    reasons.push(`Human experiment decision is ${evidence.experimentDecision}; treated as PAUSED.`);
    return { state: 'PAUSED', reasons, thresholds, sampleSizeKnown };
  }

  const revenue = Number.isFinite(evidence.revenue) && evidence.revenue > 0 ? evidence.revenue : 0;
  const costs = Number.isFinite(evidence.costs) && evidence.costs >= 0 ? evidence.costs : 0;
  const profitable = revenue > costs;

  // UNDERPERFORMING: meaningful sample exists, is not profitable, and no
  // human SCALE decision contradicts it.
  if (sampleSizeKnown && evidence.visitors >= thresholds.minVisitors && !profitable && evidence.experimentDecision !== 'SCALE') {
    reasons.push(
      `Sample of ${evidence.visitors} visitors with revenue $${revenue.toFixed(2)} ≤ costs $${costs.toFixed(2)}.`,
    );
    return { state: 'UNDERPERFORMING', reasons, thresholds, sampleSizeKnown };
  }

  // PROVEN: decisive, sustained evidence — sample + strong revenue or a human
  // SCALE decision backed by profitable data.
  const scaleBacked = evidence.experimentDecision === 'SCALE' && profitable && sampleSizeKnown;
  if (
    (revenue >= thresholds.minRevenueProven && profitable && sampleSizeKnown) ||
    (scaleBacked && revenue >= thresholds.minRevenuePromising)
  ) {
    if (revenue >= thresholds.minRevenueProven) {
      reasons.push(`Revenue $${revenue.toFixed(2)} ≥ proven threshold $${thresholds.minRevenueProven.toFixed(2)} with profitable economics.`);
    } else {
      reasons.push('Human SCALE decision backed by profitable economics and sufficient sample.');
    }
    return { state: 'PROVEN', reasons, thresholds, sampleSizeKnown };
  }

  // PROMISING: real revenue above the promising threshold, profitable.
  if (revenue >= thresholds.minRevenuePromising && profitable) {
    reasons.push(`Revenue $${revenue.toFixed(2)} ≥ promising threshold $${thresholds.minRevenuePromising.toFixed(2)} and profitable; still accumulating evidence.`);
    return { state: 'PROMISING', reasons, thresholds, sampleSizeKnown };
  }

  // TESTING: not enough data yet — the honest default.
  reasons.push('Insufficient evidence for a stronger state; classification stays TESTING.');
  return { state: 'TESTING', reasons, thresholds, sampleSizeKnown };
}

// ---------------------------------------------------------------------------
// Growth recommendations
// ---------------------------------------------------------------------------

export type GrowthRecommendationType =
  | 'SCALE'
  | 'IMPROVE'
  | 'TEST'
  | 'PAUSE'
  | 'STOP'
  | 'REINVEST'
  | 'NEW_OPPORTUNITY';

export interface GrowthInput {
  /** Recorded revenue health from the deterministic BI layer. */
  revenue: { gross: number; net: number; contributionProfit: number; recordCount: number };
  /** Per-product performance evidence. */
  products: { id: string; label: string; evidence: PerformanceEvidence; hasProduct: boolean }[];
  /** Per-experiment performance evidence. */
  experiments: { id: string; label: string; evidence: PerformanceEvidence }[];
  /** Number of active (non-rejected) opportunities in the pipeline. */
  activeOpportunityCount: number;
  /** Estimated AI spend for the period (ESTIMATE, from the usage layer). */
  estimatedAiCostUsd: number;
}

export interface GrowthRecommendation {
  type: GrowthRecommendationType;
  /** DATA_SUPPORTED | HYPOTHESIS | INSUFFICIENT_DATA — never a guarantee. */
  dataStatus: 'DATA_SUPPORTED' | 'HYPOTHESIS' | 'INSUFFICIENT_DATA';
  target: string | null;
  reason: string;
  /** Optional reinvestment linkage when type === 'REINVEST'. */
  suggestedAreas: string[];
}

/**
 * Produce the single highest-priority growth recommendation. Deterministic:
 * pause/stop evidence dominates, then improve/test, then scale/reinvest,
 * then pipeline growth. Never predicts revenue; statuses are explicit.
 */
export function recommendGrowthAction(input: GrowthInput): GrowthRecommendation {
  const noRevenue = input.revenue.recordCount === 0;

  // 1. Underperforming products/experiments → PAUSE (evidence-based).
  const underperforming = [...input.products, ...input.experiments].filter(
    (p) => classifyEvidence(p.evidence).state === 'UNDERPERFORMING',
  );
  if (underperforming.length > 0) {
    return {
      type: 'PAUSE',
      dataStatus: 'DATA_SUPPORTED',
      target: underperforming[0].label,
      reason: `Recorded evidence classifies "${underperforming[0].label}" as UNDERPERFORMING (sufficient sample, not profitable). Pausing protects the operating budget while the cause is investigated.`,
      suggestedAreas: [],
    };
  }

  // 2. No revenue at all → TEST / NEW_OPPORTUNITY, honestly labelled.
  if (noRevenue) {
    if (input.activeOpportunityCount === 0) {
      return {
        type: 'NEW_OPPORTUNITY',
        dataStatus: 'INSUFFICIENT_DATA',
        target: null,
        reason: 'No revenue records and no active opportunities exist. The pipeline is empty; new research is required before any growth action is possible.',
        suggestedAreas: [],
      };
    }
    return {
      type: 'TEST',
      dataStatus: 'INSUFFICIENT_DATA',
      target: null,
      reason: 'No revenue has been recorded yet. Run the cheapest decisive validation test on the strongest active opportunity; nothing is predicted or assumed.',
      suggestedAreas: [],
    };
  }

  // 3. Negative economics → IMPROVE before any scaling.
  if (input.revenue.contributionProfit <= 0) {
    return {
      type: 'IMPROVE',
      dataStatus: 'DATA_SUPPORTED',
      target: null,
      reason: `Net revenue is $${input.revenue.net.toFixed(2)} but contribution profit is $${input.revenue.contributionProfit.toFixed(2)}. Fix unit economics (fees, costs, pricing) before scaling.`,
      suggestedAreas: [],
    };
  }

  // 4. Profitable + proven/earning products → REINVEST (recommendation only).
  const proven = input.products.filter((p) => classifyEvidence(p.evidence).state === 'PROVEN');
  if (proven.length > 0) {
    return {
      type: 'REINVEST',
      dataStatus: 'DATA_SUPPORTED',
      target: proven[0].label,
      reason: `"${proven[0].label}" is PROVEN with profitable economics. Policy-supported reinvestment (human-approved) can fund growth; no automatic spend exists.`,
      suggestedAreas: ['PRODUCT_IMPROVEMENT', 'TRAFFIC_ACQUISITION', 'AUTOMATION'],
    };
  }

  // 5. Profitable + promising → SCALE what works (data-supported scale-up of effort).
  const promising = input.products.filter((p) => classifyEvidence(p.evidence).state === 'PROMISING');
  if (promising.length > 0) {
    return {
      type: 'SCALE',
      dataStatus: 'DATA_SUPPORTED',
      target: promising[0].label,
      reason: `"${promising[0].label}" is PROMISING with profitable economics. Increase distribution/testing effort on what is working while evidence accumulates.`,
      suggestedAreas: [],
    };
  }

  // 6. Revenue exists but nothing is classified strong → TEST more.
  return {
    type: 'TEST',
    dataStatus: 'HYPOTHESIS',
    target: null,
    reason: 'Revenue exists and is profitable, but no product or experiment has crossed the evidence thresholds yet. Continue cheap, decisive tests (hypothesis, not a prediction).',
    suggestedAreas: [],
  };
}

// ---------------------------------------------------------------------------
// Learning records (from real outcomes only)
// ---------------------------------------------------------------------------

export interface OutcomeLearningRecord {
  entityKind: 'PRODUCT' | 'EXPERIMENT' | 'AI_MODEL';
  entityId: string;
  cost: number;
  revenue: number;
  /** Conversion rate where measurable; null when the sample is unknown. */
  conversionRate: number | null;
  sampleSize: number | null;
  hypothesis?: string;
  result?: 'SUCCESS' | 'FAILURE' | 'INCONCLUSIVE';
}

export type LearningSignalStatus = 'SUFFICIENT_DATA' | 'INSUFFICIENT_DATA';

export interface LearningSignal {
  entityId: string;
  entityKind: OutcomeLearningRecord['entityKind'];
  status: LearningSignalStatus;
  /** Classification only when status is SUFFICIENT_DATA. */
  signal: 'SUCCESSFUL_PATTERN' | 'FAILED_HYPOTHESIS' | 'UNDERPERFORMING' | null;
  reason: string;
}

/**
 * Derive a learning signal from real outcome records. With insufficient data
 * (no sample size, no revenue AND no cost) the signal is INSUFFICIENT_DATA —
 * never a fabricated lesson.
 */
export function deriveLearningSignal(record: OutcomeLearningRecord): LearningSignal {
  const base = { entityId: record.entityId, entityKind: record.entityKind };
  const hasSample = record.sampleSize !== null && Number.isFinite(record.sampleSize) && record.sampleSize > 0;
  const revenue = Number.isFinite(record.revenue) ? record.revenue : 0;
  const cost = Number.isFinite(record.cost) ? record.cost : 0;

  if (!hasSample && revenue === 0 && cost === 0) {
    return {
      ...base,
      status: 'INSUFFICIENT_DATA',
      signal: null,
      reason: 'No sample size, revenue, or cost recorded; no learning signal can be derived without fabricating one.',
    };
  }

  if (record.entityKind === 'EXPERIMENT' && record.result) {
    if (record.result === 'SUCCESS') {
      return { ...base, status: 'SUFFICIENT_DATA', signal: 'SUCCESSFUL_PATTERN', reason: 'Human-recorded experiment result is SUCCESS.' };
    }
    if (record.result === 'FAILURE') {
      return { ...base, status: 'SUFFICIENT_DATA', signal: 'FAILED_HYPOTHESIS', reason: 'Human-recorded experiment result is FAILURE.' };
    }
    return { ...base, status: 'SUFFICIENT_DATA', signal: null, reason: 'Experiment result is INCONCLUSIVE; recorded for provenance but not classified.' };
  }

  if (hasSample && revenue > cost) {
    return {
      ...base,
      status: 'SUFFICIENT_DATA',
      signal: 'SUCCESSFUL_PATTERN',
      reason: `Sample of ${record.sampleSize} with revenue $${revenue.toFixed(2)} > cost $${cost.toFixed(2)}.`,
    };
  }
  if (hasSample && revenue <= cost && revenue > 0) {
    return {
      ...base,
      status: 'SUFFICIENT_DATA',
      signal: 'UNDERPERFORMING',
      reason: `Sample of ${record.sampleSize} with revenue $${revenue.toFixed(2)} ≤ cost $${cost.toFixed(2)}.`,
    };
  }
  if (hasSample && revenue === 0 && cost > 0) {
    return {
      ...base,
      status: 'SUFFICIENT_DATA',
      signal: 'FAILED_HYPOTHESIS',
      reason: `Sample of ${record.sampleSize} produced $0 revenue against $${cost.toFixed(2)} cost.`,
    };
  }
  return {
    ...base,
    status: 'INSUFFICIENT_DATA',
    signal: null,
    reason: 'Recorded data is insufficient for a learning signal; nothing is inferred.',
  };
}
