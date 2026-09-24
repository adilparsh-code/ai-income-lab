export type SimulationMode = 'SIMULATED';
export type SimulationOutcome = 'PROFITABLE' | 'LOSING' | 'FLAT';

export interface SimulationInput {
  seed: number;
  visitors: number;
  conversionRate: number;
  priceUsd: number;
  costPerVisitorUsd: number;
  fixedCostUsd: number;
}

export interface SimulationResult {
  mode: SimulationMode;
  seed: number;
  visitors: number;
  conversions: number;
  conversionRate: number;
  revenueUsd: number;
  costsUsd: number;
  profitUsd: number;
  outcome: SimulationOutcome;
  note: 'No real traffic, transaction, revenue, or external action occurred.';
}

function clampNonNegative(value: number): number { return Number.isFinite(value) ? Math.max(0, value) : 0; }
function boundedRate(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }

/** Repeatable pseudo-random conversion sampling. This is simulation only, never a real metric. */
export function runSimulation(input: SimulationInput): SimulationResult {
  const visitors = Math.round(clampNonNegative(input.visitors));
  const conversionRate = boundedRate(input.conversionRate);
  const price = clampNonNegative(input.priceUsd);
  const trafficCost = clampNonNegative(input.costPerVisitorUsd) * visitors;
  const costs = trafficCost + clampNonNegative(input.fixedCostUsd);
  // Deterministic seeded rounding jitter keeps scenarios repeatable without pretending to predict reality.
  const jitter = ((Math.abs(Math.trunc(input.seed)) % 101) - 50) / 10_000;
  const conversions = Math.max(0, Math.min(visitors, Math.round(visitors * (conversionRate + jitter))));
  const revenue = conversions * price;
  const profit = Number((revenue - costs).toFixed(2));
  return {
    mode: 'SIMULATED', seed: input.seed, visitors, conversions,
    conversionRate: visitors === 0 ? 0 : Number((conversions / visitors).toFixed(4)),
    revenueUsd: Number(revenue.toFixed(2)), costsUsd: Number(costs.toFixed(2)), profitUsd: profit,
    outcome: profit > 0 ? 'PROFITABLE' : profit < 0 ? 'LOSING' : 'FLAT',
    note: 'No real traffic, transaction, revenue, or external action occurred.',
  };
}

export interface SimulationDecisionInput {
  profitUsd: number;
  conversionRate: number;
  evidenceType: 'VERIFIED_DATA' | 'SIMULATED' | 'AI_INFERENCE';
  humanDecision?: 'CONTINUE' | 'PAUSE' | 'KILL' | 'SCALE' | 'ITERATE';
}

export type LifecycleDecision = 'CONTINUE' | 'ITERATE' | 'PAUSE' | 'KILL' | 'SCALE' | 'HUMAN_REVIEW';

/** Human decisions dominate; simulated outcomes never authorize real scale actions. */
export function decideLifecycle(input: SimulationDecisionInput): { decision: LifecycleDecision; reason: string; executionEligible: boolean } {
  if (input.humanDecision) return { decision: input.humanDecision, reason: 'Human decision is authoritative.', executionEligible: false };
  if (input.evidenceType !== 'VERIFIED_DATA') return { decision: 'HUMAN_REVIEW', reason: 'Non-verified evidence cannot authorize autonomous lifecycle action.', executionEligible: false };
  if (input.profitUsd <= 0 && input.conversionRate < 0.01) return { decision: 'KILL', reason: 'Verified economics are negative and conversion is below the kill threshold.', executionEligible: false };
  if (input.profitUsd <= 0) return { decision: 'ITERATE', reason: 'Verified economics are not positive; iterate before spending more.', executionEligible: true };
  if (input.profitUsd > 0 && input.conversionRate >= 0.02) return { decision: 'SCALE', reason: 'Verified positive economics meet the scale candidate threshold; human approval remains required.', executionEligible: false };
  return { decision: 'CONTINUE', reason: 'Verified signal is promising but does not meet the scale threshold.', executionEligible: true };
}

export const SIMULATION_E2E_PATHS = [
  'NOT_ALLOWED_OPPORTUNITY', 'REVIEW_REQUIRED_OPPORTUNITY', 'FAILED_VALIDATION', 'TIMEOUT', 'TRANSIENT_PROVIDER_FAILURE',
  'PERMANENT_FAILURE', 'DUPLICATE_EXECUTION', 'RETRY', 'HUMAN_APPROVAL_REQUIRED', 'SIMULATED_PROFITABLE',
  'SIMULATED_LOSING', 'KILL_PATH', 'PAUSE_PATH', 'ITERATION_PATH', 'SCALE_CANDIDATE',
] as const;
