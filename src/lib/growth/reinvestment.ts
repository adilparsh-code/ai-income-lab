// Phase 9 — Reinvestment Recommendation Engine + Portfolio Resource Allocation.
//
// Produces AUDITABLE reinvestment recommendations from verified data only.
// A recommendation is a bounded proposal: it names the maximum spend, the stop
// condition, and the evidence. Nothing is spent by this module — actual spend
// flows only through budget.ts validation + the Job Runner.

import {
  MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY,
  MAX_EXPERIMENT_BUDGET_USD,
  MAX_MONTHLY_BUDGET_USD,
  type GrowthDecisionType,
} from './types';

export interface ReinvestmentInput {
  opportunityId: string;
  health: string; // GrowthHealthState
  netRevenueUsd: number;
  costsUsd: number;
  visitors: number;
  conversions: number;
  remainingMonthlyBudgetUsd: number;
  validatedLearnings: number;
  invalidatedLearnings: number;
  suggestedExperimentType: string; // EXPERIMENT_TYPES value from the caller
  suggestedMetric: string;
  suggestedTargetValue: number;
  requestedBudgetUsd: number;
  expectedInformationGain: string; // human-readable justification of what the experiment will prove
  stopCondition: string;
}

export interface ReinvestmentRecommendation {
  opportunityId: string;
  recommended: boolean;
  decision: GrowthDecisionType;
  recommendedExperimentType: string;
  recommendedMetric: string;
  targetValue: number;
  maximumSpendUsd: number;
  expectedInformationGain: string;
  stopCondition: string;
  reason: string;
  evidence: string[]; // deterministic evidence trace
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

/**
 * Documented reinvestment rules:
 *  - BLOCKED/STOPPED health or NOT_ALLOWED halal → never recommended.
 *  - NEEDS_DATA → no spend; recommend a $0 experiment (analytics-only) or none.
 *  - PAUSE/UNDERPERFORMING → iterate-type experiment with the smallest
 *    bounded budget that can answer the hypothesis (capped by both the hard
 *    cap and remaining monthly budget).
 *  - HEALTHY with validated learning → scale-support experiment within budget.
 *  - Otherwise (WATCH) → no recommendation; collect more evidence.
 */
export function recommendReinvestment(input: ReinvestmentInput): ReinvestmentRecommendation {
  const evidence: string[] = [
    `netRevenue=$${input.netRevenueUsd.toFixed(2)}`,
    `costs=$${input.costsUsd.toFixed(2)}`,
    `visitors=${input.visitors}`,
    `conversions=${input.conversions}`,
    `validatedLearnings=${input.validatedLearnings}`,
    `invalidatedLearnings=${input.invalidatedLearnings}`,
    `remainingMonthlyBudget=$${input.remainingMonthlyBudgetUsd.toFixed(2)}`,
  ];

  const base = {
    opportunityId: input.opportunityId,
    recommendedExperimentType: input.suggestedExperimentType,
    recommendedMetric: input.suggestedMetric,
    targetValue: input.suggestedTargetValue,
    expectedInformationGain: input.expectedInformationGain,
    stopCondition: input.stopCondition,
  };

  if (input.health === 'BLOCKED' || input.health === 'STOPPED') {
    return {
      ...base,
      recommended: false,
      decision: 'STOP',
      maximumSpendUsd: 0,
      reason: `Opportunity health is ${input.health}; no reinvestment.`,
      evidence,
      confidence: 'HIGH',
    };
  }
  if (input.health === 'NEEDS_DATA') {
    return {
      ...base,
      recommended: false,
      decision: 'CONTINUE',
      maximumSpendUsd: 0,
      reason: 'Insufficient recorded data — collect evidence before any spend.',
      evidence,
      confidence: 'LOW',
    };
  }

  const profit = input.netRevenueUsd - input.costsUsd;
  if (profit < 0) {
    return {
      ...base,
      recommended: false,
      decision: 'PAUSE',
      maximumSpendUsd: 0,
      reason: `Contribution-negative (profit $${profit.toFixed(2)}); pause spend before iterating.`,
      evidence,
      confidence: 'HIGH',
    };
  }

  const budgetCap = Math.min(
    Math.max(0, input.requestedBudgetUsd),
    MAX_EXPERIMENT_BUDGET_USD,
    Math.max(0, input.remainingMonthlyBudgetUsd),
  );

  if (budgetCap <= 0) {
    return {
      ...base,
      recommended: false,
      decision: 'ITERATE',
      maximumSpendUsd: 0,
      reason: 'No remaining monthly budget; iterate with a $0 (analytics-only) experiment or wait for the next period.',
      evidence,
      confidence: 'MEDIUM',
    };
  }

  if (input.health === 'UNDERPERFORMING') {
    return {
      ...base,
      recommended: true,
      decision: 'ITERATE',
      maximumSpendUsd: budgetCap,
      reason: `Traffic without conversions — one bounded ${input.suggestedExperimentType} experiment (max $${budgetCap.toFixed(2)}) to test the hypothesis.`,
      evidence,
      confidence: 'MEDIUM',
    };
  }
  if (input.health === 'HEALTHY' && input.validatedLearnings > 0) {
    return {
      ...base,
      recommended: true,
      decision: 'SCALE_WITHIN_BUDGET',
      maximumSpendUsd: budgetCap,
      reason: `Validated economics — bounded ${input.suggestedExperimentType} experiment (max $${budgetCap.toFixed(2)}) to confirm scale-up within budget.`,
      evidence,
      confidence: 'HIGH',
    };
  }

  return {
    ...base,
    recommended: false,
    decision: 'CONTINUE',
    maximumSpendUsd: 0,
    reason: `Health ${input.health} without a decisive signal — collect more evidence first.`,
    evidence,
    confidence: 'LOW',
  };
}

// ---------------------------------------------------------------------------
// Portfolio Resource Allocation (pure part; persistence in portfolio.ts)
// ---------------------------------------------------------------------------

export interface AllocationInput {
  monthlyBudgetUsd: number;
  perExperimentCapUsd: number;
  maxActiveExperiments: number;
}

export type AllocationVerdict =
  | { ok: true; monthlyBudgetUsd: number; perExperimentCapUsd: number; maxActiveExperiments: number; notes: string[] }
  | { ok: false; errors: string[] };

/**
 * Validate a proposed allocation against the hard system caps. The engine can
 * propose allocations only DOWNWARD; anything above the caps is an error.
 */
export function validateAllocation(input: AllocationInput): AllocationVerdict {
  const errors: string[] = [];
  const notes: string[] = [];
  const monthly = typeof input.monthlyBudgetUsd === 'number' && Number.isFinite(input.monthlyBudgetUsd) ? input.monthlyBudgetUsd : NaN;
  const perCap = typeof input.perExperimentCapUsd === 'number' && Number.isFinite(input.perExperimentCapUsd) ? input.perExperimentCapUsd : NaN;
  const maxActive = input.maxActiveExperiments;

  if (!Number.isFinite(monthly) || monthly < 0) errors.push('monthlyBudgetUsd must be a non-negative finite number');
  else if (monthly > MAX_MONTHLY_BUDGET_USD) errors.push(`monthlyBudgetUsd exceeds the hard system cap $${MAX_MONTHLY_BUDGET_USD}`);
  if (!Number.isFinite(perCap) || perCap < 0) errors.push('perExperimentCapUsd must be a non-negative finite number');
  else if (perCap > MAX_EXPERIMENT_BUDGET_USD) errors.push(`perExperimentCapUsd exceeds the hard per-experiment cap $${MAX_EXPERIMENT_BUDGET_USD}`);
  else if (Number.isFinite(monthly) && perCap > monthly) notes.push('perExperimentCapUsd exceeds the monthly budget; effective cap will be the remaining monthly budget.');
  if (!Number.isInteger(maxActive) || maxActive < 0) errors.push('maxActiveExperiments must be a non-negative integer');
  else if (maxActive > MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY) errors.push(`maxActiveExperiments exceeds the hard cap ${MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY}`);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, monthlyBudgetUsd: monthly, perExperimentCapUsd: perCap, maxActiveExperiments: maxActive, notes };
}
