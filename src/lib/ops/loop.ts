// Phase 8B — Autonomous Loop Controller.
//
// Deterministic: read state → identify completed stages → next valid stage →
// verify gates → execute EXACTLY one safe transition → persist → return next action.
//
// Never repeats completed stages. Never skips mandatory gates. Prevents infinite
// loops. Every transition records from/to/reason/evidence/correlationId/timestamp/status.
// Execution of real jobs still goes through the existing Income Engine / Job Runner.

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { advanceIncomeLoop, getIncomeLoopState, type LoopStage } from '@/lib/income-engine/engine';
import { decideLifecycle } from './decision-engine';
import { persistOperationalMemory } from './memory';
import {
  AUTONOMOUS_STAGES,
  type AutonomousStage,
  type EvidenceClass,
  type LoopTransitionRecord,
} from './types';

export const MAX_TRANSITIONS_PER_TICK = 1;
export const MAX_LOOP_TICKS = 13;

const STAGE_TO_LOOP: Partial<Record<AutonomousStage, LoopStage>> = {
  DISCOVER: 'DISCOVER',
  RESEARCH: 'RESEARCH',
  VALIDATE: 'VALIDATE',
  DECIDE: 'DECIDE',
  BUILD: 'BUILD',
  PUBLISH: 'PUBLISH',
  TRAFFIC: 'TRAFFIC',
  CONVERT: 'CONVERT',
  REVENUE: 'REVENUE',
  LEARN: 'LEARN',
};

export interface LoopTickResult {
  ok: boolean;
  from: AutonomousStage;
  to: AutonomousStage;
  reason: string;
  evidence: string;
  evidenceType: EvidenceClass;
  correlationId: string;
  timestamp: string;
  status: 'ADVANCED' | 'BLOCKED' | 'HUMAN_REVIEW' | 'COMPLETED' | 'FAILED' | 'AWAITING_HUMAN_INPUT' | 'NO_OP' | 'GUARD';
  nextAction: string;
  jobId: string | null;
  loopPrevented: boolean;
}

function mapCurrent(stage: LoopStage | null): AutonomousStage {
  if (!stage) return 'DISCOVER';
  const map: Record<string, AutonomousStage> = {
    DISCOVER: 'DISCOVER',
    RESEARCH: 'RESEARCH',
    VALIDATE: 'VALIDATE',
    DECIDE: 'DECIDE',
    BUILD: 'BUILD',
    PUBLISH: 'PUBLISH',
    TRAFFIC: 'TRAFFIC',
    CONVERT: 'CONVERT',
    REVENUE: 'REVENUE',
    ANALYZE: 'LEARN',
    LEARN: 'LEARN',
  };
  return map[stage] ?? 'RESEARCH';
}

function nextAfter(current: AutonomousStage): AutonomousStage {
  const idx = AUTONOMOUS_STAGES.indexOf(current);
  if (idx < 0 || idx >= AUTONOMOUS_STAGES.length - 1) return current;
  return AUTONOMOUS_STAGES[idx + 1];
}

async function persistTransition(opportunityId: string, record: LoopTransitionRecord, mode: 'LIVE' | 'SIMULATION'): Promise<void> {
  await db.loopTransition.create({
    data: {
      opportunityId,
      fromStage: record.from,
      toStage: record.to,
      reason: record.reason.slice(0, 1000),
      evidence: record.evidence.slice(0, 1000),
      evidenceType: record.evidenceType,
      correlationId: record.correlationId,
      status: record.status,
      mode,
    },
  });
}

export async function listLoopTransitions(opportunityId: string, limit = 30): Promise<LoopTransitionRecord[]> {
  const rows = await db.loopTransition.findMany({
    where: { opportunityId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  });
  return rows.map((r) => ({
    from: r.fromStage as AutonomousStage,
    to: r.toStage as AutonomousStage,
    reason: r.reason,
    evidence: r.evidence,
    evidenceType: r.evidenceType as EvidenceClass,
    correlationId: r.correlationId,
    timestamp: r.createdAt.toISOString(),
    status: r.status,
  }));
}

/**
 * Detect a cycle: same from→to pair repeating without new evidence.
 */
export function wouldLoopInfinitely(history: LoopTransitionRecord[], next: { from: AutonomousStage; to: AutonomousStage }): boolean {
  const recent = history.slice(0, 8);
  const sameNonAdvance = recent.filter((h) => h.from === next.from && h.to === next.to && h.status !== 'ADVANCED');
  return sameNonAdvance.length >= 3;
}

export async function tickAutonomousLoop(
  opportunityId: string,
  options: { humanApprovalToken?: string; mode?: 'LIVE' | 'SIMULATION' } = {},
): Promise<LoopTickResult> {
  const correlationId = `loop:${opportunityId}:${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const mode = options.mode ?? 'LIVE';

  const state = await getIncomeLoopState(opportunityId);
  if (!state) {
    return {
      ok: false, from: 'DISCOVER', to: 'DISCOVER',
      reason: 'Opportunity not found.', evidence: '', evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'FAILED', nextAction: 'Create or select a real opportunity.',
      jobId: null, loopPrevented: false,
    };
  }

  const history = await listLoopTransitions(opportunityId, 20);
  const from = mapCurrent(state.currentStage);
  let to = nextAfter(from);

  if (state.halalGate.blocked) {
    const result: LoopTickResult = {
      ok: false, from, to: from,
      reason: 'NOT_ALLOWED hard block. No stage transition.',
      evidence: state.halalGate.reason ?? 'halal NOT_ALLOWED',
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'BLOCKED',
      nextAction: 'Remove or replace the blocked opportunity. Nothing executed.',
      jobId: null, loopPrevented: false,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }
  if (state.halalGate.reviewRequired) {
    const result: LoopTickResult = {
      ok: false, from, to: from,
      reason: 'REVIEW_REQUIRED. No autonomous transition.',
      evidence: state.halalGate.reason ?? 'halal REVIEW_REQUIRED',
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'HUMAN_REVIEW',
      nextAction: 'A qualified human must review before the loop advances.',
      jobId: null, loopPrevented: false,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }

  const completed = new Set(state.stages.filter((s) => s.complete).map((s) => s.stage as string));
  if (completed.has(from) && from !== 'ITERATE' && from !== 'LEARN') {
    to = nextAfter(from);
  }

  if (wouldLoopInfinitely(history, { from, to })) {
    const result: LoopTickResult = {
      ok: false, from, to: from,
      reason: 'Infinite-loop guard: the same non-advancing transition repeated. Stopped.',
      evidence: `${history.length} prior transitions`,
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'GUARD',
      nextAction: 'Inspect blockers; do not re-tick until state changes.',
      jobId: null, loopPrevented: true,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }

  const decision = decideLifecycle({
    failedValidationCount: Math.max(0, state.metrics.completedDecisions - state.metrics.positiveDecisions),
    positiveValidationCount: state.metrics.positiveDecisions,
    completedDecisionCount: state.metrics.completedDecisions,
    netRevenue: state.metrics.netRevenue,
    trafficEvents: state.metrics.trafficEvents,
    conversionEvents: state.metrics.revenueRecords,
    costsUsd: 0,
    halalStatus: state.halalGate.status,
    hasAmbiguousSignal: false,
    highRisk: false,
  });

  if (decision.decision === 'KILL') {
    const result: LoopTickResult = {
      ok: false, from, to: from,
      reason: decision.reason,
      evidence: 'lifecycle decision engine',
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'BLOCKED',
      nextAction: 'Candidate killed. Do not continue the loop.',
      jobId: null, loopPrevented: false,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }
  if (decision.decision === 'PAUSE') {
    const result: LoopTickResult = {
      ok: false, from, to: from,
      reason: decision.reason,
      evidence: 'lifecycle decision engine',
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'GUARD',
      nextAction: 'Paused. Human must resume.',
      jobId: null, loopPrevented: false,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }
  if (decision.decision === 'HUMAN_REVIEW') {
    const result: LoopTickResult = {
      ok: false, from, to: from,
      reason: decision.reason,
      evidence: 'lifecycle decision engine',
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'HUMAN_REVIEW',
      nextAction: 'Human review required.',
      jobId: null, loopPrevented: false,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }

  if (from === 'ITERATE' || (from === 'LEARN' && completed.has('LEARN'))) {
    const result: LoopTickResult = {
      ok: true, from, to: 'ITERATE',
      reason: 'Loop reached LEARN/ITERATE. Next cycle requires new evidence, not a repeated tick.',
      evidence: state.stages.find((s) => s.stage === 'LEARN')?.evidence ?? '',
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'COMPLETED',
      nextAction: decision.decision === 'SCALE' ? 'Scale candidate (human-gated).' : 'Iterate with a new hypothesis.',
      jobId: null, loopPrevented: false,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }

  const incomeStage = STAGE_TO_LOOP[from];
  if (!incomeStage) {
    const result: LoopTickResult = {
      ok: true, from, to,
      reason: `${from} has no Job Runner mapping; recording the planned transition only.`,
      evidence: 'controller mapping',
      evidenceType: 'VERIFIED_DATA',
      correlationId, timestamp, status: 'NO_OP',
      nextAction: `Manually complete ${from} or tick again after evidence lands.`,
      jobId: null, loopPrevented: false,
    };
    await persistTransition(opportunityId, { ...result, status: result.status }, mode);
    return result;
  }

  const advance = await advanceIncomeLoop(opportunityId, {
    humanApprovalToken: options.humanApprovalToken,
  });

  const status: LoopTickResult['status'] =
    advance.status === 'COMPLETED' || advance.status === 'DISPATCHED' ? 'ADVANCED'
    : advance.status === 'BLOCKED' ? 'BLOCKED'
    : advance.status === 'HUMAN_REVIEW' ? 'HUMAN_REVIEW'
    : advance.status === 'AWAITING_HUMAN_INPUT' ? 'AWAITING_HUMAN_INPUT'
    : advance.status === 'FAILED' ? 'FAILED'
    : 'NO_OP';

  const result: LoopTickResult = {
    ok: advance.ok,
    from,
    to: status === 'ADVANCED' ? to : from,
    reason: advance.message,
    evidence: `job:${advance.jobId ?? 'none'} status:${advance.jobStatus ?? advance.status}`,
    evidenceType: 'VERIFIED_DATA',
    correlationId,
    timestamp,
    status,
    nextAction: status === 'ADVANCED'
      ? `Next stage: ${to}. Tick again after evidence is on file.`
      : advance.message,
    jobId: advance.jobId,
    loopPrevented: false,
  };
  await persistTransition(opportunityId, {
    from: result.from,
    to: result.to,
    reason: result.reason,
    evidence: result.evidence,
    evidenceType: result.evidenceType,
    correlationId,
    timestamp,
    status: result.status,
  }, mode);

  if (status === 'ADVANCED') {
    await persistOperationalMemory({
      category: 'opportunity',
      source: 'autonomous-loop',
      evidenceType: 'VERIFIED_DATA',
      relatedEntityType: 'opportunity',
      relatedEntityId: opportunityId,
      opportunityId,
      observation: `Transition ${from} → ${result.to}: ${result.reason}`,
      outcome: result.status,
      applicability: 'future ticks of this opportunity',
    }).catch(() => undefined);
  }

  return result;
}
