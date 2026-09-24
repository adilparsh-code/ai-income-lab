import { db } from '@/lib/db';

export type FailureCategory = 'TRANSIENT' | 'PERMANENT' | 'CONFIGURATION' | 'AUTHENTICATION' | 'PROVIDER_UNAVAILABLE' | 'VALIDATION_FAILURE' | 'BUSINESS_RULE_REJECTION' | 'HUMAN_REVIEW_REQUIRED' | 'TIMEOUT' | 'UNKNOWN';
export type RecoveryState = 'RETRY_SCHEDULED' | 'DEAD_LETTER' | 'HUMAN_REVIEW' | 'RESUMABLE' | 'NONE';

export interface RecoveryDecision {
  category: FailureCategory;
  state: RecoveryState;
  retryable: boolean;
  nextRetryAt: Date | null;
  deadLetter: boolean;
  resumePoint: string | null;
  reason: string;
  backoffSeconds: number;
}

const RETRYABLE: ReadonlySet<FailureCategory> = new Set(['TRANSIENT', 'PROVIDER_UNAVAILABLE', 'TIMEOUT']);

export function classifyFailure(error: { status?: string; message?: string; capabilityStatus?: string; code?: string }): FailureCategory {
  const text = `${error.status ?? ''} ${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
  if (text.includes('human') || text.includes('approval') || text.includes('review')) return 'HUMAN_REVIEW_REQUIRED';
  if (text.includes('auth') || text.includes('unauthorized') || text.includes('forbidden') || text.includes('credential')) return 'AUTHENTICATION';
  if (text.includes('config') || text.includes('not_configured') || text.includes('not configured')) return 'CONFIGURATION';
  if (text.includes('validation') || text.includes('invalid') || text.includes('schema')) return 'VALIDATION_FAILURE';
  if (text.includes('halal') || text.includes('not_allowed') || text.includes('business rule')) return 'BUSINESS_RULE_REJECTION';
  if (text.includes('timeout') || text.includes('timed out')) return 'TIMEOUT';
  if (text.includes('permanent') || text.includes('unsupported') || text.includes('not implemented')) return 'PERMANENT';
  if (text.includes('provider') || text.includes('network') || text.includes('temporarily unavailable') || text.includes('503') || text.includes('502')) return 'PROVIDER_UNAVAILABLE';
  if (text.includes('transient') || text.includes('temporary') || text.includes('rate limit')) return 'TRANSIENT';
  return 'UNKNOWN';
}

export function decideRecovery(category: FailureCategory, retryCount: number, maxRetries = 2, now = new Date(), resumePoint = 'CURRENT_STAGE'): RecoveryDecision {
  const boundedRetries = Math.max(0, Math.min(5, maxRetries));
  const attempt = Math.max(0, retryCount);
  const retryable = RETRYABLE.has(category);
  if (category === 'HUMAN_REVIEW_REQUIRED') return { category, state: 'HUMAN_REVIEW', retryable: false, nextRetryAt: null, deadLetter: false, resumePoint, reason: 'Human review is required; autonomous retry is forbidden.', backoffSeconds: 0 };
  if (!retryable) return { category, state: category === 'PERMANENT' || category === 'AUTHENTICATION' || category === 'CONFIGURATION' || category === 'VALIDATION_FAILURE' || category === 'BUSINESS_RULE_REJECTION' ? 'DEAD_LETTER' : 'RESUMABLE', retryable: false, nextRetryAt: null, deadLetter: true, resumePoint, reason: 'Failure category is not safe to retry automatically.', backoffSeconds: 0 };
  if (attempt >= boundedRetries) return { category, state: 'DEAD_LETTER', retryable: false, nextRetryAt: null, deadLetter: true, resumePoint, reason: `Retry budget exhausted after ${attempt} attempt(s).`, backoffSeconds: 0 };
  const backoffSeconds = Math.min(3600, 30 * 2 ** attempt);
  return { category, state: 'RETRY_SCHEDULED', retryable: true, nextRetryAt: new Date(now.getTime() + backoffSeconds * 1000), deadLetter: false, resumePoint, reason: `Transient failure; retry ${attempt + 1}/${boundedRetries} after bounded backoff.`, backoffSeconds };
}

export interface RecoveryRecordInput { opportunityId?: string | null; jobId?: string | null; error: { status?: string; message?: string; capabilityStatus?: string; code?: string }; retryCount: number; maxRetries?: number; correlationId: string; resumePoint?: string; now?: Date; }
export async function recordFailureRecovery(input: RecoveryRecordInput): Promise<RecoveryDecision> {
  const category = classifyFailure(input.error);
  const decision = decideRecovery(category, input.retryCount, input.maxRetries ?? 2, input.now, input.resumePoint);
  await db.failureRecovery.create({ data: { opportunityId: input.opportunityId ?? null, jobId: input.jobId ?? null, category, lastError: (input.error.message ?? 'Unknown failure').slice(0, 500), retryCount: input.retryCount, maxRetries: Math.min(5, Math.max(0, input.maxRetries ?? 2)), nextRetryAt: decision.nextRetryAt, state: decision.state, deadLetter: decision.deadLetter, resumePoint: decision.resumePoint, correlationId: input.correlationId } });
  return decision;
}

export async function listDeadLetters(limit = 20) { return db.failureRecovery.findMany({ where: { deadLetter: true }, orderBy: { updatedAt: 'desc' }, take: Math.min(50, Math.max(1, limit)), select: { id: true, opportunityId: true, jobId: true, category: true, retryCount: true, maxRetries: true, state: true, resumePoint: true, correlationId: true, updatedAt: true } }); }
