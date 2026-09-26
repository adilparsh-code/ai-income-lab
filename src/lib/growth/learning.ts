// Phase 9 — Learning Memory (business memory).
//
// Persists experiment outcomes as durable, provenance-tagged learning entries.
// Future decisions may consume VERIFIED entries; AI-inferred entries are
// stored but never treated as verified truth (same rule as Phase 8 memory).

import { db } from '@/lib/db';
import {
  MAX_APPLICABILITY_LENGTH,
  MAX_CONTEXT_LENGTH,
  MAX_CORRELATION_ID_LENGTH,
  MAX_HYPOTHESIS_LENGTH,
  type LearningResult,
} from './types';

export interface LearningInput {
  opportunityId?: string | null;
  experimentId?: string | null;
  hypothesis: string;
  result: LearningResult;
  metric?: string;
  baselineValue?: number;
  measuredValue?: number | null;
  decision: string;
  context?: string;
  evidenceType?: 'VERIFIED_DATA' | 'HUMAN_DECISION' | 'AI_INFERENCE';
  applicability?: string;
  confidence?: number;
}

export interface LearningEntryView {
  id: string;
  opportunityId: string | null;
  experimentId: string | null;
  hypothesis: string;
  result: LearningResult;
  metric: string;
  baselineValue: number;
  measuredValue: number | null;
  decision: string;
  context: string;
  evidenceType: string;
  applicability: string;
  confidence: number;
  treatedAsVerified: boolean;
  createdAt: string;
}

function isVerified(evidenceType: string): boolean {
  return evidenceType === 'VERIFIED_DATA' || evidenceType === 'HUMAN_DECISION';
}

export function validateLearningInput(input: LearningInput): string[] {
  const errors: string[] = [];
  if (typeof input.hypothesis !== 'string' || input.hypothesis.trim().length === 0) {
    errors.push('hypothesis is required');
  } else if (input.hypothesis.length > MAX_HYPOTHESIS_LENGTH) {
    errors.push(`hypothesis must be at most ${MAX_HYPOTHESIS_LENGTH} characters`);
  }
  if (!(input.result === 'VALIDATED' || input.result === 'INVALIDATED' || input.result === 'INCONCLUSIVE')) {
    errors.push('result must be VALIDATED, INVALIDATED, or INCONCLUSIVE');
  }
  if (typeof input.decision !== 'string' || input.decision.trim().length === 0) {
    errors.push('decision is required');
  }
  if (input.confidence !== undefined && (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1)) {
    errors.push('confidence must be between 0 and 1');
  }
  return errors;
}

export async function recordLearning(input: LearningInput): Promise<LearningEntryView> {
  const errors = validateLearningInput(input);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const evidenceType = input.evidenceType ?? 'VERIFIED_DATA';
  const row = await db.learningEntry.create({
    data: {
      ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
      ...(input.experimentId ? { experimentId: input.experimentId } : {}),
      hypothesis: input.hypothesis.trim().slice(0, MAX_HYPOTHESIS_LENGTH),
      result: input.result,
      metric: (input.metric ?? '').slice(0, 120),
      baselineValue: input.baselineValue ?? 0,
      measuredValue: input.measuredValue ?? 0,
      decision: input.decision.slice(0, 120),
      context: (input.context ?? '').slice(0, MAX_CONTEXT_LENGTH),
      evidenceType,
      applicability: (input.applicability ?? '').slice(0, MAX_APPLICABILITY_LENGTH),
      confidence: Math.max(0, Math.min(1, input.confidence ?? (isVerified(evidenceType) ? 0.9 : 0.3))),
    },
  });
  return toView(row);
}

export async function recallLearnings(options: {
  opportunityId?: string;
  verifiedOnly?: boolean;
  limit?: number;
} = {}): Promise<LearningEntryView[]> {
  const rows = await db.learningEntry.findMany({
    where: { ...(options.opportunityId ? { opportunityId: options.opportunityId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, options.limit ?? 20)),
  });
  const views = rows.map(toView);
  return options.verifiedOnly ? views.filter((v) => v.treatedAsVerified) : views;
}

function toView(row: {
  id: string;
  opportunityId: string | null;
  experimentId: string | null;
  hypothesis: string;
  result: string;
  metric: string;
  baselineValue: number;
  measuredValue: number;
  decision: string;
  context: string;
  evidenceType: string;
  applicability: string;
  confidence: number;
  createdAt: Date;
}): LearningEntryView {
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    experimentId: row.experimentId,
    hypothesis: row.hypothesis,
    result: row.result as LearningResult,
    metric: row.metric,
    baselineValue: row.baselineValue,
    measuredValue: row.measuredValue,
    decision: row.decision,
    context: row.context,
    evidenceType: row.evidenceType,
    applicability: row.applicability,
    confidence: row.confidence,
    treatedAsVerified: isVerified(row.evidenceType),
    createdAt: row.createdAt.toISOString(),
  };
}

export { MAX_CORRELATION_ID_LENGTH };
