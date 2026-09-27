// Phase 8F — Failure classification and bounded recovery.
//
// Pure classification + deterministic backoff. Never retries authorization
// failures, halal blocks, human-review requirements, or permanently invalid
// input. Never retries endlessly.

import {
  DEFAULT_FAILURE_MAX_RETRIES,
  MAX_FAILURE_RETRIES,
  type FailureClass,
} from './types';

export interface FailureInput {
  error?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  code?: string | null;
}

export interface FailureClassification {
  classification: FailureClass;
  retryable: boolean;
  reason: string;
}

const AUTH_PATTERNS = /unauthori[sz]ed|forbidden|invalid credential|auth(entication|orization) fail|401|403/i;
const CONFIG_PATTERNS = /not[_ ]configured|missing (env|key|token|credential)|NOT_CONFIGURED/i;
const PROVIDER_PATTERNS = /not[_ ]connected|provider (unavailable|error)|ECONNREFUSED|ENOTFOUND|network|NOT_CONNECTED/i;
const VALIDATION_PATTERNS = /invalid (input|payload)|malformed|must be|required and must/i;
const HALAL_PATTERNS = /not_allowed|halal|blocked by safety/i;
const REVIEW_PATTERNS = /human[_ ]review|review_required|approval (required|token)/i;
const TIMEOUT_PATTERNS = /timeout|timed out|deadline elapsed/i;
const TRANSIENT_PATTERNS = /temporar|retry|unavailable|503|502|429|ECONNRESET|ETIMEDOUT|degraded/i;
const PERMANENT_PATTERNS = /not found|does not exist|permanent|unrecoverable/i;
const BUSINESS_PATTERNS = /losing signal|business rule|kill|not in the mission/i;

export function classifyFailure(input: FailureInput): FailureClassification {
  const blob = [input.error, input.status, input.code].filter(Boolean).join(' ');
  const http = input.httpStatus ?? 0;

  if (http === 401 || AUTH_PATTERNS.test(blob) || input.status === 'AUTHENTICATION') {
    return { classification: 'AUTHENTICATION', retryable: false, reason: 'Authorization failures are never retried.' };
  }
  if (HALAL_PATTERNS.test(blob) || input.status === 'BLOCKED') {
    return { classification: 'BUSINESS_RULE', retryable: false, reason: 'Halal/safety blocks are never retried.' };
  }
  if (REVIEW_PATTERNS.test(blob) || input.status === 'HUMAN_REVIEW') {
    return { classification: 'HUMAN_REVIEW', retryable: false, reason: 'Human-review requirements are never retried autonomously.' };
  }
  if (VALIDATION_PATTERNS.test(blob) || input.status === 'VALIDATION') {
    return { classification: 'VALIDATION', retryable: false, reason: 'Permanent invalid input is never retried.' };
  }
  if (CONFIG_PATTERNS.test(blob)) {
    return { classification: 'CONFIGURATION', retryable: false, reason: 'Missing configuration cannot be recovered by retrying.' };
  }
  if (BUSINESS_PATTERNS.test(blob)) {
    return { classification: 'BUSINESS_RULE', retryable: false, reason: 'Business-rule refusals are never retried.' };
  }
  if (TIMEOUT_PATTERNS.test(blob) || http === 408) {
    return { classification: 'TIMEOUT', retryable: true, reason: 'Timeouts are transient and retryable within bounds.' };
  }
  if (PROVIDER_PATTERNS.test(blob) || http === 502 || http === 503) {
    return { classification: 'PROVIDER_UNAVAILABLE', retryable: true, reason: 'Provider unavailability is retryable within bounds.' };
  }
  if (TRANSIENT_PATTERNS.test(blob) || http === 429) {
    return { classification: 'TRANSIENT', retryable: true, reason: 'Transient failure; bounded retry with backoff.' };
  }
  if (PERMANENT_PATTERNS.test(blob)) {
    return { classification: 'PERMANENT', retryable: false, reason: 'Permanent failure; do not retry.' };
  }
  return { classification: 'UNKNOWN', retryable: false, reason: 'Unclassified failure is treated as non-retryable (fail closed).' };
}

export function isRetryableFailureClass(classification: FailureClass): boolean {
  return classification === 'TRANSIENT' || classification === 'PROVIDER_UNAVAILABLE' || classification === 'TIMEOUT';
}

/** Exponential backoff in milliseconds: 250 * 2^attempt, capped at 8s. */
export function backoffMs(attempt: number): number {
  const n = Math.max(0, Math.min(10, Math.floor(attempt)));
  return Math.min(8_000, 250 * 2 ** n);
}

export interface RecoveryPlan {
  action: 'RETRY' | 'DEAD_LETTER' | 'STOP' | 'HUMAN_REVIEW' | 'RESUME';
  nextRetryCount: number;
  delayMs: number;
  resumePoint: string | null;
  reason: string;
}

export function planRecovery(input: {
  classification: FailureClass;
  retryCount: number;
  maxRetries?: number;
  resumePoint?: string | null;
}): RecoveryPlan {
  const max = Math.min(MAX_FAILURE_RETRIES, Math.max(0, input.maxRetries ?? DEFAULT_FAILURE_MAX_RETRIES));
  if (input.classification === 'HUMAN_REVIEW') {
    return {
      action: 'HUMAN_REVIEW',
      nextRetryCount: input.retryCount,
      delayMs: 0,
      resumePoint: input.resumePoint ?? null,
      reason: 'Human review is required; autonomous retry is forbidden.',
    };
  }
  if (!isRetryableFailureClass(input.classification)) {
    return {
      action: 'STOP',
      nextRetryCount: input.retryCount,
      delayMs: 0,
      resumePoint: input.resumePoint ?? null,
      reason: `${input.classification} failures are not retried.`,
    };
  }
  if (input.retryCount >= max) {
    return {
      action: 'DEAD_LETTER',
      nextRetryCount: input.retryCount,
      delayMs: 0,
      resumePoint: input.resumePoint ?? null,
      reason: `Retry limit (${max}) reached; failure is dead-lettered.`,
    };
  }
  return {
    action: 'RETRY',
    nextRetryCount: input.retryCount + 1,
    delayMs: backoffMs(input.retryCount),
    resumePoint: input.resumePoint ?? null,
    reason: `Retry ${input.retryCount + 1} of ${max} after ${backoffMs(input.retryCount)}ms.`,
  };
}

export interface FailureRecordShape {
  classification: FailureClass;
  retryCount: number;
  maxRetries: number;
  lastError: string;
  recoveryState: 'OPEN' | 'RETRYING' | 'DEAD_LETTER' | 'RESOLVED' | 'HUMAN_REVIEW';
  deadLettered: boolean;
  resumePoint: string | null;
  correlationId: string;
}

export function applyRecovery(record: FailureRecordShape, classification: FailureClassification): FailureRecordShape {
  const plan = planRecovery({
    classification: classification.classification,
    retryCount: record.retryCount,
    maxRetries: record.maxRetries,
    resumePoint: record.resumePoint,
  });
  if (plan.action === 'DEAD_LETTER') {
    return {
      ...record,
      classification: classification.classification,
      lastError: classification.reason,
      recoveryState: 'DEAD_LETTER',
      deadLettered: true,
    };
  }
  if (plan.action === 'HUMAN_REVIEW') {
    return {
      ...record,
      classification: classification.classification,
      lastError: classification.reason,
      recoveryState: 'HUMAN_REVIEW',
    };
  }
  if (plan.action === 'STOP') {
    return {
      ...record,
      classification: classification.classification,
      lastError: classification.reason,
      recoveryState: 'RESOLVED',
    };
  }
  return {
    ...record,
    classification: classification.classification,
    retryCount: plan.nextRetryCount,
    lastError: classification.reason,
    recoveryState: 'RETRYING',
  };
}
