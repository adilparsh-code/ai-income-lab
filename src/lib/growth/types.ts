// Phase 9 — shared types + hard caps for the Autonomous Growth & Optimization
// Engine. Pure module: no DB, no network, no secrets.
//
// Design rules (enforced across the growth layer):
// - Every health state, trend, decision, and score is DETERMINISTIC and
//   EXPLAINABLE — the same recorded data always yields the same output, and
//   every output carries a human-readable rule trace.
// - Budgets are hard-capped here and enforced before any experiment is
//   created. The autonomous loop can never raise a cap.
// - Metrics come only from recorded evidence (ProductEvent, Revenue,
//   GrowthExperiment). Nothing is ever fabricated.

export const GROWTH_HEALTH_STATES = [
  'HEALTHY',
  'WATCH',
  'NEEDS_DATA',
  'UNDERPERFORMING',
  'STOPPED',
  'BLOCKED',
] as const;
export type GrowthHealthState = (typeof GROWTH_HEALTH_STATES)[number];

export function isGrowthHealthState(value: unknown): value is GrowthHealthState {
  return typeof value === 'string' && (GROWTH_HEALTH_STATES as readonly string[]).includes(value);
}

export const GROWTH_TRENDS = ['UP', 'FLAT', 'DOWN', 'UNKNOWN'] as const;
export type GrowthTrend = (typeof GROWTH_TRENDS)[number];

export const GROWTH_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type GrowthConfidence = (typeof GROWTH_CONFIDENCE)[number];

/** Phase 9 decision vocabulary (distinct from Phase 8 LifecycleDecision). */
export const GROWTH_DECISIONS = [
  'CONTINUE',
  'ITERATE',
  'PAUSE',
  'STOP',
  'SCALE_WITHIN_BUDGET',
  'NEEDS_HUMAN_REVIEW',
] as const;
export type GrowthDecisionType = (typeof GROWTH_DECISIONS)[number];

export const EXPERIMENT_TYPES = [
  'LANDING_PAGE',
  'CTA',
  'PRICING',
  'CONTENT',
  'TRAFFIC_SOURCE',
  'POSITIONING',
  'ONBOARDING',
] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];

export const EXPERIMENT_METRICS = [
  'CONVERSION_RATE',
  'CTR',
  'REVENUE_PER_VISITOR',
  'SIGNUPS',
  'REVENUE',
] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

export const EXPERIMENT_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'STOPPED',
  'BLOCKED',
  'HUMAN_REVIEW',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const TERMINAL_EXPERIMENT_STATUSES: readonly ExperimentStatus[] = [
  'COMPLETED', 'STOPPED', 'BLOCKED',
];

// ---------------------------------------------------------------------------
// HARD BUDGET CAPS — enforced in code; the loop can never raise them.
// ---------------------------------------------------------------------------

/** Absolute per-experiment spend cap (USD). */
export const MAX_EXPERIMENT_BUDGET_USD = 25;
/** Absolute per-experiment duration cap (days). */
export const MAX_EXPERIMENT_DURATION_DAYS = 30;
/** Maximum execution attempts per experiment (bounded retries). */
export const MAX_EXPERIMENT_EXECUTION_ATTEMPTS = 3;
/** Maximum consecutive failures before an experiment must stop. */
export const MAX_EXPERIMENT_FAILURES = 2;
/** Absolute monthly spend cap per opportunity (USD). */
export const MAX_MONTHLY_BUDGET_USD = 100;
/** Maximum concurrently ACTIVE experiments per opportunity. */
export const MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY = 3;
/** Minimum visitors before a conversion-rate comparison is supported. */
export const MIN_VISITORS_FOR_COMPARISON = 30;
/** Minimum baseline/variant delta considered a lift (relative). */
export const MIN_RELATIVE_LIFT = 0.1;
/** Maximum days without any activity before WATCH triggers. */
export const STALE_DAYS = 7;
/** Minimum recorded visitors for NEEDS_DATA to be lifted. */
export const MIN_VISITORS_FOR_HEALTH = 30;
/** Net-loss threshold (USD) for UNDERPERFORMING. */
export const UNDERPERFORMANCE_NET_LOSS_USD = 0;

export const MAX_HYPOTHESIS_LENGTH = 1000;
export const MAX_CORRELATION_ID_LENGTH = 200;
export const MAX_CONTEXT_LENGTH = 400;
export const MAX_APPLICABILITY_LENGTH = 400;
export const MAX_NOTE_LENGTH = 400;

export const LEARNING_RESULTS = ['VALIDATED', 'INVALIDATED', 'INCONCLUSIVE'] as const;
export type LearningResult = (typeof LEARNING_RESULTS)[number];

export const EVIDENCE_TYPES = ['VERIFIED_DATA', 'HUMAN_DECISION', 'AI_INFERENCE', 'SEARCH_DISCOVERY'] as const;
export type GrowthEvidenceType = (typeof EVIDENCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Deterministic metric containers
// ---------------------------------------------------------------------------

export interface RecordedFunnelMetrics {
  visitors: number;
  conversions: number;
  grossRevenueUsd: number;
  refundedUsd: number;
  evidenceStatus: 'SUPPORTED' | 'INSUFFICIENT_DATA';
}

export interface RecordedRevenueMetrics {
  netRevenueUsd: number;
  advertisingCostUsd: number;
  otherCostsUsd: number;
  currency: string;
}

export interface ExperimentMetrics {
  variantVisitors: number;
  variantConversions: number;
  variantValueUsd: number;
  controlValueUsd: number;
}

export interface BudgetSnapshot {
  monthlyBudgetUsd: number;
  spentThisMonthUsd: number;
  perExperimentCapUsd: number;
  maxActiveExperiments: number;
  paused: boolean;
}

export function clampBudget(value: unknown, cap: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(cap, n));
}
