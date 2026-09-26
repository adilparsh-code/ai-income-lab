// ============================================================================
// AGENCY — SUPERVISOR (Phase 10/11 of the agency upgrade)
// ============================================================================
// Pure module: no DB, no network, no secrets. Deterministic pre/post-run
// evaluation used by the supervised runner. It NEVER executes agents and
// NEVER bypasses the Job Runner; it only inspects a bounded execution plan
// and a bounded run record and returns a verdict with reasons.
// ============================================================================

import {
  LOOP_DETECTORS,
  SUPERVISOR_VERDICTS,
  type AgencyAgentId,
  type LoopDetector,
  type LoopFinding,
  type LoopEvaluation,
  type SupervisorVerdict,
} from './types';

export type SupervisorPlan = {
  agentId: AgencyAgentId;
  stage: string;
  jobType: string;
  budgetUsd: number;
  timeoutMs: number;
  retryCount: number;
};

export type SupervisorRunRecord = {
  status: string; // terminal job status after execution
  fallbackUsed: boolean;
  safetyVerdict: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
  costUsd: number;
};

/** Deterministic loop-protection evaluation over a bounded job history. */
export function evaluateLoops(history: {
  recentIdenticalJobs: number;
  recentIdenticalFailures: number;
  exhaustedRetries: boolean;
  circularDelegation: boolean;
  recentTokenUsage: number;
  recentCostUsd: number;
  repeatedSafetyRejections: number;
  staleWorkflowMinutes: number | null;
}): LoopEvaluation {
  const findings: LoopFinding[] = [];

  if (history.recentIdenticalJobs >= 5) {
    findings.push({ detector: 'REPEATED_IDENTICAL_JOBS', reason: '5+ identical jobs dispatched recently' });
  }
  if (history.recentIdenticalFailures >= 3) {
    findings.push({ detector: 'REPEATED_IDENTICAL_FAILURES', reason: '3+ identical failures recently' });
  }
  if (history.exhaustedRetries) {
    findings.push({ detector: 'RETRY_EXHAUSTION', reason: 'retry budget exhausted for this payload' });
  }
  if (history.circularDelegation) {
    findings.push({ detector: 'CIRCULAR_DELEGATION', reason: 'delegation cycle detected' });
  }
  if (history.recentTokenUsage > 400_000) {
    findings.push({ detector: 'EXCESSIVE_TOKEN_USAGE', reason: 'recent token usage exceeded 400k tokens' });
  }
  if (history.recentCostUsd > 10) {
    findings.push({ detector: 'EXCESSIVE_COST', reason: 'recent spend exceeded $10' });
  }
  if (history.repeatedSafetyRejections >= 3) {
    findings.push({ detector: 'REPEATED_SAFETY_REJECTION', reason: '3+ consecutive safety rejections' });
  }
  if (history.staleWorkflowMinutes !== null && history.staleWorkflowMinutes > 24 * 60) {
    findings.push({ detector: 'STALE_WORKFLOW', reason: 'workflow has been open for more than 24h without progress' });
  }

  return { quarantined: findings.length > 0, findings };
}

/** Pre-run plan check: contract bounds only (the Job Runner enforces reality). */
export function evaluatePlan(plan: SupervisorPlan, contract: {
  allowedStages: readonly string[];
  budgetLimitUsd: number;
  timeoutMs: number;
  maxRetries: number;
}): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!contract.allowedStages.includes(plan.stage)) {
    reasons.push(`stage '${plan.stage}' is outside the agent's allowed stages`);
  }
  if (plan.budgetUsd > contract.budgetLimitUsd) {
    reasons.push(`planned budget $${plan.budgetUsd.toFixed(2)} exceeds the contract cap $${contract.budgetLimitUsd.toFixed(2)}`);
  }
  if (plan.timeoutMs > contract.timeoutMs) {
    reasons.push(`timeout ${plan.timeoutMs}ms exceeds the contract cap ${contract.timeoutMs}ms`);
  }
  if (plan.retryCount > contract.maxRetries) {
    reasons.push(`retry ${plan.retryCount} exceeds the contract cap ${contract.maxRetries}`);
  }
  return { valid: reasons.length === 0, reasons };
}

/** Post-run output check: honest statuses only; fallback is not success. */
export function evaluateOutput(record: SupervisorRunRecord): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (record.status === 'SUCCEEDED' && record.fallbackUsed) {
    reasons.push('status SUCCEEDED cannot be reported with fallbackUsed=true');
  }
  if (record.safetyVerdict === 'NOT_ALLOWED') {
    reasons.push('safety verdict NOT_ALLOWED must never produce executed output');
  }
  if (!Number.isFinite(record.costUsd) || record.costUsd < 0) {
    reasons.push('cost must be a non-negative finite number');
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * Combine plan/output/loop findings into the final deterministic verdict.
 * QUARANTINE on any loop finding; PAUSE on invalid plans/outputs (human
 * review shape); ESCALATE when safety was violated; otherwise PROCEED.
 */
export function supervisorVerdict(input: {
  plan: { valid: boolean; reasons: string[] };
  output: { valid: boolean; reasons: string[] } | null;
  loops: LoopEvaluation;
  safetyViolation: boolean;
}): { verdict: SupervisorVerdict; reasons: string[]; loopDetected: boolean; budgetViolation: boolean; safetyViolation: boolean } {
  const reasons: string[] = [...input.plan.reasons, ...(input.output?.reasons ?? []), ...input.loops.findings.map((f) => `${f.detector}: ${f.reason}`)];
  const loopDetected = input.loops.quarantined;
  let verdict: SupervisorVerdict = 'PROCEED';

  if (input.safetyViolation) verdict = 'ESCALATE';
  else if (loopDetected) verdict = 'QUARANTINE';
  else if (!input.plan.valid || (input.output && !input.output.valid)) verdict = 'PAUSE';

  return {
    verdict,
    reasons: reasons.slice(0, 10),
    loopDetected,
    budgetViolation: input.plan.reasons.some((r) => r.includes('budget')),
    safetyViolation: input.safetyViolation,
  };
}

export function isSupervisorVerdict(value: unknown): value is SupervisorVerdict {
  return typeof value === 'string' && (SUPERVISOR_VERDICTS as readonly string[]).includes(value);
}

export function isLoopDetector(value: unknown): value is LoopDetector {
  return typeof value === 'string' && (LOOP_DETECTORS as readonly string[]).includes(value);
}
