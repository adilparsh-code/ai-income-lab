// Phase 10.2 — Agent Operations Overview.
//
// Aggregates EXISTING rows (AgentDefinition, AgentRun, AgentHealth,
// AgentPermission, AgentLog, AgencyControl) into a per-agent observation.
// Deterministic over the same rows; nothing is fabricated. Missing data is
// returned as null + UNKNOWN, never zero (Phase 10.15).

import { db } from '@/lib/db';
import type { AgentObservation, AgentRunSnapshot, QualityValue } from './types';

function toSnapshot(row: {
  id: string;
  jobType: string;
  stage: string;
  status: string;
  correlationId: string;
  startedAt: Date;
  completedAt: Date | null;
  safetyVerdict: string | null;
  failureReason: string | null;
  jobId: string | null;
}): AgentRunSnapshot {
  return {
    id: row.id,
    jobType: row.jobType,
    stage: row.stage,
    status: row.status,
    correlationId: row.correlationId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    safetyVerdict: row.safetyVerdict,
    failureReason: row.failureReason,
    jobId: row.jobId,
  };
}

const ACTIVE_STATUSES = ['QUEUED', 'RUNNING'];

/** Deterministic next-action label from the run's stage; null when nothing actionable. */
function nextActionFor(run: { status: string; stage: string } | null, paused: boolean): string | null {
  if (paused) return 'Agency paused — all execution held pending admin resume.';
  if (!run) return null;
  switch (run.status) {
    case 'RUNNING':
      return `Continue current stage (${run.stage}); supervisor evaluates on completion.`;
    case 'QUEUED':
      return 'Awaiting Job Runner pickup.';
    case 'HUMAN_REVIEW':
      return 'Admin review required before any further action.';
    case 'BLOCKED':
      return 'Blocked by safety gates; inspect reason before retry.';
    case 'FAILED':
      return 'Inspect failure and recovery plan in the Job Runner.';
    case 'SUCCEEDED':
      return 'No open action; await next governed dispatch.';
    default:
      return null;
  }
}

export async function getAgentObservations(): Promise<{
  paused: boolean;
  pauseReason: string | null;
  agents: AgentObservation[];
}> {
  const control = await db.agencyControl.findUnique({ where: { key: 'autonomy' } });
  const paused = control?.paused ?? false;

  const [definitions, runs, healthRows, permissions, logRows] = await Promise.all([
    db.agentDefinition.findMany({ orderBy: { agentId: 'asc' } }),
    db.agentRun.findMany({ orderBy: { startedAt: 'desc' }, take: 500 }),
    db.agentHealth.findMany(),
    db.agentPermission.findMany(),
    // Cost/model provenance comes from AgentLog rows (the existing AI usage
    // choke point). Bounded window keeps the read cheap and recent.
    db.agentLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: {
        agentType: true,
        aiProvider: true,
        aiModel: true,
        estimatedCostUsd: true,
        success: true,
        createdAt: true,
      },
    }),
  ]);

  const healthByAgent = new Map(healthRows.map((h) => [h.agentId, h]));
  const permissionsByAgent = new Map<string, number>();
  for (const p of permissions) permissionsByAgent.set(p.agentId, (permissionsByAgent.get(p.agentId) ?? 0) + 1);

  // Cost aggregation per agent over the bounded window (REAL recorded sums).
  const costByAgent = new Map<string, { cost: number; entries: number; provider: string | null; model: string | null }>();
  for (const row of logRows) {
    const entry = costByAgent.get(row.agentType) ?? { cost: 0, entries: 0, provider: null, model: null };
    entry.entries += 1;
    if (typeof row.estimatedCostUsd === 'number') entry.cost += row.estimatedCostUsd;
    if (!entry.provider && row.aiProvider) entry.provider = row.aiProvider;
    if (!entry.model && row.aiModel) entry.model = row.aiModel;
    costByAgent.set(row.agentType, entry);
  }

  const runsByAgent = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = runsByAgent.get(r.agentId) ?? [];
    list.push(r);
    runsByAgent.set(r.agentId, list);
  }

  const agents: AgentObservation[] = definitions.map((def) => {
    const agentRuns = runsByAgent.get(def.agentId) ?? [];
    const current = agentRuns.find((r) => ACTIVE_STATUSES.includes(r.status)) ?? null;
    const last = agentRuns.find((r) => !ACTIVE_STATUSES.includes(r.status)) ?? agentRuns[0] ?? null;
    const health = healthByAgent.get(def.agentId);
    const cost = costByAgent.get(def.agentId);

    const modelProvider: QualityValue<string> =
      cost?.provider || cost?.model
        ? { value: [cost?.provider, cost?.model].filter(Boolean).join(' / '), label: 'REAL', source: 'AgentLog rows (AI usage choke point)' }
        : { value: null, label: 'UNKNOWN', source: 'No recorded AI usage rows for this agent' };

    const estimatedAiCostUsd: QualityValue<number> =
      cost && cost.entries > 0
        ? { value: Math.round(cost.cost * 10000) / 10000, label: 'REAL', source: `Sum of ${cost.entries} AgentLog.estimatedCostUsd rows` }
        : { value: null, label: 'UNKNOWN', source: 'No recorded cost rows — never rendered as 0' };

    return {
      agentId: def.agentId,
      role: def.role,
      healthState: health?.state ?? 'UNKNOWN',
      governance: {
        paused,
        requiresApproval: def.requiresApproval,
        budgetLimitUsd: def.budgetLimitUsd,
        budgetConsumedUsd: cost && cost.entries > 0 ? Math.round(cost.cost * 10000) / 10000 : null,
        permissionCount: permissionsByAgent.get(def.agentId) ?? 0,
      },
      runs: {
        total: agentRuns.length,
        running: agentRuns.filter((r) => r.status === 'RUNNING').length,
        succeeded: agentRuns.filter((r) => r.status === 'SUCCEEDED').length,
        failed: agentRuns.filter((r) => r.status === 'FAILED').length,
        blocked: agentRuns.filter((r) => r.status === 'BLOCKED').length,
        humanReview: agentRuns.filter((r) => r.status === 'HUMAN_REVIEW').length,
        lastActivityAt: agentRuns[0]?.startedAt.toISOString() ?? null,
      },
      lastRun: last ? toSnapshot(last) : null,
      currentRun: current ? toSnapshot(current) : null,
      modelProvider,
      estimatedAiCostUsd,
      nextAction: nextActionFor(current ?? last, paused),
    };
  });

  return { paused, pauseReason: control?.pauseReason ?? null, agents };
}
