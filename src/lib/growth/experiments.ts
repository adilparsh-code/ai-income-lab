// Phase 9 — Growth Experiment Engine (persistence + Job Runner handoff).
//
// Creates and advances bounded experiments. Every mutation path:
//  - validates the request through budget.ts (hard caps, allocation-aware),
//  - enforces halal gates from the Opportunity row,
//  - is idempotent on the caller-supplied idempotencyKey,
//  - hands real execution to the EXISTING Job Runner (runJob ANALYTICS) and
//    never invokes agents/AI directly.
// Failure counting is bounded (MAX_EXPERIMENT_EXECUTION_ATTEMPTS /
// MAX_EXPERIMENT_FAILURES); a dead-lettered experiment never re-executes.

import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { runJob } from '@/lib/jobs/job-runner';
import { logger } from '@/lib/server-log';
import { validateExperimentRequest, type BudgetCheckContext } from './budget';
import { decideLifecycle, nextAttempt } from './lifecycle';
import { evaluateExperiment } from './attribution';
import { recordGrowthDecision } from './decisions';
import {
  MAX_EXPERIMENT_EXECUTION_ATTEMPTS,
  MAX_EXPERIMENT_FAILURES,
  TERMINAL_EXPERIMENT_STATUSES,
  type ExperimentMetric,
  type ExperimentStatus,
} from './types';

const MAX_IDEMPOTENCY_KEY = 200;

export interface CreateExperimentInput {
  opportunityId: string;
  experimentType: string;
  hypothesis: string;
  metric: string;
  targetValue: number;
  requestedBudgetUsd: number;
  requestedDurationDays: number;
  idempotencyKey: string;
  correlationId: string;
}

export type CreateExperimentResult =
  | { ok: true; experimentId: string; status: ExperimentStatus; deduplicated: boolean; notes: string[] }
  | { ok: false; status: 400 | 403 | 404 | 429 | 503; error: string; errors?: string[] };

function experimentIdempotencyKey(opportunityId: string, callerKey: string): string {
  const digest = createHash('sha256').update(`${opportunityId}:${callerKey}`).digest('hex').slice(0, 32);
  return `growth-exp:${digest}`;
}

export async function createGrowthExperiment(input: CreateExperimentInput): Promise<CreateExperimentResult> {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
    return { ok: false, status: 400, error: `idempotencyKey is required (max ${MAX_IDEMPOTENCY_KEY} chars)` };
  }

  // 1. Opportunity + halal gate (fail-closed: unknown opportunity is refused).
  const opportunity = await db.opportunity.findUnique({
    where: { id: input.opportunityId },
    select: { id: true, halalStatus: true },
  });
  if (!opportunity) {
    return { ok: false, status: 404, error: 'Opportunity not found. No experiment was created.' };
  }
  if (opportunity.halalStatus === 'NOT_ALLOWED') {
    return { ok: false, status: 403, error: 'Opportunity halalStatus is NOT_ALLOWED. No experiment may be created.' };
  }

  const key = experimentIdempotencyKey(input.opportunityId, input.idempotencyKey);

  // 2. Idempotency: same logical experiment returns the existing row.
  const existing = await db.growthExperiment.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    return { ok: true, experimentId: existing.id, status: existing.status as ExperimentStatus, deduplicated: true, notes: [] };
  }

  // 3. Budget validation (hard caps + allocation-aware clamping).
  const activeCount = await db.growthExperiment.count({
    where: { opportunityId: input.opportunityId, status: 'ACTIVE' },
  });
  const allocation = await db.resourceAllocation.findUnique({ where: { opportunityId: input.opportunityId } });
  const budgetCtx: BudgetCheckContext = {
    allocation: allocation
      ? {
          monthlyBudgetUsd: allocation.monthlyBudgetUsd,
          spentThisMonthUsd: allocation.spentThisMonthUsd,
          perExperimentCapUsd: allocation.perExperimentCapUsd,
          maxActiveExperiments: allocation.maxActiveExperiments,
          paused: allocation.paused,
        }
      : null,
    activeExperimentCount: activeCount,
  };
  const verdict = validateExperimentRequest(
    {
      opportunityId: input.opportunityId,
      experimentType: input.experimentType,
      hypothesis: input.hypothesis,
      metric: input.metric,
      targetValue: input.targetValue,
      requestedBudgetUsd: input.requestedBudgetUsd,
      requestedDurationDays: input.requestedDurationDays,
      correlationId: input.correlationId,
    },
    budgetCtx,
  );
  if (!verdict.ok) {
    return { ok: false, status: 400, error: verdict.errors.join('; '), errors: verdict.errors };
  }

  // 4. Halal gate → status, then persist (bounded start/end).
  const requiresApproval = opportunity.halalStatus === 'REVIEW_REQUIRED';
  const status: ExperimentStatus = requiresApproval ? 'HUMAN_REVIEW' : 'DRAFT';
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + verdict.durationDays * 86_400_000);

  const row = await db.growthExperiment.create({
    data: {
      opportunityId: input.opportunityId,
      experimentType: input.experimentType,
      hypothesis: input.hypothesis.trim().slice(0, 1000),
      metric: input.metric,
      baselineValue: 0,
      targetValue: input.targetValue,
      budgetUsd: verdict.budgetUsd,
      maxDurationDays: verdict.durationDays,
      startedAt,
      endsAt,
      status,
      stopLossThreshold: verdict.budgetUsd, // stop-loss = full budget by default
      requiresApproval,
      correlationId: input.correlationId.slice(0, 200),
      idempotencyKey: key,
    },
  });

  await recordGrowthDecision({
    opportunityId: input.opportunityId,
    experimentId: row.id,
    decision: requiresApproval ? 'NEEDS_HUMAN_REVIEW' : 'CONTINUE',
    reason: requiresApproval
      ? 'Experiment created under REVIEW_REQUIRED halal status; awaiting qualified human review.'
      : `Experiment created (${input.experimentType}, metric ${input.metric}, budget $${verdict.budgetUsd.toFixed(2)}, ${verdict.durationDays}d).`,
    evidenceType: 'VERIFIED_DATA',
    decidedBy: 'growth-engine',
    metrics: { budgetUsd: verdict.budgetUsd, durationDays: verdict.durationDays },
    correlationId: input.correlationId,
  }).catch(() => undefined);

  return { ok: true, experimentId: row.id, status, deduplicated: false, notes: verdict.notes };
}

export interface AdvanceExperimentResult {
  experimentId: string;
  previousStatus: string;
  action: string;
  status: string;
  reason: string;
  jobId: string | null;
}

/**
 * Advance one ACTIVE experiment through its lifecycle using recorded metrics.
 * Deterministic; every outcome is persisted as a GrowthDecision row.
 */
export async function advanceGrowthExperiment(experimentId: string, now = new Date()): Promise<AdvanceExperimentResult | null> {
  const row = await db.growthExperiment.findUnique({
    where: { id: experimentId },
    include: { opportunity: { select: { halalStatus: true } } },
  });
  if (!row) return null;
  if (TERMINAL_EXPERIMENT_STATUSES.includes(row.status as ExperimentStatus)) {
    return { experimentId: row.id, previousStatus: row.status, action: 'NO_OP', status: row.status, reason: 'Experiment is already terminal.', jobId: null };
  }

  const halalStatus = row.opportunity?.halalStatus ?? 'REVIEW_REQUIRED';
  const decision = decideLifecycle(
    {
      status: row.status as ExperimentStatus,
      executionAttempts: row.executionAttempts,
      failureCount: row.failureCount,
      spentUsd: row.spentUsd,
      budgetUsd: row.budgetUsd,
      endsAt: row.endsAt,
      stopLossThreshold: row.stopLossThreshold,
      measuredValueUsd: row.variantValueUsd,
      halalStatus,
    },
    now,
  );

  if (decision.action === 'REFUSE_ATTEMPT_LIMIT') {
    return { experimentId: row.id, previousStatus: row.status, action: decision.action, status: row.status, reason: decision.reason, jobId: null };
  }
  if (decision.nextStatus !== 'ACTIVE') {
    await db.growthExperiment.update({
      where: { id: row.id },
      data: { status: decision.nextStatus, stoppedAt: now, stopReason: decision.reason },
    });
    await recordGrowthDecision({
      opportunityId: row.opportunityId,
      experimentId: row.id,
      decision: decision.nextStatus === 'HUMAN_REVIEW' ? 'NEEDS_HUMAN_REVIEW' : 'STOP',
      reason: decision.reason,
      evidenceType: 'VERIFIED_DATA',
      decidedBy: 'growth-engine',
      metrics: { spentUsd: row.spentUsd, failureCount: row.failureCount },
      correlationId: row.correlationId,
    }).catch(() => undefined);
    return { experimentId: row.id, previousStatus: row.status, action: decision.action, status: decision.nextStatus, reason: decision.reason, jobId: null };
  }

  // KEEP_ACTIVE → bounded execution attempt through the Job Runner.
  const attempt = nextAttempt(row.executionAttempts);
  if (!attempt.allowed) {
    return { experimentId: row.id, previousStatus: row.status, action: 'REFUSE_ATTEMPT_LIMIT', status: row.status, reason: 'Attempt limit reached.', jobId: null };
  }

  await db.growthExperiment.update({
    where: { id: row.id },
    data: { status: 'ACTIVE', executionAttempts: attempt.attempts },
  });

  try {
    const outcome = await runJob('ANALYTICS', {
      opportunityId: row.opportunityId,
      analyticsObjective: `Growth experiment measurement: ${row.hypothesis.slice(0, 200)}`,
      experimentId: row.id,
    }, `growth-exp:${row.id}:${attempt.attempts}`);

    const failed = outcome.status === 'FAILED' || outcome.status === 'DEGRADED';
    const failureCount = failed ? Math.min(row.failureCount + 1, MAX_EXPERIMENT_FAILURES) : row.failureCount;
    if (failed) {
      logger.warn('Growth experiment execution attempt failed', { experimentId: row.id, jobStatus: outcome.status });
    }

    const afterFailure = failureCount >= MAX_EXPERIMENT_FAILURES;
    await db.growthExperiment.update({
      where: { id: row.id },
      data: failed
        ? { failureCount, ...(afterFailure ? { status: 'STOPPED', stoppedAt: now, stopReason: `Failure threshold (${MAX_EXPERIMENT_FAILURES}) reached.` } : {}) }
        : {},
    });

    return {
      experimentId: row.id,
      previousStatus: row.status,
      action: failed ? 'EXECUTION_FAILED' : 'EXECUTED',
      status: afterFailure ? 'STOPPED' : 'ACTIVE',
      reason: failed ? `Execution attempt ${attempt.attempts} failed (${outcome.status}).` : `Measurement executed via Job Runner (job ${outcome.status}).`,
      jobId: outcome.jobId === 'n/a' ? null : outcome.jobId,
    };
  } catch (error) {
    logger.error('Growth experiment execution threw', { experimentId: row.id, error: String(error).slice(0, 200) });
    const failureCount = Math.min(row.failureCount + 1, MAX_EXPERIMENT_FAILURES);
    await db.growthExperiment.update({
      where: { id: row.id },
      data: { failureCount, ...(failureCount >= MAX_EXPERIMENT_FAILURES ? { status: 'STOPPED', stoppedAt: now, stopReason: 'Execution error threshold reached.' } : {}) },
    }).catch(() => undefined);
    return {
      experimentId: row.id,
      previousStatus: row.status,
      action: 'EXECUTION_ERROR',
      status: failureCount >= MAX_EXPERIMENT_FAILURES ? 'STOPPED' : 'ACTIVE',
      reason: 'Execution error recorded; nothing was fabricated.',
      jobId: null,
    };
  }
}

export interface FinalizeExperimentInput {
  experimentId: string;
  variantVisitors: number;
  variantConversions: number;
  variantValueUsd: number;
  controlValueUsd: number;
}

/**
 * Finalize an experiment with RECORDED metrics only. Stores the deterministic
 * evaluation, records the learning, and closes the lifecycle.
 */
export async function finalizeGrowthExperiment(input: FinalizeExperimentInput): Promise<
  | { ok: true; result: 'VALIDATED' | 'INVALIDATED' | 'INCONCLUSIVE'; summary: string }
  | { ok: false; error: string }
> {
  const row = await db.growthExperiment.findUnique({ where: { id: input.experimentId } });
  if (!row) return { ok: false, error: 'Experiment not found.' };
  if (TERMINAL_EXPERIMENT_STATUSES.includes(row.status as ExperimentStatus)) {
    return { ok: false, error: `Experiment is already ${row.status}.` };
  }

  const evaluation = evaluateExperiment({
    metric: row.metric as ExperimentMetric,
    baselineValue: row.baselineValue,
    variantVisitors: input.variantVisitors,
    variantConversions: input.variantConversions,
    variantValueUsd: input.variantValueUsd,
  });

  await db.growthExperiment.update({
    where: { id: row.id },
    data: {
      status: 'COMPLETED',
      stoppedAt: new Date(),
      stopReason: evaluation.result,
      variantVisitors: input.variantVisitors,
      variantConversions: input.variantConversions,
      variantValueUsd: input.variantValueUsd,
      controlValueUsd: input.controlValueUsd,
      resultSummary: evaluation.explanation.slice(0, 1000),
    },
  });

  await recordGrowthDecision({
    opportunityId: row.opportunityId,
    experimentId: row.id,
    decision: evaluation.result === 'VALIDATED' ? 'ITERATE' : 'CONTINUE',
    reason: `Experiment completed: ${evaluation.result}. ${evaluation.explanation}`,
    evidenceType: 'VERIFIED_DATA',
    decidedBy: 'growth-engine',
    metrics: {
      metric: row.metric,
      baselineValue: row.baselineValue,
      measuredValue: evaluation.measuredValue,
      relativeLift: evaluation.relativeLift,
    },
    correlationId: row.correlationId,
  }).catch(() => undefined);

  return { ok: true, result: evaluation.result, summary: evaluation.explanation };
}

export async function listGrowthExperiments(options: { opportunityId?: string; status?: string; limit?: number } = {}) {
  const rows = await db.growthExperiment.findMany({
    where: {
      ...(options.opportunityId ? { opportunityId: options.opportunityId } : {}),
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, options.limit ?? 30)),
  });
  return rows;
}

export { MAX_EXPERIMENT_EXECUTION_ATTEMPTS };
