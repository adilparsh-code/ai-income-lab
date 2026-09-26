// Phase 9 — Business Manager growth decisions.
//
// The business manager consumes the deterministic portfolio + decision engine
// and may run ONE bounded analytics mission through the Job Runner to produce
// a narrative summary. It can never override gates: human decisions enter the
// system only through recordHumanGrowthDecision (append-only ledger row with
// HUMAN_DECISION evidence), and the engine treats those as authoritative.

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { runJob } from '@/lib/jobs/job-runner';
import { evaluatePortfolioItem } from './portfolio';
import { decideGrowth } from './decision-engine';
import { recordGrowthDecision, listGrowthDecisions } from './decisions';
import { recallLearnings } from './learning';
import type { GrowthDecisionType } from './types';

export interface BusinessManagerGrowthView {
  opportunityId: string;
  health: string;
  trend: string;
  score: number;
  engineDecision: GrowthDecisionType;
  engineReason: string;
  verifiedLearnings: number;
  recentDecisions: Awaited<ReturnType<typeof listGrowthDecisions>>;
}

/** Deterministic brief for the business manager over one opportunity. */
export async function getBusinessManagerGrowthBrief(opportunityId: string): Promise<BusinessManagerGrowthView | null> {
  const view = await evaluatePortfolioItem(opportunityId);
  if (!view) return null;

  const allocation = await db.resourceAllocation.findUnique({ where: { opportunityId } });
  const learnings = await recallLearnings({ opportunityId, verifiedOnly: true, limit: 20 });
  const completed = await db.growthExperiment.count({ where: { opportunityId, status: 'COMPLETED' } });
  const invalidated = learnings.filter((l) => l.result === 'INVALIDATED').length;

  const decision = decideGrowth({
    health: view.health,
    visitors: view.traffic,
    conversions: view.conversions,
    netRevenueUsd: view.profitUsd + view.costsUsd,
    costsUsd: view.costsUsd,
    activeExperiments: view.activeExperimentCount,
    completedExperiments: completed,
    validatedLearnings: learnings.filter((l) => l.result === 'VALIDATED').length,
    invalidatedLearnings: invalidated,
    remainingMonthlyBudgetUsd: allocation ? Math.max(0, allocation.monthlyBudgetUsd - allocation.spentThisMonthUsd) : 0,
    halalStatus: view.halalStatus,
  });

  return {
    opportunityId,
    health: view.health,
    trend: view.trend,
    score: view.score,
    engineDecision: decision.decision,
    engineReason: decision.reason,
    verifiedLearnings: learnings.length,
    recentDecisions: await listGrowthDecisions({ opportunityId, limit: 10 }),
  };
}

export interface RunBusinessManagerGrowthResult {
  ok: boolean;
  jobId: string | null;
  jobStatus: string | null;
  summary: string;
}

/**
 * Run ONE bounded BUSINESS_MANAGER job through the Job Runner for growth
 * context. Read-only analytics; no spend, no autonomous action.
 */
export async function runBusinessManagerGrowthReview(opportunityId: string): Promise<RunBusinessManagerGrowthResult> {
  const brief = await getBusinessManagerGrowthBrief(opportunityId);
  if (!brief) {
    return { ok: false, jobId: null, jobStatus: null, summary: 'Opportunity not found; nothing executed.' };
  }
  const correlationId = `growth-bm:${opportunityId}:${randomUUID()}`;
  const outcome = await runJob('BUSINESS_MANAGER', {
    opportunityId,
    objective: `Growth review: health ${brief.health}, engine decision ${brief.engineDecision}, ${brief.verifiedLearnings} verified learnings on file.`,
    decisionScope: 'GROWTH_REVIEW',
  }, correlationId);

  return {
    ok: outcome.status === 'SUCCEEDED' || outcome.status === 'DEGRADED',
    jobId: outcome.jobId === 'n/a' ? null : outcome.jobId,
    jobStatus: outcome.status,
    summary: outcome.error ?? `Business manager growth review executed (${outcome.status}).`,
  };
}

export interface HumanDecisionInput {
  opportunityId: string;
  decision: GrowthDecisionType;
  reason: string;
  correlationId: string;
  experimentId?: string | null;
}

/**
 * Record a human growth decision (authoritative). Append-only; the engine
 * consumes HUMAN_DECISION rows as overrides on the next evaluation.
 */
export async function recordHumanGrowthDecision(input: HumanDecisionInput) {
  return recordGrowthDecision({
    opportunityId: input.opportunityId,
    ...(input.experimentId ? { experimentId: input.experimentId } : {}),
    decision: input.decision,
    reason: `Human decision: ${input.reason}`,
    evidenceType: 'HUMAN_DECISION',
    decidedBy: 'human',
    correlationId: input.correlationId,
  });
}
