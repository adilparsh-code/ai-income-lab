import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import type { JobType } from '@/lib/jobs/types';
import { getIncomeLoopState, type AdvanceOutcome, type IncomeLoopState, type LoopStage } from '@/lib/income-engine/engine';

export const JOB_FOR_LOOP_STAGE: Partial<Record<LoopStage, JobType>> = {
  RESEARCH: 'RESEARCH', VALIDATE: 'VALIDATION', DECIDE: 'VALIDATION', BUILD: 'PRODUCT_CREATE', PUBLISH: 'PRODUCT_PUBLISH', ANALYZE: 'ANALYTICS',
};

export interface LoopTransitionRecord {
  from: LoopStage | null;
  to: LoopStage | null;
  reason: string;
  evidence: Record<string, unknown>;
  evidenceType: 'VERIFIED_DATA' | 'AI_INFERENCE' | 'NONE';
  correlationId: string;
  executionStatus: 'COMPLETED' | 'BLOCKED' | 'HUMAN_REVIEW' | 'AWAITING_HUMAN_INPUT' | 'FAILED' | 'SKIPPED';
  timestamp: string;
}

function safeStage(stage: LoopStage | null): string { return stage ?? 'NONE'; }

function previousStage(stage: LoopStage | null): LoopStage | null {
  if (!stage) return null;
  const order: LoopStage[] = ['DISCOVER', 'RESEARCH', 'VALIDATE', 'DECIDE', 'BUILD', 'PUBLISH', 'TRAFFIC', 'CONVERT', 'REVENUE', 'ANALYZE', 'LEARN'];
  const index = order.indexOf(stage);
  return index > 0 ? order[index - 1] : null;
}

function evidenceFor(state: IncomeLoopState, stage: LoopStage | null): Record<string, unknown> {
  const current = state.stages.find((s) => s.stage === stage);
  return current ? { stage, complete: current.complete, evidence: current.evidence, evidenceType: current.evidenceType } : { stage: safeStage(stage) };
}

async function persistTransition(opportunityId: string, record: LoopTransitionRecord): Promise<void> {
  await db.loopTransition.create({
    data: {
      opportunityId,
      fromStage: safeStage(record.from),
      toStage: safeStage(record.to),
      reason: record.reason.slice(0, 500),
      evidence: JSON.stringify(record.evidence).slice(0, 10_000),
      evidenceType: record.evidenceType,
      correlationId: record.correlationId,
      executionStatus: record.executionStatus,
      executedAt: new Date(record.timestamp),
    },
  });
}

/** Pure planner: never dispatches work and never repeats a completed stage. */
export function planNextLoopTransition(state: IncomeLoopState, correlationId = `loop-plan:${state.opportunity?.id ?? 'unknown'}:${randomUUID()}`): LoopTransitionRecord {
  const timestamp = new Date().toISOString();
  if (state.halalGate.blocked) return { from: state.currentStage, to: null, reason: state.advanceBlocker ?? 'Halal gate blocks the opportunity.', evidence: evidenceFor(state, state.currentStage), evidenceType: 'VERIFIED_DATA', correlationId, executionStatus: 'BLOCKED', timestamp };
  if (state.halalGate.reviewRequired) return { from: state.currentStage, to: null, reason: state.advanceBlocker ?? 'Human review is required before advancement.', evidence: evidenceFor(state, state.currentStage), evidenceType: 'VERIFIED_DATA', correlationId, executionStatus: 'HUMAN_REVIEW', timestamp };
  const stage = state.currentStage;
  if (!stage) return { from: null, to: null, reason: 'No executable stage is available.', evidence: {}, evidenceType: 'NONE', correlationId, executionStatus: 'SKIPPED', timestamp };
  const currentStatus = state.stages.find((s) => s.stage === stage);
  if (currentStatus?.complete) return { from: previousStage(stage), to: stage, reason: `${stage} is already complete; it will not execute again.`, evidence: evidenceFor(state, stage), evidenceType: currentStatus.evidenceType, correlationId, executionStatus: 'SKIPPED', timestamp };
  return { from: previousStage(stage), to: stage, reason: `Execute the current ${stage} frontier exactly once through the authoritative Job Runner.`, evidence: evidenceFor(state, stage), evidenceType: currentStatus?.evidenceType ?? 'AI_INFERENCE', correlationId, executionStatus: 'COMPLETED', timestamp };
}

/** Execute at most one safe transition. Job Runner remains the execution authority. */
export async function executeNextLoopTransition(opportunityId: string, options: { humanApprovalToken?: string } = {}): Promise<{ plan: LoopTransitionRecord; outcome: AdvanceOutcome | null }> {
  const state = await getIncomeLoopState(opportunityId);
  if (!state) {
    const plan = { from: null, to: null, reason: 'Opportunity not found; nothing executed.', evidence: {}, evidenceType: 'NONE' as const, correlationId: `loop:${opportunityId}:missing`, executionStatus: 'FAILED' as const, timestamp: new Date().toISOString() };
    return { plan, outcome: null };
  }
  const plan = planNextLoopTransition(state, `loop:${opportunityId}:${state.currentStage ?? 'none'}`);
  await persistTransition(opportunityId, plan);
  if (plan.executionStatus === 'BLOCKED' || plan.executionStatus === 'HUMAN_REVIEW' || plan.executionStatus === 'SKIPPED') return { plan, outcome: null };
  const outcome = await import('@/lib/income-engine/engine').then(({ advanceIncomeLoop }) => advanceIncomeLoop(opportunityId, options));
  return { plan, outcome };
}

export async function getLoopTransitions(opportunityId: string, limit = 20) {
  return db.loopTransition.findMany({ where: { opportunityId }, orderBy: { executedAt: 'desc' }, take: Math.min(50, Math.max(1, limit)), select: { id: true, fromStage: true, toStage: true, reason: true, evidence: true, evidenceType: true, correlationId: true, executionStatus: true, executedAt: true } });
}
