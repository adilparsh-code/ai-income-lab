// Phase 8D — Simulation / Paper-Income Mode.
//
// Every result is explicitly SIMULATED. Never stored as real Revenue.
// Deterministic seeds make tests repeatable. No real transaction occurs.

import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { decideLifecycle, type DecisionEvidence } from './decision-engine';
import { AUTONOMOUS_STAGES, type AutonomousStage, type LifecycleDecision } from './types';

export const SIMULATION_LABEL = 'SIMULATED' as const;
export const SIMULATION_MODE = 'SIMULATION' as const;

export interface SimulationInput {
  seed: string;
  opportunityId?: string;
  traffic?: number;
  conversionRate?: number;
  priceUsd?: number;
  costPerVisitorUsd?: number;
  fixedCostUsd?: number;
  failedValidationCount?: number;
  positiveValidationCount?: number;
  completedDecisionCount?: number;
  halalStatus?: string;
  highRisk?: boolean;
  hasAmbiguousSignal?: boolean;
  humanDecision?: LifecycleDecision | null;
  correlationId: string;
}

export interface SimulatedStageResult {
  stage: AutonomousStage;
  status: 'COMPLETE' | 'SKIPPED' | 'BLOCKED' | 'AWAITING_HUMAN_INPUT' | 'FAILED';
  note: string;
  label: typeof SIMULATION_LABEL;
}

export interface SimulationResult {
  mode: typeof SIMULATION_MODE;
  label: typeof SIMULATION_LABEL;
  seed: string;
  traffic: number;
  conversionRate: number;
  conversions: number;
  revenueUsd: number;
  costsUsd: number;
  profitUsd: number;
  realTransaction: false;
  stages: SimulatedStageResult[];
  decision: LifecycleDecision;
  decisionReason: string;
  correlationId: string;
  id?: string;
  summary: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedToInt(seed: string): number {
  const digest = createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0);
}

function clampRate(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export function runPaperSimulation(input: SimulationInput): SimulationResult {
  const rng = mulberry32(seedToInt(input.seed));
  const traffic = Number.isFinite(input.traffic) ? Math.max(0, Math.floor(input.traffic as number)) : Math.floor(5_000 + rng() * 15_000);
  const conversionRate = input.conversionRate !== undefined ? clampRate(input.conversionRate) : money(0.01 + rng() * 0.04);
  const priceUsd = Number.isFinite(input.priceUsd) ? Math.max(0, input.priceUsd as number) : money(9 + rng() * 40);
  const costPerVisitorUsd = Number.isFinite(input.costPerVisitorUsd) ? Math.max(0, input.costPerVisitorUsd as number) : money(0.002 + rng() * 0.01);
  const fixedCostUsd = Number.isFinite(input.fixedCostUsd) ? Math.max(0, input.fixedCostUsd as number) : money(20 + rng() * 80);

  const conversions = Math.floor(traffic * conversionRate);
  const revenueUsd = money(conversions * priceUsd);
  const costsUsd = money(traffic * costPerVisitorUsd + fixedCostUsd);
  const profitUsd = money(revenueUsd - costsUsd);

  const blocked = input.halalStatus === 'NOT_ALLOWED';
  const review = input.halalStatus === 'REVIEW_REQUIRED';

  const stages: SimulatedStageResult[] = AUTONOMOUS_STAGES.map((stage) => {
    if (blocked) {
      return { stage, status: 'BLOCKED', note: 'NOT_ALLOWED — simulation records the block, nothing is treated as live.', label: SIMULATION_LABEL };
    }
    if (review && ['DEPLOY', 'PUBLISH', 'TRAFFIC'].includes(stage)) {
      return { stage, status: 'AWAITING_HUMAN_INPUT', note: 'REVIEW_REQUIRED — human input needed before this simulated stage.', label: SIMULATION_LABEL };
    }
    if (stage === 'TRAFFIC') {
      return { stage, status: 'COMPLETE', note: `Traffic ${traffic.toLocaleString()} ${SIMULATION_LABEL}`, label: SIMULATION_LABEL };
    }
    if (stage === 'CONVERT') {
      return { stage, status: 'COMPLETE', note: `Conversion ${(conversionRate * 100).toFixed(2)}% → ${conversions} conversions ${SIMULATION_LABEL}`, label: SIMULATION_LABEL };
    }
    if (stage === 'REVENUE') {
      return { stage, status: 'COMPLETE', note: `Revenue $${revenueUsd.toFixed(2)} ${SIMULATION_LABEL}. No real transaction occurred.`, label: SIMULATION_LABEL };
    }
    return { stage, status: 'COMPLETE', note: `${stage} simulated deterministically from seed.`, label: SIMULATION_LABEL };
  });

  const evidence: DecisionEvidence = {
    failedValidationCount: input.failedValidationCount ?? 0,
    positiveValidationCount: input.positiveValidationCount ?? (profitUsd > 0 ? 1 : 0),
    completedDecisionCount: input.completedDecisionCount ?? 1,
    netRevenue: revenueUsd,
    trafficEvents: traffic,
    conversionEvents: conversions,
    costsUsd,
    halalStatus: input.halalStatus ?? 'HALAL',
    hasAmbiguousSignal: input.hasAmbiguousSignal ?? false,
    highRisk: input.highRisk ?? false,
    humanDecision: input.humanDecision ?? null,
    simulated: true,
  };
  const decision = decideLifecycle(evidence);

  const summary = [
    `MODE: ${SIMULATION_MODE}`,
    `Traffic: ${traffic.toLocaleString()}`,
    `Conversion: ${(conversionRate * 100).toFixed(1)}%`,
    `Revenue: $${revenueUsd.toFixed(0)} ${SIMULATION_LABEL}`,
    `Costs: $${costsUsd.toFixed(0)} ${SIMULATION_LABEL}`,
    `Profit: $${profitUsd.toFixed(0)} ${SIMULATION_LABEL}`,
    'No real transaction occurred.',
  ].join('\n');

  return {
    mode: SIMULATION_MODE,
    label: SIMULATION_LABEL,
    seed: input.seed,
    traffic,
    conversionRate,
    conversions,
    revenueUsd,
    costsUsd,
    profitUsd,
    realTransaction: false,
    stages,
    decision: decision.decision,
    decisionReason: decision.reason,
    correlationId: input.correlationId,
    summary,
  };
}

/**
 * Persist a simulation run. NEVER writes to the Revenue table.
 * `realTransaction` is structurally false.
 */
export async function persistSimulation(result: SimulationResult, opportunityId?: string): Promise<SimulationResult> {
  const row = await db.simulationRun.create({
    data: {
      seed: result.seed,
      opportunityId: opportunityId ?? null,
      mode: SIMULATION_MODE,
      traffic: result.traffic,
      conversionRate: result.conversionRate,
      revenueUsd: result.revenueUsd,
      costsUsd: result.costsUsd,
      profitUsd: result.profitUsd,
      label: SIMULATION_LABEL,
      stages: JSON.stringify(result.stages),
      decision: result.decision,
      realTransaction: false,
      correlationId: result.correlationId,
    },
  });
  return { ...result, id: row.id };
}

export async function listSimulations(limit = 20): Promise<Array<{
  id: string;
  seed: string;
  traffic: number;
  conversionRate: number;
  revenueUsd: number;
  costsUsd: number;
  profitUsd: number;
  label: string;
  decision: string | null;
  realTransaction: boolean;
  correlationId: string;
  createdAt: string;
  opportunityId: string | null;
}>> {
  const rows = await db.simulationRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
  });
  return rows.map((r) => ({
    id: r.id,
    seed: r.seed,
    traffic: r.traffic,
    conversionRate: r.conversionRate,
    revenueUsd: r.revenueUsd,
    costsUsd: r.costsUsd,
    profitUsd: r.profitUsd,
    label: r.label,
    decision: r.decision,
    realTransaction: r.realTransaction,
    correlationId: r.correlationId,
    createdAt: r.createdAt.toISOString(),
    opportunityId: r.opportunityId,
  }));
}

export function assertNotRealRevenue(result: SimulationResult): void {
  if (result.realTransaction !== false || result.label !== SIMULATION_LABEL || result.mode !== SIMULATION_MODE) {
    throw new Error('Simulation invariant violated: result must be SIMULATED with realTransaction=false.');
  }
}
