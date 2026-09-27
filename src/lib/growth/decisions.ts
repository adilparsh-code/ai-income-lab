// Phase 9 — Growth Decision ledger (append-only, auditable).

import { db } from '@/lib/db';
import type { GrowthDecisionType, GrowthEvidenceType } from './types';

const MAX_REASON = 1000;
const MAX_CORRELATION = 200;

export interface RecordDecisionInput {
  opportunityId: string;
  experimentId?: string | null;
  decision: GrowthDecisionType;
  reason: string;
  evidenceType: GrowthEvidenceType;
  decidedBy?: 'growth-engine' | 'business-manager' | 'human';
  metrics?: Record<string, unknown>;
  correlationId: string;
}

export async function recordGrowthDecision(input: RecordDecisionInput) {
  return db.growthDecision.create({
    data: {
      opportunityId: input.opportunityId,
      ...(input.experimentId ? { experimentId: input.experimentId } : {}),
      decision: input.decision,
      reason: input.reason.slice(0, MAX_REASON),
      evidenceType: input.evidenceType,
      decidedBy: input.decidedBy ?? 'growth-engine',
      metricsJson: JSON.stringify(input.metrics ?? {}),
      correlationId: input.correlationId.slice(0, MAX_CORRELATION),
    },
  });
}

export interface DecisionView {
  id: string;
  opportunityId: string;
  experimentId: string | null;
  decision: string;
  reason: string;
  evidenceType: string;
  decidedBy: string;
  metrics: Record<string, unknown>;
  correlationId: string;
  createdAt: string;
}

export async function listGrowthDecisions(options: { opportunityId?: string; limit?: number } = {}): Promise<DecisionView[]> {
  const rows = await db.growthDecision.findMany({
    where: { ...(options.opportunityId ? { opportunityId: options.opportunityId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, options.limit ?? 25)),
  });
  return rows.map((r) => ({
    id: r.id,
    opportunityId: r.opportunityId,
    experimentId: r.experimentId,
    decision: r.decision,
    reason: r.reason,
    evidenceType: r.evidenceType,
    decidedBy: r.decidedBy,
    metrics: safeParse(r.metricsJson),
    correlationId: r.correlationId,
    createdAt: r.createdAt.toISOString(),
  }));
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
