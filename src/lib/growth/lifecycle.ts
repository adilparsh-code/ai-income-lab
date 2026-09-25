// Phase 9 — Experiment Lifecycle Manager + Stop-Loss rules (deterministic).
//
// Owns the bounded lifecycle: DRAFT → ACTIVE → (COMPLETED | STOPPED | BLOCKED
// | HUMAN_REVIEW). Every transition is decided by documented rules over
// recorded data; AI has no vote. This module is PURE: callers (experiments.ts)
// perform the DB writes and Job Runner handoff.

import {
  MAX_EXPERIMENT_EXECUTION_ATTEMPTS,
  MAX_EXPERIMENT_FAILURES,
  type ExperimentStatus,
} from './types';

export interface LifecycleState {
  status: ExperimentStatus;
  executionAttempts: number;
  failureCount: number;
  spentUsd: number;
  budgetUsd: number;
  endsAt: Date;
  stopLossThreshold: number;
  measuredValueUsd: number; // revenue attributed to the experiment so far
  halalStatus: string;
}

export type LifecycleAction =
  | 'KEEP_ACTIVE'
  | 'COMPLETE'
  | 'STOP_STOP_LOSS'
  | 'STOP_FAILURE_THRESHOLD'
  | 'STOP_BUDGET'
  | 'STOP_EXPIRED'
  | 'BLOCK_HALAL'
  | 'PAUSE_HUMAN_REVIEW'
  | 'REFUSE_ATTEMPT_LIMIT';

export interface LifecycleDecisionResult {
  action: LifecycleAction;
  nextStatus: ExperimentStatus;
  reason: string;
}

/**
 * Documented lifecycle rules (evaluated in order; first match wins):
 *  1. halal NOT_ALLOWED            → BLOCKED (hard gate, always first)
 *  2. halal REVIEW_REQUIRED        → HUMAN_REVIEW (AI cannot approve)
 *  3. executionAttempts ≥ MAX      → refusal to execute again (bounded)
 *  4. failureCount ≥ MAX_FAILURES  → STOPPED (failure threshold)
 *  5. spent ≥ budget               → STOPPED (budget exhausted)
 *  6. now ≥ endsAt                 → STOPPED (duration bound)
 *  7. measured loss ≥ stopLoss     → STOPPED (stop-loss)
 *  8. target reached               → COMPLETED (success condition)
 *  9. otherwise                    → KEEP_ACTIVE
 */
export function decideLifecycle(state: LifecycleState, now: Date): LifecycleDecisionResult {
  if (state.halalStatus === 'NOT_ALLOWED') {
    return { action: 'BLOCK_HALAL', nextStatus: 'BLOCKED', reason: 'Halal status is NOT_ALLOWED; experiment hard-blocked.' };
  }
  if (state.halalStatus === 'REVIEW_REQUIRED') {
    return { action: 'PAUSE_HUMAN_REVIEW', nextStatus: 'HUMAN_REVIEW', reason: 'Halal REVIEW_REQUIRED; a qualified human must review.' };
  }
  if (state.executionAttempts >= MAX_EXPERIMENT_EXECUTION_ATTEMPTS) {
    return {
      action: 'REFUSE_ATTEMPT_LIMIT',
      nextStatus: state.status,
      reason: `Execution attempt limit (${MAX_EXPERIMENT_EXECUTION_ATTEMPTS}) reached; no further attempts.`,
    };
  }
  if (state.failureCount >= MAX_EXPERIMENT_FAILURES) {
    return { action: 'STOP_FAILURE_THRESHOLD', nextStatus: 'STOPPED', reason: `Failure threshold (${MAX_EXPERIMENT_FAILURES}) reached.` };
  }
  if (state.spentUsd >= state.budgetUsd && state.budgetUsd > 0) {
    return { action: 'STOP_BUDGET', nextStatus: 'STOPPED', reason: `Budget exhausted ($${state.spentUsd.toFixed(2)}/$${state.budgetUsd.toFixed(2)}).` };
  }
  if (state.endsAt.getTime() <= now.getTime()) {
    return { action: 'STOP_EXPIRED', nextStatus: 'STOPPED', reason: 'Maximum experiment duration elapsed.' };
  }
  const loss = state.spentUsd - state.measuredValueUsd;
  if (state.stopLossThreshold > 0 && loss >= state.stopLossThreshold) {
    return { action: 'STOP_STOP_LOSS', nextStatus: 'STOPPED', reason: `Stop-loss triggered: net position -$${loss.toFixed(2)} ≥ threshold $${state.stopLossThreshold.toFixed(2)}.` };
  }
  return { action: 'KEEP_ACTIVE', nextStatus: 'ACTIVE', reason: 'Within all bounds; experiment continues.' };
}

export interface CompletionEvaluation {
  targetValue: number;
  measuredValue: number | null; // null when insufficient data
}

/** Pure completion check used once an experiment is being finalized. */
export function completionVerdict(eval0: CompletionEvaluation): 'TARGET_REACHED' | 'TARGET_MISSED' | 'INCONCLUSIVE' {
  if (eval0.measuredValue === null) return 'INCONCLUSIVE';
  return eval0.measuredValue >= eval0.targetValue ? 'TARGET_REACHED' : 'TARGET_MISSED';
}

/** Bounded attempt increment: refuses to exceed the hard cap. */
export function nextAttempt(current: number): { allowed: boolean; attempts: number } {
  const attempts = current + 1;
  return { allowed: attempts <= MAX_EXPERIMENT_EXECUTION_ATTEMPTS, attempts: Math.min(attempts, MAX_EXPERIMENT_EXECUTION_ATTEMPTS) };
}
