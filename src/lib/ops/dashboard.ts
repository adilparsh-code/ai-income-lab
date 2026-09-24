// Phase 8H — Operations dashboard assembler.
//
// Composes EXISTING capability center + job/workflow aggregates with Phase 8
// mission/loop/simulation/memory summaries. Every provider/system state is
// labelled LIVE | MOCKED | SIMULATED | NOT_CONFIGURED | NOT_CONNECTED |
// BLOCKED | AWAITING_HUMAN_INPUT. Unavailable functionality is never hidden.

import { db } from '@/lib/db';
import { describeCapabilityCenter, type CapabilityCenterReport } from '@/lib/product-factory/capability-center';
import { getOperationsSummary, type OperationsSummary } from '@/lib/product-factory/operations';
import { describeAiCapability } from '@/lib/ai/capability';
import { describeResearchProviderHealth } from '@/lib/research/provider';
import { describeRufloIntegration } from '@/lib/ruflo/capability';
import { describeRufloRuntime } from '@/lib/ruflo/runtime';
import { describePublishingStatus } from '@/lib/publishing/contract';
import { describeVercelConfig } from '@/lib/product-factory/deployment-vercel';
import { listMissions } from './missions';
import { listSimulations } from './simulation';
import { recallOperationalMemory } from './memory';
import type { MissionRecord, SystemStateLabel } from './types';

export interface HealthTile {
  name: string;
  state: SystemStateLabel;
  detail: string;
}

export interface ExecutionCounts {
  running: number;
  completed: number;
  failed: number;
  retries: number;
  humanReview: number;
  blocked: number;
  waiting: number;
  queued: number;
}

export interface IncomeEngineOps {
  opportunities: number;
  loopTransitions: number;
  experiments: number;
  products: number;
  simulatedRevenueUsd: number;
  realRevenueUsd: number;
  simulatedProfitUsd: number;
  realProfitUsd: number;
  pendingHumanInput: number;
}

export interface TimelineEvent {
  at: string;
  kind: string;
  label: string;
  state: SystemStateLabel;
  correlationId?: string;
}

export interface Phase8OperationsView {
  generatedAt: string;
  health: HealthTile[];
  execution: ExecutionCounts;
  income: IncomeEngineOps;
  timeline: TimelineEvent[];
  capabilities: CapabilityCenterReport;
  factory: OperationsSummary | null;
  missions: MissionRecord[];
  simulations: Awaited<ReturnType<typeof listSimulations>>;
}

function mapCapability(status: string): SystemStateLabel {
  switch (status) {
    case 'LIVE':
    case 'AVAILABLE':
    case 'CONNECTED':
    case 'RUFLO_CONNECTED':
      return 'LIVE';
    case 'MOCKED':
      return 'MOCKED';
    case 'NOT_CONFIGURED':
    case 'AUTH_REQUIRED':
      return 'NOT_CONFIGURED';
    case 'NOT_CONNECTED':
    case 'RUFLO_READY':
    case 'PUBLISHING_UNAVAILABLE':
    case 'RESEARCH_UNAVAILABLE':
    case 'UNAVAILABLE':
    case 'ERROR':
    case 'DEGRADED':
      return 'NOT_CONNECTED';
    case 'BLOCKED':
      return 'BLOCKED';
    default:
      return 'NOT_CONFIGURED';
  }
}

export async function getPhase8OperationsView(): Promise<Phase8OperationsView> {
  const [capabilities, factory, missions, simulations, memories] = await Promise.all([
    describeCapabilityCenter(),
    getOperationsSummary().catch(() => null),
    listMissions(30).catch(() => []),
    listSimulations(12).catch(() => []),
    recallOperationalMemory({ limit: 20 }).catch(() => []),
  ]);

  const ai = describeAiCapability();
  const research = describeResearchProviderHealth();
  const ruflo = describeRufloIntegration();
  const rufloRuntime = await describeRufloRuntime().catch(() => ({ status: 'NOT_CONNECTED', detail: 'Ruflo runtime unavailable.', unmetRequirements: [] as string[] }));
  const publishing = describePublishingStatus();
  const vercel = describeVercelConfig();

  let databaseState: SystemStateLabel = 'NOT_CONNECTED';
  let databaseDetail = 'Database probe failed.';
  try {
    await db.$queryRaw`SELECT 1`;
    databaseState = 'LIVE';
    databaseDetail = 'Database reachable.';
  } catch {
    databaseState = 'NOT_CONNECTED';
    databaseDetail = 'Database unreachable. Nothing was fabricated.';
  }

  const health: HealthTile[] = [
    { name: 'Database', state: databaseState, detail: databaseDetail },
    { name: 'AI', state: mapCapability(ai.status), detail: ai.detail },
    { name: 'Research', state: mapCapability(research.status), detail: research.hint || 'Research provider status recorded.' },
    { name: 'Ruflo', state: mapCapability(ruflo.status), detail: ruflo.detail },
    { name: 'Ruflo Runtime', state: mapCapability(rufloRuntime.status), detail: rufloRuntime.detail },
    { name: 'Publishing', state: mapCapability(publishing.status), detail: publishing.note },
    { name: 'Deployment', state: vercel.connected ? 'LIVE' : 'NOT_CONNECTED', detail: vercel.hint },
    { name: 'Agents', state: 'LIVE', detail: 'Agent registry is in-process. Execution still requires Job Runner gates.' },
    { name: 'Jobs', state: 'LIVE', detail: 'Job Runner is authoritative. Bounded retries, idempotency, halal gates.' },
    { name: 'Workflows', state: mapCapability(ruflo.status), detail: 'Workflow planner records decisions; Ruflo is not the security authority.' },
  ];

  const execution: ExecutionCounts = {
    running: missions.filter((m) => m.status === 'RUNNING').length,
    completed: missions.filter((m) => m.status === 'COMPLETED').length,
    failed: missions.filter((m) => m.status === 'FAILED').length,
    retries: missions.reduce((s, m) => s + m.retryCount, 0),
    humanReview: missions.filter((m) => m.status === 'HUMAN_REVIEW').length,
    blocked: missions.filter((m) => m.status === 'BLOCKED').length,
    waiting: missions.filter((m) => m.status === 'WAITING').length,
    queued: missions.filter((m) => m.status === 'QUEUED' || m.status === 'READY').length,
  };

  const [opportunityCount, experimentCount, productCount, loopCount, revenueAgg, simAgg, pendingReview] = await Promise.all([
    db.opportunity.count().catch(() => 0),
    db.experiment.count().catch(() => 0),
    db.product.count().catch(() => 0),
    db.loopTransition.count().catch(() => 0),
    db.revenue.aggregate({ _sum: { netRevenue: true } }).catch(() => ({ _sum: { netRevenue: null } })),
    db.simulationRun.aggregate({ _sum: { revenueUsd: true, profitUsd: true } }).catch(() => ({ _sum: { revenueUsd: null, profitUsd: null } })),
    db.jobRun.count({ where: { status: 'HUMAN_REVIEW' } }).catch(() => 0),
  ]);

  const income: IncomeEngineOps = {
    opportunities: opportunityCount,
    loopTransitions: loopCount,
    experiments: experimentCount,
    products: productCount,
    simulatedRevenueUsd: simAgg._sum.revenueUsd ?? 0,
    realRevenueUsd: revenueAgg._sum.netRevenue ?? 0,
    simulatedProfitUsd: simAgg._sum.profitUsd ?? 0,
    realProfitUsd: revenueAgg._sum.netRevenue ?? 0,
    pendingHumanInput: pendingReview + execution.humanReview,
  };

  const timeline: TimelineEvent[] = [];
  for (const m of missions.slice(0, 12)) {
    timeline.push({
      at: m.updatedAt,
      kind: 'mission',
      label: `${m.agentType} mission ${m.status}: ${m.objective.slice(0, 80)}`,
      state: m.status === 'BLOCKED' ? 'BLOCKED' : m.status === 'HUMAN_REVIEW' ? 'AWAITING_HUMAN_INPUT' : m.status === 'COMPLETED' ? 'LIVE' : 'MOCKED',
      correlationId: m.correlationId,
    });
  }
  for (const mem of memories.slice(0, 8)) {
    timeline.push({
      at: mem.createdAt,
      kind: mem.category,
      label: mem.observation.slice(0, 120),
      state: mem.treatedAsVerified ? 'LIVE' : 'MOCKED',
    });
  }
  for (const sim of simulations.slice(0, 6)) {
    timeline.push({
      at: sim.createdAt,
      kind: 'simulation',
      label: `SIMULATED revenue $${sim.revenueUsd.toFixed(0)} / profit $${sim.profitUsd.toFixed(0)} (not real)`,
      state: 'SIMULATED',
      correlationId: sim.correlationId,
    });
  }
  timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    generatedAt: new Date().toISOString(),
    health,
    execution,
    income,
    timeline: timeline.slice(0, 24),
    capabilities,
    factory,
    missions,
    simulations,
  };
}
