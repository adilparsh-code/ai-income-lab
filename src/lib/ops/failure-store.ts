// Phase 8F — durable failure records. Classification stays in failure-recovery.ts
// (pure). This module only persists bounded recovery state.

import { db } from '@/lib/db';
import {
  applyRecovery,
  classifyFailure,
  type FailureClassification,
  type FailureInput,
  type FailureRecordShape,
} from './failure-recovery';
import { DEFAULT_FAILURE_MAX_RETRIES, type FailureClass } from './types';

export async function recordFailure(input: {
  error: string;
  status?: string | null;
  correlationId: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  opportunityId?: string;
  resumePoint?: string;
  existing?: FailureRecordShape | null;
}): Promise<FailureRecordShape & { id: string }> {
  const classification: FailureClassification = classifyFailure({
    error: input.error,
    status: input.status,
  } satisfies FailureInput);
  const base: FailureRecordShape = input.existing ?? {
    classification: classification.classification,
    retryCount: 0,
    maxRetries: DEFAULT_FAILURE_MAX_RETRIES,
    lastError: input.error.slice(0, 400),
    recoveryState: 'OPEN',
    deadLettered: false,
    resumePoint: input.resumePoint ?? null,
    correlationId: input.correlationId,
  };
  const next = applyRecovery({ ...base, lastError: input.error.slice(0, 400) }, classification);
  const row = await db.failureRecord.create({
    data: {
      classification: next.classification,
      retryCount: next.retryCount,
      maxRetries: next.maxRetries,
      lastError: next.lastError.slice(0, 400),
      recoveryState: next.recoveryState,
      deadLettered: next.deadLettered,
      resumePoint: next.resumePoint,
      correlationId: next.correlationId,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      opportunityId: input.opportunityId ?? null,
    },
  });
  return { ...next, id: row.id };
}

export async function getFailureByCorrelation(correlationId: string): Promise<{
  classification: FailureClass;
  retryCount: number;
  deadLettered: boolean;
  recoveryState: string;
  lastError: string;
  resumePoint: string | null;
} | null> {
  const row = await db.failureRecord.findFirst({
    where: { correlationId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return {
    classification: row.classification as FailureClass,
    retryCount: row.retryCount,
    deadLettered: row.deadLettered,
    recoveryState: row.recoveryState,
    lastError: row.lastError,
    resumePoint: row.resumePoint,
  };
}
