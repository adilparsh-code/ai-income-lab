// Phase 8G — Structured operational memory (not chat history).
//
// Categories: opportunity, product, experiment, failure, market, agent, provider.
// Memory without sufficient provenance is NEVER treated as verified truth.

import { db } from '@/lib/db';
import { evidenceRank, MEMORY_OPS_CATEGORIES, type EvidenceClass, type OpsMemoryCategory } from './types';

export interface OperationalMemoryInput {
  category: OpsMemoryCategory;
  source: string;
  evidenceType: EvidenceClass;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  opportunityId?: string | null;
  observation: string;
  outcome?: string;
  applicability?: string;
  confidence?: number;
}

export interface OperationalMemoryRecord {
  id: string;
  category: OpsMemoryCategory;
  source: string;
  evidenceType: EvidenceClass;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  opportunityId: string | null;
  observation: string;
  outcome: string;
  applicability: string;
  confidence: number;
  treatedAsVerified: boolean;
  createdAt: string;
}

const MAX_OBS = 800;

export function isVerifiedMemory(evidenceType: EvidenceClass, source: string): boolean {
  if (evidenceRank(evidenceType) < evidenceRank('VERIFIED_DATA')) return false;
  if (!source || source.trim().length === 0) return false;
  if (source === 'ai' || source === 'inference' || source === 'chat') return false;
  return true;
}

export function validateMemoryInput(input: OperationalMemoryInput): string[] {
  const errors: string[] = [];
  if (!(MEMORY_OPS_CATEGORIES as readonly string[]).includes(input.category)) {
    errors.push('unknown memory category');
  }
  if (typeof input.source !== 'string' || input.source.trim().length === 0) {
    errors.push('source is required');
  }
  if (typeof input.observation !== 'string' || input.observation.trim().length === 0) {
    errors.push('observation is required');
  }
  if (input.observation && input.observation.length > MAX_OBS) {
    errors.push(`observation must be at most ${MAX_OBS} characters`);
  }
  return errors;
}

function toRecord(row: {
  id: string;
  category: string;
  source: string;
  evidenceType: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  opportunityId: string | null;
  observation: string;
  outcome: string;
  applicability: string;
  confidence: number;
  createdAt: Date;
}): OperationalMemoryRecord {
  const evidenceType = row.evidenceType as EvidenceClass;
  return {
    id: row.id,
    category: row.category as OpsMemoryCategory,
    source: row.source,
    evidenceType,
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    opportunityId: row.opportunityId,
    observation: row.observation,
    outcome: row.outcome,
    applicability: row.applicability,
    confidence: row.confidence,
    treatedAsVerified: isVerifiedMemory(evidenceType, row.source),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function persistOperationalMemory(input: OperationalMemoryInput): Promise<OperationalMemoryRecord> {
  const errors = validateMemoryInput(input);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  const row = await db.operationalMemory.create({
    data: {
      category: input.category,
      source: input.source.trim().slice(0, 120),
      evidenceType: input.evidenceType,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      opportunityId: input.opportunityId ?? null,
      observation: input.observation.trim().slice(0, MAX_OBS),
      outcome: (input.outcome ?? '').slice(0, 400),
      applicability: (input.applicability ?? '').slice(0, 400),
      confidence: Math.max(0, Math.min(1, input.confidence ?? (isVerifiedMemory(input.evidenceType, input.source) ? 0.9 : 0.3))),
    },
  });
  return toRecord(row);
}

export async function recallOperationalMemory(options: {
  category?: OpsMemoryCategory;
  opportunityId?: string;
  relatedEntityId?: string;
  verifiedOnly?: boolean;
  limit?: number;
}): Promise<OperationalMemoryRecord[]> {
  const rows = await db.operationalMemory.findMany({
    where: {
      ...(options.category ? { category: options.category } : {}),
      ...(options.opportunityId ? { opportunityId: options.opportunityId } : {}),
      ...(options.relatedEntityId ? { relatedEntityId: options.relatedEntityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(50, Math.max(1, options.limit ?? 12)),
  });
  const mapped = rows.map(toRecord);
  if (options.verifiedOnly) return mapped.filter((m) => m.treatedAsVerified);
  return mapped.sort((a, b) => {
    const rank = evidenceRank(b.evidenceType) - evidenceRank(a.evidenceType);
    if (rank !== 0) return rank;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
