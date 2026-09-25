// Phase 9 — Bounded Optimization Loop (LEARN → OPTIMIZE → EXPERIMENT →
// MEASURE → DECIDE → SCALE/STOP/ITERATE → LEARN).
//
// ONE tick = at most ONE safe transition per opportunity, mirroring the Phase 8
// loop discipline. Every tick:
//  1. reads the deterministic portfolio health,
//  2. asks the decision engine for the bounded decision,
//  3. executes the decision within hard budget caps,
//  4. persists an auditable GrowthDecision row.
// No runaway spend is possible: SCALE_WITHIN_BUDGET only ever CREATES a new
// bounded experiment via createGrowthExperiment (which re-validates all caps).
// The Job Runner remains authoritative for execution; Ruflo is untouched.

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { evaluatePortfolioItem } from './portfolio';
import { decideGrowth } from './decision-engine';
import { createGrowthExperiment, advanceGrowthExperiment } from './experiments';
import { recordGrowthDecision } from './decisions';
import type { GrowthDecisionType } from './types';

export const MAX_TICKS_PER_CALL = 5;

export interface TickResult {
  ok: boolean;
  opportunityId: string;
  health: string;
  decision: GrowthDecisionType;
  action: string;
  reason: string;
  experimentId: string | null;
  jobId: string | null;
  correlationId: string;
  timestamp: string;
}

interface TickOptions {
  correlationId?: string;
  experimentType?: string;
  metric?: string;
  targetValue?: number;
  requestedBudgetUsd?: number;
  requestedDurationDays?: number;
}

/**
 * Tick the growth loop for one opportunity. Deterministic and idempotent per
 * correlationId. Returns a truthful record of what happened (or was refused).
 */
export async function tickGrowthLoop(opportunityId: string, options: TickOptions = {}): Promise<TickResult> {
  const correlationId = (options.correlationId?.trim() || `growth-tick:${randomUUID()}`).slice(0, 200);
  const timestamp = new Date().toISOString();

  const view = await evaluatePortfolioItem(opportunityId);
  if (!view) {
    return {
      ok: false, opportunityId, health: 'UNKNOWN', decision: 'CONTINUE',
      action: 'REFUSED', reason: 'Opportunity not found; nothing executed.',
      experimentId: null, jobId: null, correlationId, timestamp,
    };
  }

  // Fresh allocation view for the budget-aware decision.
  const allocation = await db.resourceAllocation.findUnique({ where: { opportunityId } });
  const learnings = await db.learningEntry.findMany({
    where: { opportunityId },
    select: { result: true, evidenceType: true },
  });
  const validatedLearnings = learnings.filter((l) => l.result === 'VALIDATED' && (l.evidenceType === 'VERIFIED_DATA' || l.evidenceType === 'HUMAN_DECISION')).length;
  const invalidatedLearnings = learnings.filter((l) => l.result === 'INVALIDATED').length;
  const completed = await db.growthExperiment.count({ where: { opportunityId, status: 'COMPLETED' } });

  const decision = decideGrowth({
    health: view.health,
    visitors: view.traffic,
    conversions: view.conversions,
    netRevenueUsd: view.profitUsd + view.costsUsd,
    costsUsd: view.costsUsd,
    activeExperiments: view.activeExperimentCount,
    completedExperiments: completed,
    validatedLearnings,
    invalidatedLearnings,
    remainingMonthlyBudgetUsd: allocation ? Math.max(0, allocation.monthlyBudgetUsd - allocation.spentThisMonthUsd) : 0,
    halalStatus: view.halalStatus,
  });

  await recordGrowthDecision({
    opportunityId,
    decision: decision.decision,
    reason: decision.reason,
    evidenceType: decision.evidenceType,
    decidedBy: 'growth-engine',
    metrics: { health: view.health, score: view.score, trend: view.trend },
    correlationId,
  }).catch(() => undefined);

  switch (decision.decision) {
    case 'STOP':
      return { ok: true, opportunityId, health: view.health, decision: 'STOP', action: 'RECORDED_STOP', reason: decision.reason, experimentId: null, jobId: null, correlationId, timestamp };
    case 'NEEDS_HUMAN_REVIEW':
      return { ok: true, opportunityId, health: view.health, decision: 'NEEDS_HUMAN_REVIEW', action: 'RECORDED_REVIEW', reason: decision.reason, experimentId: null, jobId: null, correlationId, timestamp };
    case 'PAUSE':
      if (allocation && !allocation.paused) {
        await db.resourceAllocation.update({
          where: { opportunityId },
          data: { paused: true, pauseReason: decision.reason.slice(0, 400) },
        });
        return { ok: true, opportunityId, health: view.health, decision: 'PAUSE', action: 'ALLOCATION_PAUSED', reason: decision.reason, experimentId: null, jobId: null, correlationId, timestamp };
      }
      return { ok: true, opportunityId, health: view.health, decision: 'PAUSE', action: 'RECORDED_PAUSE', reason: decision.reason, experimentId: null, jobId: null, correlationId, timestamp };
    case 'CONTINUE': {
      // Advance one existing ACTIVE experiment if any (measurement only).
      const active = await db.growthExperiment.findFirst({
        where: { opportunityId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      });
      if (active) {
        const advanced = await advanceGrowthExperiment(active.id);
        return {
          ok: true, opportunityId, health: view.health, decision: 'CONTINUE',
          action: advanced ? `ADVANCED_EXPERIMENT:${advanced.action}` : 'NO_EXPERIMENT_ADVANCED',
          reason: decision.reason, experimentId: active.id, jobId: advanced?.jobId ?? null, correlationId, timestamp,
        };
      }
      return { ok: true, opportunityId, health: view.health, decision: 'CONTINUE', action: 'NO_ACTION', reason: decision.reason, experimentId: null, jobId: null, correlationId, timestamp };
    }
    case 'ITERATE': {
      const created = await createGrowthExperiment({
        opportunityId,
        experimentType: options.experimentType ?? 'CONTENT',
        hypothesis: `Iterate on ${view.title}: address underperformance identified at ${timestamp}`,
        metric: options.metric ?? 'CONVERSION_RATE',
        targetValue: options.targetValue ?? 0.05,
        requestedBudgetUsd: options.requestedBudgetUsd ?? Math.min(5, allocation ? Math.max(0, allocation.monthlyBudgetUsd - allocation.spentThisMonthUsd) : 0),
        requestedDurationDays: options.requestedDurationDays ?? 7,
        idempotencyKey: correlationId,
        correlationId,
      });
      return {
        ok: created.ok,
        opportunityId, health: view.health, decision: 'ITERATE',
        action: created.ok ? 'EXPERIMENT_CREATED' : 'EXPERIMENT_REFUSED',
        reason: created.ok ? `Bounded experiment created (${created.status}).` : created.error,
        experimentId: created.ok ? created.experimentId : null,
        jobId: null, correlationId, timestamp,
      };
    }
    case 'SCALE_WITHIN_BUDGET': {
      // The ONLY spend-increasing path: create a new bounded experiment.
      // createGrowthExperiment re-validates every cap; this call can never
      // exceed the allocation or the hard caps.
      const created = await createGrowthExperiment({
        opportunityId,
        experimentType: options.experimentType ?? 'TRAFFIC_SOURCE',
        hypothesis: `Scale within budget for ${view.title}: confirm economics hold at current volume`,
        metric: options.metric ?? 'REVENUE_PER_VISITOR',
        targetValue: options.targetValue ?? 0.5,
        requestedBudgetUsd: options.requestedBudgetUsd ?? Math.min(10, allocation ? Math.max(0, allocation.monthlyBudgetUsd - allocation.spentThisMonthUsd) : 0),
        requestedDurationDays: options.requestedDurationDays ?? 14,
        idempotencyKey: correlationId,
        correlationId,
      });
      return {
        ok: created.ok,
        opportunityId, health: view.health, decision: 'SCALE_WITHIN_BUDGET',
        action: created.ok ? 'BOUNDED_EXPERIMENT_CREATED' : 'SCALE_REFUSED',
        reason: created.ok ? `Bounded scale experiment created (budget re-validated: ${created.notes.join('; ') || 'within caps'}).` : created.error,
        experimentId: created.ok ? created.experimentId : null,
        jobId: null, correlationId, timestamp,
      };
    }
    default:
      return { ok: false, opportunityId, health: view.health, decision: decision.decision, action: 'NO_ACTION', reason: 'Unhandled decision type.', experimentId: null, jobId: null, correlationId, timestamp };
  }
}

/**
 * Tick the whole portfolio (bounded batch). Each opportunity gets at most one
 * transition; failures are isolated and recorded, never propagated.
 */
export async function tickPortfolioGrowth(limit = 10): Promise<TickResult[]> {
  const opportunities = await db.opportunity.findMany({
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(MAX_TICKS_PER_CALL, Math.max(1, limit)),
  });
  const results: TickResult[] = [];
  for (const o of opportunities) {
    const result = await tickGrowthLoop(o.id).catch((error) => ({
      ok: false,
      opportunityId: o.id,
      health: 'UNKNOWN',
      decision: 'CONTINUE' as GrowthDecisionType,
      action: 'ERROR',
      reason: String(error).slice(0, 300),
      experimentId: null,
      jobId: null,
      correlationId: 'error',
      timestamp: new Date().toISOString(),
    }));
    results.push(result);
  }
  return results;
}
