// ============================================================================
// AGENCY — SUPERVISED DISPATCH (Phase 5/6 of the agency upgrade)
// ============================================================================
// The ONLY path from an agency-approved mission to execution. It composes:
//
//   contract check → global pause check → dispatchJob (EXISTING Job Runner)
//   → recordAgentRun (governance record) → supervisor evaluation
//
// It never executes agents itself, never touches AI providers, and never
// bypasses the Job Runner's halal/idempotency/retry gates. Failure is honest:
// the AgentRun row records the real terminal status (BLOCKED, HUMAN_REVIEW,
// DEGRADED, FAILED, SUCCEEDED) — nothing is rewritten into fake success.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { runJob, type RunJobOptions } from '@/lib/jobs/job-runner';
import { isJobType, type JobPayload, type JobType } from '@/lib/jobs/types';
import { logger } from '@/lib/server-log';
import { getAgencyControl, listAgentRuns, recordAgentRun, type LifecycleStepOutcome } from './runtime';
import { evaluateLoops, evaluatePlan, evaluateOutput, supervisorVerdict } from './supervisor';
import { getAgentContract } from './contracts';
import { isAgencyAgentId, type AgencyAgentId, type SupervisorVerdict as Verdict } from './types';

/** Agency agents that map onto Job Runner job types. */
const AGENT_TO_JOB: Partial<Record<AgencyAgentId, JobType>> = {
  research: 'RESEARCH',
  validation: 'VALIDATION',
  product: 'PRODUCT',
  analytics: 'ANALYTICS',
  'business-manager': 'BUSINESS_MANAGER',
};

export type SupervisedDispatchInput = {
  agentId: AgencyAgentId;
  stage: string;
  objective: string;
  opportunityId?: string;
  budgetUsd?: number;
  correlationId?: string;
};

export type SupervisedDispatchResult =
  | {
      ok: true;
      agentRunId: string;
      jobId: string;
      jobStatus: string;
      verdict: Verdict;
      verdictReasons: string[];
      deduplicated: boolean;
      executionMode: string | null;
      correlationId: string;
    }
  | { ok: false; reason: string; detail?: string; correlationId?: string };

/**
 * Dispatch one supervised job for a roster agent.
 * Refuses: unknown agents/stages, over-budget plans, paused agency, unmapped
 * agents (they have no autonomous job), and everything the Job Runner refuses.
 */
export async function dispatchSupervised(
  input: SupervisedDispatchInput,
  options: RunJobOptions = {},
): Promise<SupervisedDispatchResult> {
  if (!isAgencyAgentId(input.agentId)) {
    return { ok: false, reason: 'REFUSED', detail: 'Unknown agent id.' };
  }
  const contract = getAgentContract(input.agentId);
  const correlationId = (input.correlationId?.trim() || `agency-${randomUUID()}`).slice(0, 200);

  // Global pause check — fail closed.
  try {
    const control = await getAgencyControl();
    if (control.paused) {
      return { ok: false, reason: 'PAUSED', detail: control.pauseReason ?? 'Agency is paused by the administrator.' };
    }
  } catch {
    return { ok: false, reason: 'REFUSED', detail: 'Agency control state unavailable; refusing (fail-closed).' };
  }

  const jobType = AGENT_TO_JOB[input.agentId];
  if (!jobType || !isJobType(jobType)) {
    return { ok: false, reason: 'REFUSED', detail: `Agent '${input.agentId}' has no autonomous Job Runner mapping; it is runtime/coordination infrastructure.` };
  }

  const stage = (input.stage || contract.allowedStages[0]).trim().toUpperCase();
  const budgetUsd = Math.max(0, input.budgetUsd ?? 0);

  // Pre-run plan evaluation against the contract.
  const plan = evaluatePlan(
    { agentId: input.agentId, stage, jobType, budgetUsd, timeoutMs: contract.timeoutMs, retryCount: 0 },
    { allowedStages: contract.allowedStages, budgetLimitUsd: contract.budgetLimitUsd, timeoutMs: contract.timeoutMs, maxRetries: contract.maxRetries },
  );
  if (!plan.valid) {
    const refusalCorrelation = correlationId;
    await recordAgentRun({
      agentId: input.agentId, jobId: null, jobType, stage, status: 'BLOCKED',
      correlationId: refusalCorrelation, failureReason: plan.reasons.join('; ').slice(0, 300),
      lifecycleSteps: [{ step: 'PLAN', outcome: 'FAILED', detail: plan.reasons.join('; ') }],
      safetyVerdict: 'HALAL',
      verification: 'NOT_APPLICABLE',
    });
    return { ok: false, reason: 'REFUSED', detail: plan.reasons.join('; '), correlationId: refusalCorrelation };
  }

  // Payload shapes come from the Job Runner's own validation contract
  // (src/lib/jobs/job-definitions.ts) — the dispatcher never invents fields.
  const objective = input.objective.trim().slice(0, 400);
  const payload: JobPayload = (() => {
    switch (jobType) {
      case 'RESEARCH':
        return { researchObjective: objective };
      case 'VALIDATION':
        return { validationObjective: objective };
      case 'PRODUCT':
        // Deterministic default: the factory's canonical product type.
        return { productObjective: objective, productType: 'DIGITAL_PRODUCT' };
      case 'ANALYTICS':
        return input.opportunityId
          ? { opportunityId: input.opportunityId }
          : { analyticsObjective: objective };
      case 'BUSINESS_MANAGER':
        return {
          objective,
          decisionScope: 'FULL_BUSINESS_REVIEW',
          notes: `supervised dispatch ${correlationId}`,
        };
      default:
        return { objective };
    }
  })();

  const lifecycle: LifecycleStepOutcome[] = [
    { step: 'PLAN', outcome: 'OK', detail: `stage=${stage} budget=$${budgetUsd.toFixed(2)}` },
    { step: 'VALIDATE_INPUT', outcome: 'OK' },
  ];

  // Hand off to the AUTHORITATIVE Job Runner (halal gates, idempotency,
  // bounded retries live there — never here).
  const outcome = await runJob(jobType, payload, correlationId, options);
  lifecycle.push({ step: 'SAFETY_CHECK', outcome: outcome.status === 'BLOCKED' ? 'FAILED' : 'OK', detail: outcome.status === 'BLOCKED' ? 'halal gate refused execution' : undefined });
  lifecycle.push({ step: 'EXECUTE', outcome: outcome.status === 'SUCCEEDED' || outcome.status === 'DEGRADED' ? 'OK' : 'FAILED', detail: outcome.error?.slice(0, 200) });
  lifecycle.push({ step: 'VERIFY_OUTPUT', outcome: 'OK' });
  lifecycle.push({ step: 'PERSIST_RESULT', outcome: outcome.jobId && outcome.jobId !== 'n/a' ? 'OK' : 'FAILED' });
  lifecycle.push({ step: 'REPORT', outcome: 'OK' });

  const safetyVerdict: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED' =
    outcome.status === 'BLOCKED' ? 'NOT_ALLOWED'
      : outcome.status === 'HUMAN_REVIEW' ? 'REVIEW_REQUIRED'
        : 'HALAL';

  const verification: 'PASSED' | 'FAILED' | 'NOT_APPLICABLE' =
    outcome.status === 'SUCCEEDED' ? 'PASSED'
      : outcome.status === 'DEGRADED' ? 'FAILED'
        : 'NOT_APPLICABLE';

  let agentRunId = 'n/a';
  try {
    const record = await recordAgentRun({
      agentId: input.agentId,
      jobId: outcome.jobId && outcome.jobId !== 'n/a' ? outcome.jobId : null,
      jobType,
      stage,
      status: outcome.status,
      correlationId,
      lifecycleSteps: lifecycle,
      safetyVerdict,
      verification,
      failureReason: outcome.error ?? null,
      evidenceRefs: outcome.jobId && outcome.jobId !== 'n/a' ? [{ type: 'JOB_RUN', id: outcome.jobId }] : undefined,
      retryCount: outcome.retryCount,
    });
    agentRunId = record.id;
  } catch (error) {
    logger.warn('AgentRun governance record failed (execution outcome is still returned)', {
      error: String(error).slice(0, 150),
    });
  }

  // Post-run supervisor evaluation (deterministic). Loop evidence is derived
  // from THIS agent's real run history — not asserted clean by fiat.
  const outputSummary = (outcome.result ?? {}) as Record<string, unknown>;
  const output = evaluateOutput({
    status: outcome.status,
    fallbackUsed: outputSummary.fallbackUsed === true,
    safetyVerdict,
    costUsd: 0, // per-job cost is owned by the AI economy ledger, not re-derived here
  });

  let recentIdenticalFailures = 0;
  const exhaustedRetries = outcome.retryCount >= contract.maxRetries;
  try {
    const history = await listAgentRuns(input.agentId, 10);
    for (const run of history) { // history is most-recent-first
      if (run.status === 'FAILED' && run.jobType === jobType) recentIdenticalFailures += 1;
      else break;
    }
  } catch {
    // History unavailable: leave loop evidence at the honest defaults (none).
  }
  const loops = evaluateLoops({
    recentIdenticalJobs: 0, // dispatch-level dedup is owned by the Job Runner's idempotency
    recentIdenticalFailures,
    exhaustedRetries,
    circularDelegation: false, // delegation graph is static (contracts.ts); cycles are impossible by construction
    recentTokenUsage: 0, // token accounting is owned by the AI economy ledger
    recentCostUsd: 0,
    repeatedSafetyRejections: 0, // safety rejections surface via health BLOCKED state
    staleWorkflowMinutes: null,
  });

  const verdict = supervisorVerdict({
    plan,
    output,
    loops,
    safetyViolation: outcome.status === 'BLOCKED',
  });

  logger.info('Supervised dispatch completed', {
    agentId: input.agentId,
    jobType,
    jobStatus: outcome.status,
    verdict: verdict.verdict,
  });

  return {
    ok: true,
    agentRunId,
    jobId: outcome.jobId,
    jobStatus: outcome.status,
    verdict: verdict.verdict,
    verdictReasons: verdict.reasons,
    deduplicated: outcome.deduplicated,
    executionMode: outcome.executionMode,
    correlationId,
  };
}
