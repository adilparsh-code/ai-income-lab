// Phase 9 — Experiment Budget Manager (deterministic gatekeeping).
//
// Every experiment creation passes through this module's validation BEFORE any
// DB write or job execution. Caps are hard constants (types.ts) and are NOT
// configurable at runtime — the autonomous loop can never raise them.

import {
  EXPERIMENT_TYPES,
  EXPERIMENT_METRICS,
  MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY,
  MAX_EXPERIMENT_BUDGET_USD,
  MAX_EXPERIMENT_DURATION_DAYS,
  MAX_HYPOTHESIS_LENGTH,
  MAX_MONTHLY_BUDGET_USD,
  clampBudget,
  type BudgetSnapshot,
} from './types';

export interface ExperimentRequest {
  opportunityId: string;
  experimentType: string;
  hypothesis: string;
  metric: string;
  targetValue: number;
  requestedBudgetUsd: number;
  requestedDurationDays: number;
  correlationId: string;
}

export interface BudgetCheckContext {
  allocation: BudgetSnapshot | null; // null → no allocation yet created
  activeExperimentCount: number;
}

export type BudgetVerdict =
  | { ok: true; budgetUsd: number; durationDays: number; notes: string[] }
  | { ok: false; errors: string[] };

export function validateExperimentRequest(request: ExperimentRequest, ctx: BudgetCheckContext): BudgetVerdict {
  const errors: string[] = [];
  const notes: string[] = [];

  if (typeof request.opportunityId !== 'string' || request.opportunityId.trim().length === 0 || request.opportunityId.length > 128) {
    errors.push('opportunityId is required (max 128 chars)');
  }
  if (typeof request.hypothesis !== 'string' || request.hypothesis.trim().length === 0) {
    errors.push('hypothesis is required');
  } else if (request.hypothesis.length > MAX_HYPOTHESIS_LENGTH) {
    errors.push(`hypothesis must be at most ${MAX_HYPOTHESIS_LENGTH} characters`);
  }
  if (!(EXPERIMENT_TYPES as readonly string[]).includes(request.experimentType)) {
    errors.push(`experimentType must be one of: ${EXPERIMENT_TYPES.join(', ')}`);
  }
  if (!(EXPERIMENT_METRICS as readonly string[]).includes(request.metric)) {
    errors.push(`metric must be one of: ${EXPERIMENT_METRICS.join(', ')}`);
  }
  if (typeof request.targetValue !== 'number' || !Number.isFinite(request.targetValue) || request.targetValue <= 0) {
    errors.push('targetValue must be a positive finite number');
  }
  if (typeof request.correlationId !== 'string' || request.correlationId.trim().length === 0 || request.correlationId.length > 200) {
    errors.push('correlationId is required (max 200 chars)');
  }

  // ---- Hard budget gate -------------------------------------------------
  const requestedBudget = typeof request.requestedBudgetUsd === 'number' && Number.isFinite(request.requestedBudgetUsd)
    ? request.requestedBudgetUsd
    : -1;
  if (requestedBudget < 0) {
    errors.push('requestedBudgetUsd must be a non-negative finite number');
  } else if (requestedBudget > MAX_EXPERIMENT_BUDGET_USD) {
    errors.push(`requestedBudgetUsd $${requestedBudget} exceeds the hard per-experiment cap $${MAX_EXPERIMENT_BUDGET_USD}`);
  }

  // ---- Hard duration gate ------------------------------------------------
  const requestedDuration = Number.isInteger(request.requestedDurationDays) ? request.requestedDurationDays : -1;
  if (requestedDuration <= 0) {
    errors.push('requestedDurationDays must be a positive integer');
  } else if (requestedDuration > MAX_EXPERIMENT_DURATION_DAYS) {
    errors.push(`requestedDurationDays ${requestedDuration} exceeds the hard cap ${MAX_EXPERIMENT_DURATION_DAYS}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---- Allocation-aware caps (still deterministic; never raised by the loop)
  let budgetUsd = clampBudget(requestedBudget, MAX_EXPERIMENT_BUDGET_USD);
  const durationDays = Math.min(requestedDuration, MAX_EXPERIMENT_DURATION_DAYS);

  if (ctx.allocation?.paused) {
    return { ok: false, errors: ['Resource allocation for this opportunity is paused; no new experiments may start.'] };
  }

  if (ctx.allocation) {
    const perCap = ctx.allocation.perExperimentCapUsd;
    if (budgetUsd > perCap) {
      budgetUsd = clampBudget(budgetUsd, perCap);
      notes.push(`Budget clamped to the allocation's per-experiment cap $${perCap}.`);
    }
    const remaining = ctx.allocation.monthlyBudgetUsd - ctx.allocation.spentThisMonthUsd;
    if (remaining <= 0) {
      return { ok: false, errors: ['Monthly budget exhausted for this opportunity; no new experiments may start.'] };
    }
    if (budgetUsd > remaining) {
      budgetUsd = clampBudget(remaining, MAX_EXPERIMENT_BUDGET_USD);
      notes.push(`Budget clamped to remaining monthly budget $${remaining.toFixed(2)}.`);
    }
    if (ctx.allocation.monthlyBudgetUsd > MAX_MONTHLY_BUDGET_USD) {
      return { ok: false, errors: [`Allocation monthlyBudgetUsd exceeds the hard system cap $${MAX_MONTHLY_BUDGET_USD}.`] };
    }
    const maxActive = Math.min(ctx.allocation.maxActiveExperiments, MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY);
    if (ctx.activeExperimentCount >= maxActive) {
      return { ok: false, errors: [`Active experiment limit reached (${ctx.activeExperimentCount}/${maxActive}).`] };
    }
  } else {
    // No allocation row: system caps still apply, spend stays at $0 until an
    // allocation exists — a fail-closed default.
    budgetUsd = 0;
    notes.push('No ResourceAllocation row: budget forced to $0 (fail-closed) until an allocation is created.');
  }

  return { ok: true, budgetUsd, durationDays, notes };
}

/** Deterministic daily spend check for an ACTIVE experiment. */
export function canSpend(parts: {
  spentUsd: number;
  budgetUsd: number;
  monthlySpentUsd: number;
  monthlyBudgetUsd: number;
}): { allowed: boolean; reason: string } {
  if (parts.spentUsd >= parts.budgetUsd) {
    return { allowed: false, reason: `Experiment budget exhausted ($${parts.spentUsd.toFixed(2)}/$${parts.budgetUsd.toFixed(2)}).` };
  }
  if (parts.monthlySpentUsd >= parts.monthlyBudgetUsd) {
    return { allowed: false, reason: `Monthly opportunity budget exhausted ($${parts.monthlySpentUsd.toFixed(2)}/$${parts.monthlyBudgetUsd.toFixed(2)}).` };
  }
  return { allowed: true, reason: 'Within experiment and monthly budget.' };
}

/** Bounded duration/expiry evaluation (deterministic; now supplied by caller). */
export function isExpired(endsAt: Date, now: Date): boolean {
  return endsAt.getTime() <= now.getTime();
}

export const BUDGET_LIMITS = {
  maxExperimentBudgetUsd: MAX_EXPERIMENT_BUDGET_USD,
  maxExperimentDurationDays: MAX_EXPERIMENT_DURATION_DAYS,
  maxMonthlyBudgetUsd: MAX_MONTHLY_BUDGET_USD,
  maxActiveExperiments: MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY,
} as const;
