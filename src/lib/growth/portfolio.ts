// Phase 9 — Opportunity Portfolio Manager + Growth Analytics assembler.
//
// Recomputes every portfolio aggregate from RECORDED rows (ProductEvent,
// Revenue, GrowthExperiment, GrowthDecision, LearningEntry) and upserts a
// deterministic PortfolioItem per opportunity. Health/trend/confidence/score
// come from documented rules (health.ts); nothing is user-settable.
// Simulated figures never enter these aggregates.

import { db } from '@/lib/db';
import { computeHealth, computePortfolioScore } from './health';
import { computeFunnelAnalytics, type AttributionRow } from './attribution';
import { decideGrowth } from './decision-engine';
import { recordGrowthDecision, listGrowthDecisions, type DecisionView } from './decisions';
import type { GrowthHealthState } from './types';

export interface PortfolioEntryView {
  opportunityId: string;
  title: string;
  opportunityStatus: string;
  halalStatus: string;
  evidenceStrength: string;
  confidenceLevel: string;
  traffic: number;
  conversions: number;
  revenueUsd: number;
  costsUsd: number;
  profitUsd: number;
  experimentCount: number;
  activeExperimentCount: number;
  health: GrowthHealthState;
  trend: string;
  confidence: string;
  score: number;
  explanation: string;
  lastActivityAt: string | null;
  evaluatedAt: string | null;
}

/**
 * Recompute + persist the portfolio item for one opportunity.
 * Returns null when the opportunity does not exist.
 */
export async function evaluatePortfolioItem(opportunityId: string): Promise<PortfolioEntryView | null> {
  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true, title: true, status: true, halalStatus: true,
      confidenceLevel: true, evidenceNotes: true, updatedAt: true,
    },
  });
  if (!opportunity) return null;

  const now = new Date();

  const [events, revenues, experiments, learnings] = await Promise.all([
    db.productEvent.findMany({
      where: { opportunityId },
      select: {
        eventType: true, sessionId: true, amountUsd: true,
        utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true,
        experimentId: true, occurredAt: true,
      },
      orderBy: { occurredAt: 'asc' },
      take: 5000,
    }),
    db.revenue.aggregate({
      where: { opportunityId },
      _sum: { netRevenue: true, advertisingCost: true, otherCosts: true },
    }),
    db.growthExperiment.findMany({
      where: { opportunityId },
      select: { id: true, status: true, updatedAt: true },
    }),
    db.learningEntry.findMany({
      where: { opportunityId },
      select: { result: true, evidenceType: true },
    }),
  ]);

  const attributionRows: AttributionRow[] = events.map((e) => ({
    utmSource: e.utmSource,
    utmMedium: e.utmMedium,
    utmCampaign: e.utmCampaign,
    utmContent: e.utmContent,
    sessionId: e.sessionId,
    eventType: e.eventType,
    amountUsd: e.amountUsd,
    occurredAt: e.occurredAt,
    experimentId: e.experimentId,
  }));
  const funnel = computeFunnelAnalytics(attributionRows);

  const visitors = funnel.visitors;
  const purchases = events.filter((e) => e.eventType === 'PURCHASE').length;
  const grossRevenue = events
    .filter((e) => e.eventType === 'PURCHASE')
    .reduce((s, e) => s + (e.amountUsd ?? 0), 0);

  const netRevenueUsd = revenues._sum.netRevenue ?? 0;
  const costsUsd = (revenues._sum.advertisingCost ?? 0) + (revenues._sum.otherCosts ?? 0);

  const activeExperimentCount = experiments.filter((e) => e.status === 'ACTIVE').length;
  const lastEventAt = events.length > 0 ? events[events.length - 1].occurredAt : null;
  const lastDecision = await db.growthDecision.findFirst({
    where: { opportunityId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const lastActivity = [lastEventAt, lastDecision?.createdAt ?? null]
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  const health = computeHealth({
    halalStatus: opportunity.halalStatus,
    opportunityStatus: opportunity.status,
    stopped: opportunity.status === 'PAUSED' || opportunity.status === 'REJECTED',
    visitors,
    conversions: purchases,
    grossRevenueUsd: grossRevenue,
    netRevenueUsd,
    costsUsd,
    activeExperiments: activeExperimentCount,
    lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
    now,
  });

  const validatedLearnings = learnings.filter((l) => l.result === 'VALIDATED' && (l.evidenceType === 'VERIFIED_DATA' || l.evidenceType === 'HUMAN_DECISION')).length;
  const invalidatedLearnings = learnings.filter((l) => l.result === 'INVALIDATED').length;
  const completedExperiments = experiments.filter((e) => e.status === 'COMPLETED').length;

  const score = computePortfolioScore({
    health,
    experimentCount: experiments.length,
    completedExperimentCount: completedExperiments,
    validatedLearningCount: validatedLearnings,
    netRevenueUsd,
  });

  const decision = decideGrowth({
    health: health.state,
    visitors,
    conversions: purchases,
    netRevenueUsd,
    costsUsd,
    activeExperiments: activeExperimentCount,
    completedExperiments,
    validatedLearnings,
    invalidatedLearnings,
    remainingMonthlyBudgetUsd: 0, // engine recommendation without allocation awareness
    halalStatus: opportunity.halalStatus,
  });

  const explanation = [
    `Health rules: ${health.rules.join(' ')}`,
    `Score breakdown: ${score.breakdown.join(', ')}.`,
    `Engine decision: ${decision.decision} — ${decision.reason}`,
    `Funnel: ${funnel.explanation}`,
  ].join(' ');

  const data = {
    traffic: visitors,
    conversions: purchases,
    revenueUsd: grossRevenue,
    costsUsd,
    profitUsd: netRevenueUsd - costsUsd,
    experimentCount: experiments.length,
    activeExperimentCount,
    health: health.state,
    trend: health.trend,
    confidence: health.confidence,
    score: score.score,
    explanation: explanation.slice(0, 2000),
    halalStatusSnapshot: opportunity.halalStatus,
    opportunityStatusSnapshot: opportunity.status,
    evidenceStrengthSnapshot: opportunity.confidenceLevel,
    validationStatusSnapshot: opportunity.status,
    lastActivityAt: lastActivity,
    evaluatedAt: now,
  };

  const saved = await db.portfolioItem.upsert({
    where: { opportunityId },
    create: { opportunityId, ...data },
    update: data,
  });

  return {
    opportunityId,
    title: opportunity.title,
    opportunityStatus: opportunity.status,
    halalStatus: opportunity.halalStatus,
    evidenceStrength: opportunity.confidenceLevel,
    confidenceLevel: opportunity.confidenceLevel,
    traffic: saved.traffic,
    conversions: saved.conversions,
    revenueUsd: saved.revenueUsd,
    costsUsd: saved.costsUsd,
    profitUsd: saved.profitUsd,
    experimentCount: saved.experimentCount,
    activeExperimentCount: saved.activeExperimentCount,
    health: saved.health as GrowthHealthState,
    trend: saved.trend,
    confidence: saved.confidence,
    score: saved.score,
    explanation: saved.explanation,
    lastActivityAt: saved.lastActivityAt ? saved.lastActivityAt.toISOString() : null,
    evaluatedAt: saved.evaluatedAt ? saved.evaluatedAt.toISOString() : null,
  };
}

export interface PortfolioSummary {
  evaluatedAt: string;
  counts: { total: number; healthy: number; watch: number; needsData: number; underperforming: number; stopped: number; blocked: number };
  totals: { traffic: number; conversions: number; revenueUsd: number; costsUsd: number; profitUsd: number; experiments: number; activeExperiments: number };
  entries: PortfolioEntryView[];
}

/** Evaluate (bounded batch) + summarize the whole portfolio deterministically. */
export async function evaluatePortfolio(limit = 25): Promise<PortfolioSummary> {
  const opportunities = await db.opportunity.findMany({
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
  });

  const entries: PortfolioEntryView[] = [];
  for (const o of opportunities) {
    const view = await evaluatePortfolioItem(o.id).catch(() => null);
    if (view) entries.push(view);
  }

  const counts = {
    total: entries.length,
    healthy: entries.filter((e) => e.health === 'HEALTHY').length,
    watch: entries.filter((e) => e.health === 'WATCH').length,
    needsData: entries.filter((e) => e.health === 'NEEDS_DATA').length,
    underperforming: entries.filter((e) => e.health === 'UNDERPERFORMING').length,
    stopped: entries.filter((e) => e.health === 'STOPPED').length,
    blocked: entries.filter((e) => e.health === 'BLOCKED').length,
  };

  const totals = {
    traffic: entries.reduce((s, e) => s + e.traffic, 0),
    conversions: entries.reduce((s, e) => s + e.conversions, 0),
    revenueUsd: entries.reduce((s, e) => s + e.revenueUsd, 0),
    costsUsd: entries.reduce((s, e) => s + e.costsUsd, 0),
    profitUsd: entries.reduce((s, e) => s + e.profitUsd, 0),
    experiments: entries.reduce((s, e) => s + e.experimentCount, 0),
    activeExperiments: entries.reduce((s, e) => s + e.activeExperimentCount, 0),
  };

  return {
    evaluatedAt: new Date().toISOString(),
    counts,
    totals,
    entries: entries.sort((a, b) => b.score - a.score || a.opportunityId.localeCompare(b.opportunityId)),
  };
}

export interface GrowthDashboardView {
  generatedAt: string;
  portfolio: PortfolioSummary;
  activeExperiments: Awaited<ReturnType<typeof listActiveExperiments>>;
  decisions: DecisionView[];
  learning: Awaited<ReturnType<typeof listLearning>>;
  budgetLines: Awaited<ReturnType<typeof listAllocations>>;
  blockedActions: { kind: string; reason: string; at: string }[];
}

export async function listActiveExperiments(limit = 20) {
  const rows = await db.growthExperiment.findMany({
    where: { status: { in: ['ACTIVE', 'DRAFT', 'HUMAN_REVIEW'] } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
    select: {
      id: true, opportunityId: true, experimentType: true, hypothesis: true,
      metric: true, baselineValue: true, targetValue: true, budgetUsd: true,
      spentUsd: true, status: true, startedAt: true, endsAt: true,
      executionAttempts: true, failureCount: true, resultSummary: true,
    },
  });
  return rows.map((r) => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
  }));
}

async function listLearning(limit = 15) {
  const rows = await db.learningEntry.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
    select: {
      id: true, opportunityId: true, hypothesis: true, result: true,
      metric: true, decision: true, evidenceType: true, confidence: true, createdAt: true,
    },
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

async function listAllocations(limit = 25) {
  const rows = await db.resourceAllocation.findMany({
    orderBy: { updatedAt: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
    include: { opportunity: { select: { title: true } } },
  });
  return rows.map((r) => ({
    opportunityId: r.opportunityId,
    opportunityTitle: r.opportunity?.title ?? '(deleted)',
    monthlyBudgetUsd: r.monthlyBudgetUsd,
    spentThisMonthUsd: r.spentThisMonthUsd,
    remainingUsd: Math.max(0, r.monthlyBudgetUsd - r.spentThisMonthUsd),
    perExperimentCapUsd: r.perExperimentCapUsd,
    maxActiveExperiments: r.maxActiveExperiments,
    paused: r.paused,
    pauseReason: r.pauseReason,
  }));
}

/** Assemble the Growth/Optimization dashboard view (read-only aggregates). */
export async function getGrowthDashboardView(): Promise<GrowthDashboardView> {
  const [portfolio, activeExperiments, decisions, learning, budgetLines] = await Promise.all([
    evaluatePortfolio(25),
    listActiveExperiments(20).catch(() => []),
    listGrowthDecisions({ limit: 25 }).catch(() => []),
    listLearning(15).catch(() => []),
    listAllocations(25).catch(() => []),
  ]);

  const blockedActions: { kind: string; reason: string; at: string }[] = [];
  for (const d of decisions) {
    if (d.decision === 'NEEDS_HUMAN_REVIEW' || d.decision === 'STOP') {
      blockedActions.push({ kind: d.decision, reason: d.reason, at: d.createdAt });
    }
  }
  for (const a of budgetLines) {
    if (a.paused) {
      blockedActions.push({ kind: 'BUDGET_PAUSED', reason: a.pauseReason ?? 'Allocation paused.', at: portfolio.evaluatedAt });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    portfolio,
    activeExperiments,
    decisions,
    learning,
    budgetLines,
    blockedActions: blockedActions.slice(0, 15),
  };
}

export { recordGrowthDecision };
