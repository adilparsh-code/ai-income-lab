// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — action processor (the enforcement chain)
// ============================================================================
// The ONLY path from an external agent request to work execution. Order of
// gates (each one fails closed; none is skippable from the outside):
//
//   1. IDEMPOTENCY        — replayed requestId returns the stored response
//   2. AUTHORIZATION      — server-derived capability grant check
//   3. RESOURCE           — referenced opportunity must exist + be actionable
//   4. SAFETY / HALAL     — payload screened by the EXISTING halal gate
//   5. BUDGET / RATE      — durable per-credential request cap
//   6. DISPATCH           — EXISTING Job Runner only (never direct execution)
//   7. AUDIT              — AgentActionRecord (created before dispatch)
//   8. RESPONSE           — bounded, secret-free envelope
//
// Invariants (mirroring the rest of this repository):
// - The processor never interprets payload content as instructions and never
//   lets the caller name the executed job type — the mapping is fixed per
//   capability in the catalog.
// - HUMAN_APPROVAL capabilities create a HumanReview row and NEVER execute.
// - Job Runner internal gates (halal status, validation, idempotency, bounded
//   retries) remain authoritative and run again inside runJob().
// ============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { runJob } from '@/lib/jobs/job-runner';
import type { JobOutcome } from '@/lib/jobs/types';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { enforceRateLimit } from '@/lib/security/guard';
import { createHumanReview } from '@/lib/agency/runtime';
import type { AgentErrorCode, AgentRequest } from './contract';
import { authorizeCapability, getCapability, type WriteAuthority } from './capabilities';
import { attachJobToAgentAction, recordAgentAction, auditAgentEvent, refusalDetail, safeReason, type AgentActionDb } from './audit';
import type { AgentIdentity } from './contract';

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

export type AgentActionResult =
  | {
      ok: true;
      httpStatus: 200 | 201 | 202;
      response: {
        contractVersion: 'v1';
        requestId: string;
        correlationId: string;
        accepted: true;
        status: 'ACCEPTED' | 'DUPLICATE' | 'HUMAN_APPROVAL_REQUIRED';
        jobId: string | null;
        reviewId: string | null;
        result: Record<string, unknown> | null;
        timestamp: string;
      };
    }
  | {
      ok: false;
      httpStatus: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503;
      response: {
        contractVersion: 'v1';
        requestId: string | null;
        correlationId: string | null;
        code: AgentErrorCode;
        message: string;
        details: string[];
        timestamp: string;
      };
    };

type AgentErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503;

function errorResult(
  code: AgentErrorCode,
  message: string,
  requestId: string | null,
  correlationId: string | null,
  httpStatus: AgentErrorHttpStatus,
  details: string[] = [],
): AgentActionResult {
  return {
    ok: false,
    httpStatus,
    response: {
      contractVersion: 'v1',
      requestId,
      correlationId,
      code,
      message: message.slice(0, 300),
      details: details.slice(0, 10).map((d) => d.slice(0, 200)),
      timestamp: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Injectable surfaces (hermetic tests inject all of them)
// ---------------------------------------------------------------------------

export interface RunJobSeam {
  runJob: typeof runJob;
}

export interface RateSeam {
  enforceRateLimit: typeof enforceRateLimit;
}

export interface ProcessorOptions {
  auditStore?: AgentActionDb;
  runJob?: RunJobSeam['runJob'];
  rate?: RateSeam['enforceRateLimit'];
  /** Test seam: create a HumanReview row without touching the real store. */
  reviews?: { createHumanReview: typeof createHumanReview };
  now?: Date;
}

// ---------------------------------------------------------------------------
// Resource + safety evaluation (pure where possible)
// ---------------------------------------------------------------------------

export interface ResourceView {
  opportunityId: string | null;
  halalStatus: string | null;
}

export type ResourceDecision =
  | { ok: true; verdict: 'HALAL' | 'NOT_APPLICABLE'; resource: ResourceView }
  | { ok: true; verdict: 'REVIEW_REQUIRED'; resource: ResourceView; reasons: string[] }
  | { ok: false; code: AgentErrorCode; httpStatus: 400 | 404 | 409; message: string; verdict: 'NOT_ALLOWED' | 'NOT_APPLICABLE' };

/**
 * Validate the referenced resource (if any) and re-derive the halal verdict
 * LOCALLY from the existing screening gate. A caller can never assert its way
 * past this: the input is only the bounded payload text.
 */
export function evaluateResourceAndSafety(request: AgentRequest, resource: ResourceView): ResourceDecision {
  const capability = getCapability(request.action);
  if (!capability) {
    return { ok: false, code: 'INVALID_REQUEST', httpStatus: 400, message: 'Unknown capability.', verdict: 'NOT_APPLICABLE' };
  }

  // Referenced opportunity must exist when the capability is scoped to one.
  const needsOpportunity = capability.authority !== 'HUMAN_APPROVAL' && request.payload.opportunityId !== undefined;
  if (needsOpportunity && !resource.opportunityId) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      httpStatus: 404,
      message: 'The referenced opportunity was not found.',
      verdict: 'NOT_APPLICABLE',
    };
  }

  if (!capability.halalScreened) {
    return { ok: true, verdict: 'NOT_APPLICABLE', resource };
  }

  // A NOT_ALLOWED opportunity on file blocks before any payload screening.
  if (resource.halalStatus === 'NOT_ALLOWED') {
    return {
      ok: false,
      code: 'SAFETY_BLOCKED',
      httpStatus: 409,
      message: 'Blocked: the referenced opportunity did not pass halal screening.',
      verdict: 'NOT_ALLOWED',
    };
  }

  // Screen the payload's free text with the EXISTING deterministic gate.
  const title = typeof request.payload.title === 'string' ? request.payload.title : request.action;
  const objective = typeof request.payload.researchObjective === 'string'
    ? request.payload.researchObjective
    : typeof request.payload.validationObjective === 'string'
      ? request.payload.validationObjective
      : typeof request.payload.objective === 'string'
        ? request.payload.objective
        : '';
  const category = typeof request.payload.marketCategory === 'string' ? request.payload.marketCategory : '';
  const businessModel = typeof request.payload.businessModel === 'string' ? request.payload.businessModel : '';
  const monetization = typeof request.payload.monetizationMethod === 'string' ? request.payload.monetizationMethod : '';

  const screening = screenForHalalCompliance(
    title.slice(0, 300),
    objective.slice(0, 2000),
    category.slice(0, 200),
    businessModel.slice(0, 200),
    monetization.slice(0, 200),
  );

  if (screening.status === 'NOT_ALLOWED') {
    return { ok: false, code: 'SAFETY_BLOCKED', httpStatus: 409, message: 'Blocked: the request did not pass halal screening.', verdict: 'NOT_ALLOWED' };
  }
  if (screening.status === 'REVIEW_REQUIRED') {
    return { ok: true, verdict: 'REVIEW_REQUIRED', resource, reasons: screening.reasons.slice(0, 5) };
  }
  return { ok: true, verdict: 'HALAL', resource };
}

// ---------------------------------------------------------------------------
// Fixed payload construction — the caller never names the job type
// ---------------------------------------------------------------------------

const MAX_OBJECTIVE = 2000;

function buildJobPayload(request: AgentRequest): { jobType: string; payload: Record<string, unknown> } | null {
  const capability = getCapability(request.action);
  if (!capability || !capability.jobType) return null;
  const p = request.payload;
  const str = (key: string, max = MAX_OBJECTIVE): string | undefined => {
    const v = p[key];
    return typeof v === 'string' && v.trim().length > 0 ? v.slice(0, max) : undefined;
  };

  switch (capability.jobType) {
    case 'RESEARCH': {
      const researchObjective = str('researchObjective');
      if (!researchObjective) return null;
      const payload: Record<string, unknown> = { researchObjective, source: 'AGENT_V1' };
      const marketCategory = str('marketCategory', 200);
      const targetAudience = str('targetAudience', 300);
      if (marketCategory) payload.marketCategory = marketCategory;
      if (targetAudience) payload.targetAudience = targetAudience;
      if (typeof p.opportunityId === 'string') payload.opportunityId = p.opportunityId.slice(0, 128);
      return { jobType: 'RESEARCH', payload };
    }
    case 'VALIDATION': {
      const validationObjective = str('validationObjective');
      if (!validationObjective) return null;
      const payload: Record<string, unknown> = { validationObjective, source: 'AGENT_V1' };
      if (typeof p.opportunityId === 'string') payload.opportunityId = p.opportunityId.slice(0, 128);
      return { jobType: 'VALIDATION', payload };
    }
    case 'OPPORTUNITY_PIPELINE': {
      const objective = str('objective');
      if (!objective) return null;
      const payload: Record<string, unknown> = { objective, source: 'AGENT_V1' };
      if (typeof p.opportunityId === 'string') payload.opportunityId = p.opportunityId.slice(0, 128);
      return { jobType: 'OPPORTUNITY_PIPELINE', payload };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

export interface ProcessInput {
  /** Already Zod-validated request (route calls validateAgentRequest first). */
  request: AgentRequest;
  /** Server-derived identity from the authenticated credential. */
  identity: AgentIdentity;
  /** Locally-known resource state (opportunity halal status), may be null. */
  resource: ResourceView;
}

export async function processAgentAction(input: ProcessInput, options: ProcessorOptions = {}): Promise<AgentActionResult> {
  const { request, identity, resource } = input;
  const auditStore = options.auditStore;
  const doRunJob = options.runJob ?? runJob;
  const doRateLimit = options.rate ?? enforceRateLimit;
  const doCreateReview = options.reviews?.createHumanReview ?? createHumanReview;

  // ---- 1. IDEMPOTENCY (read path) ----------------------------------------
  const existing = await (auditStore ?? recordAgentActionStore()).agentActionRecord.findUnique({
    where: { requestId: request.requestId },
  }).catch(() => null);
  if (existing) {
    await auditAgentEvent('AGENT_ACTION_DUPLICATE', 'refused', refusalDetail('DUPLICATE_REQUEST', request.correlationId));
    return duplicateResult(existing);
  }

  // ---- 2. AUTHORIZATION (server-derived grant) ---------------------------
  const authz = authorizeCapability(request.action, identity.grantedCapabilities);
  if (!authz.allowed) {
    await recordAgentAction(
      {
        agentId: identity.agentId,
        agentVersion: request.agentVersion,
        action: request.action,
        requestId: request.requestId,
        correlationId: request.correlationId,
        authorizationResult: 'DENIED_CAPABILITY',
        safetyVerdict: 'NOT_APPLICABLE',
        status: 'REJECTED',
        reason: safeReason(authz.reason),
        agentFingerprint: identity.fingerprint,
      },
      auditStore,
    );
    await auditAgentEvent('AGENT_ACTION_FORBIDDEN', 'refused', refusalDetail('FORBIDDEN_CAPABILITY', request.correlationId));
    return errorResult('FORBIDDEN_CAPABILITY', authz.reason, request.requestId, request.correlationId, 403);
  }

  // ---- 3 + 4. RESOURCE + SAFETY (locally re-derived, never asserted) ------
  const safety = evaluateResourceAndSafety(request, resource);
  if (!safety.ok) {
    await recordAgentAction(
      {
        agentId: identity.agentId,
        agentVersion: request.agentVersion,
        action: request.action,
        requestId: request.requestId,
        correlationId: request.correlationId,
        authorizationResult: 'ALLOWED',
        safetyVerdict: safety.verdict,
        status: 'BLOCKED',
        reason: safeReason(safety.message),
        agentFingerprint: identity.fingerprint,
      },
      auditStore,
    );
    await auditAgentEvent('AGENT_ACTION_SAFETY_BLOCKED', 'refused', refusalDetail(safety.code, request.correlationId));
    return errorResult(safety.code, safety.message, request.requestId, request.correlationId, safety.httpStatus);
  }

  // ---- 5. BUDGET / RATE (durable, per-credential) -------------------------
  const limit = await doRateLimit({
    surface: 'agent:v1:actions',
    identity: `${identity.credentialLabel}:${identity.fingerprint}`,
    max: readRateMax(),
    windowSeconds: 60,
  });
  if (!limit.allowed) {
    await recordAgentAction(
      {
        agentId: identity.agentId,
        agentVersion: request.agentVersion,
        action: request.action,
        requestId: request.requestId,
        correlationId: request.correlationId,
        authorizationResult: 'ALLOWED',
        safetyVerdict: safety.verdict,
        status: 'REJECTED',
        reason: 'Rate limit exceeded for this agent credential. Retry after the window resets.',
        agentFingerprint: identity.fingerprint,
      },
      auditStore,
    );
    await auditAgentEvent('AGENT_ACTION_RATE_LIMITED', 'refused', refusalDetail('RATE_LIMITED', request.correlationId));
    return errorResult('RATE_LIMITED', 'Rate limit exceeded. Retry later.', request.requestId, request.correlationId, 429);
  }

  // ---- HUMAN_APPROVAL capabilities: review, never execution ---------------
  const capability = getCapability(request.action);
  if (capability && capability.authority === 'HUMAN_APPROVAL') {
    const review = await doCreateReview({
      category: capability.reviewCategory ?? 'SAFETY_REVIEW',
      title: `Agent ${request.action} request (agent: ${identity.agentId})`,
      detail: safeReason(payloadText(request, ['changeSummary', 'productId']), 500) || 'No additional detail supplied.',
      requestedBy: `agent:${identity.agentId}`.slice(0, 60),
      opportunityId: typeof request.payload.opportunityId === 'string' ? request.payload.opportunityId.slice(0, 128) : undefined,
      correlationId: request.correlationId,
    });
    if (!review.ok) {
      await auditAgentEvent('AGENT_ACTION_ERROR', 'error', refusalDetail('INVALID_REQUEST', request.correlationId));
      return errorResult('INVALID_REQUEST', review.error, request.requestId, request.correlationId, 400);
    }
    await recordAgentAction(
      {
        agentId: identity.agentId,
        agentVersion: request.agentVersion,
        action: request.action,
        requestId: request.requestId,
        correlationId: request.correlationId,
        authorizationResult: 'ALLOWED',
        safetyVerdict: 'NOT_APPLICABLE',
        status: 'HUMAN_APPROVAL_REQUIRED',
        reviewId: review.id,
        result: { reviewId: review.id, category: capability.reviewCategory, note: 'No work executed. Awaiting human decision.' },
        reason: 'Queued for human approval. Nothing was executed.',
        agentFingerprint: identity.fingerprint,
      },
      auditStore,
    );
    await auditAgentEvent('AGENT_ACTION_HUMAN_APPROVAL', 'ok', refusalDetail('HUMAN_APPROVAL_REQUIRED', request.correlationId));
    return {
      ok: true,
      httpStatus: 202,
      response: {
        contractVersion: 'v1',
        requestId: request.requestId,
        correlationId: request.correlationId,
        accepted: true,
        status: 'HUMAN_APPROVAL_REQUIRED',
        jobId: null,
        reviewId: review.id,
        result: { reviewId: review.id, category: capability.reviewCategory, note: 'No work executed. Awaiting human decision.' },
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Safety-flagged payloads (REVIEW_REQUIRED) hold for a human decision too.
  if (safety.verdict === 'REVIEW_REQUIRED') {
    const review = await doCreateReview({
      category: 'SAFETY_REVIEW',
      title: `Agent ${request.action} flagged for review (agent: ${identity.agentId})`,
      detail: safeReason(safety.reasons.join('; '), 500),
      requestedBy: `agent:${identity.agentId}`.slice(0, 60),
      opportunityId: typeof request.payload.opportunityId === 'string' ? request.payload.opportunityId.slice(0, 128) : undefined,
      correlationId: request.correlationId,
    });
    if (review.ok) {
      await recordAgentAction(
        {
          agentId: identity.agentId,
          agentVersion: request.agentVersion,
          action: request.action,
          requestId: request.requestId,
          correlationId: request.correlationId,
          authorizationResult: 'ALLOWED',
          safetyVerdict: 'REVIEW_REQUIRED',
          status: 'HUMAN_APPROVAL_REQUIRED',
          reviewId: review.id,
          result: { reviewId: review.id, reasons: safety.reasons.slice(0, 5), note: 'No work executed. Awaiting human review.' },
          reason: 'Halal screening: REVIEW_REQUIRED. Awaiting human review; nothing was executed.',
          agentFingerprint: identity.fingerprint,
        },
        auditStore,
      );
      await auditAgentEvent('AGENT_ACTION_REVIEW_REQUIRED', 'refused', refusalDetail('HUMAN_APPROVAL_REQUIRED', request.correlationId));
      return {
        ok: true,
        httpStatus: 202,
        response: {
          contractVersion: 'v1',
          requestId: request.requestId,
          correlationId: request.correlationId,
          accepted: true,
          status: 'HUMAN_APPROVAL_REQUIRED',
          jobId: null,
          reviewId: review.id,
          result: { reviewId: review.id, reasons: safety.reasons.slice(0, 5), note: 'No work executed. Awaiting human review.' },
          timestamp: new Date().toISOString(),
        },
      };
    }
    // Fall through: without a review row the safe direction is refusal.
    await auditAgentEvent('AGENT_ACTION_ERROR', 'error', refusalDetail('INTERNAL_ERROR', request.correlationId));
    return errorResult('INTERNAL_ERROR', 'Could not queue the human review. Nothing was executed.', request.requestId, request.correlationId, 500);
  }

  // ---- 6. DISPATCH (existing Job Runner; fixed job mapping) ---------------
  const built = buildJobPayload(request);
  if (!built) {
    await recordAgentAction(
      {
        agentId: identity.agentId,
        agentVersion: request.agentVersion,
        action: request.action,
        requestId: request.requestId,
        correlationId: request.correlationId,
        authorizationResult: 'ALLOWED',
        safetyVerdict: safety.verdict,
        status: 'REJECTED',
        reason: 'Payload is missing the required objective field for this capability.',
        agentFingerprint: identity.fingerprint,
      },
      auditStore,
    );
    await auditAgentEvent('AGENT_ACTION_REJECTED', 'refused', refusalDetail('INVALID_REQUEST', request.correlationId));
    return errorResult(
      'INVALID_REQUEST',
      'Payload is missing the required objective field for this capability.',
      request.requestId,
      request.correlationId,
      400,
    );
  }

  // Correlation namespace: agentId + caller correlation keeps distinct agents
  // from colliding in the Job Runner's (jobType, correlationId) idempotency.
  const jobCorrelation = `agent:${identity.agentId}:${request.correlationId}`.slice(0, 200);

  // Reserve the audit row BEFORE dispatch so a crash can never lose the trail.
  const reserved = await recordAgentAction(
    {
      agentId: identity.agentId,
      agentVersion: request.agentVersion,
      action: request.action,
      requestId: request.requestId,
      correlationId: request.correlationId,
      authorizationResult: 'ALLOWED',
      safetyVerdict: safety.verdict,
      status: 'ACCEPTED',
      reason: 'Accepted; dispatched to the Job Runner.',
      agentFingerprint: identity.fingerprint,
      result: { jobCorrelation, note: 'Dispatched to the existing Job Runner.' },
    },
    auditStore,
  );
  if (!reserved.ok || !reserved.row) {
    await auditAgentEvent('AGENT_ACTION_ERROR', 'error', 'audit-reservation-failed');
    return errorResult('INTERNAL_ERROR', 'Could not record the action. Nothing was executed.', request.requestId, request.correlationId, 500);
  }
  if (reserved.raced) {
    // A concurrent duplicate won the unique requestId race.
    await auditAgentEvent('AGENT_ACTION_DUPLICATE', 'refused', refusalDetail('DUPLICATE_REQUEST', request.correlationId));
    return duplicateResult(reserved.row);
  }

  let outcome: JobOutcome;
  try {
    outcome = await doRunJob(built.jobType as never, built.payload as never, jobCorrelation);
  } catch {
    await attachJobToAgentAction(request.requestId, { status: 'FAILED' }, auditStore);
    await auditAgentEvent('AGENT_ACTION_ERROR', 'error', refusalDetail('INTERNAL_ERROR', request.correlationId));
    return errorResult('INTERNAL_ERROR', 'Dispatch to the Job Runner failed. No work was completed.', request.requestId, request.correlationId, 500);
  }

  // ---- 8. Map the outcome honestly ---------------------------------------
  const resultSnapshot: Record<string, unknown> = {
    jobId: outcome.jobId,
    jobType: outcome.jobType,
    jobStatus: outcome.status,
    executionMode: outcome.executionMode ?? 'unknown',
    deduplicated: outcome.deduplicated,
    result: outcome.result ?? null,
  };

  if (outcome.status === 'BLOCKED') {
    await attachJobToAgentAction(request.requestId, { status: 'BLOCKED', jobId: outcome.jobId, reason: 'Job Runner halal gate blocked execution.' }, auditStore);
    await auditAgentEvent('AGENT_ACTION_SAFETY_BLOCKED', 'refused', refusalDetail('SAFETY_BLOCKED', request.correlationId));
    return errorResult('SAFETY_BLOCKED', 'Blocked by the Job Runner safety gate. No work was executed.', request.requestId, request.correlationId, 409);
  }
  if (outcome.status === 'HUMAN_REVIEW') {
    await attachJobToAgentAction(request.requestId, { status: 'HUMAN_APPROVAL_REQUIRED', jobId: outcome.jobId }, auditStore);
    await auditAgentEvent('AGENT_ACTION_HUMAN_REVIEW_JOB', 'ok', refusalDetail('HUMAN_APPROVAL_REQUIRED', request.correlationId));
    return {
      ok: true,
      httpStatus: 202,
      response: {
        contractVersion: 'v1',
        requestId: request.requestId,
        correlationId: request.correlationId,
        accepted: true,
        status: 'HUMAN_APPROVAL_REQUIRED',
        jobId: outcome.jobId,
        reviewId: null,
        result: { ...resultSnapshot, note: 'The job paused for human review inside the Job Runner.' },
        timestamp: new Date().toISOString(),
      },
    };
  }
  if (outcome.status === 'FAILED') {
    await attachJobToAgentAction(request.requestId, { status: 'FAILED', jobId: outcome.jobId }, auditStore);
    await auditAgentEvent('AGENT_ACTION_ERROR', 'error', refusalDetail('INTERNAL_ERROR', request.correlationId));
    return errorResult('INTERNAL_ERROR', 'The dispatched job failed. Inspect the job id for details.', request.requestId, request.correlationId, 500);
  }

  await attachJobToAgentAction(request.requestId, { jobId: outcome.jobId, status: 'ACCEPTED' }, auditStore);
  await auditAgentEvent('AGENT_ACTION_ACCEPTED', 'ok', `job=${outcome.jobId.slice(0, 40)}`);

  return {
    ok: true,
    httpStatus: 201,
    response: {
      contractVersion: 'v1',
      requestId: request.requestId,
      correlationId: request.correlationId,
      accepted: true,
      status: 'ACCEPTED',
      jobId: outcome.jobId,
      reviewId: null,
      result: resultSnapshot,
      timestamp: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRateMax(): number {
  const raw = Number(process.env.AGENT_RATE_LIMIT_PER_MINUTE);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(300, Math.floor(raw));
}

function duplicateResult(row: {
  requestId: string;
  correlationId: string;
  status: string;
  jobId: string | null;
  reviewId: string | null;
  resultJson: string;
}): AgentActionResult {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(row.resultJson);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const isReview = row.status === 'HUMAN_APPROVAL_REQUIRED';
  return {
    ok: true,
    httpStatus: 200,
    response: {
      contractVersion: 'v1',
      requestId: row.requestId,
      correlationId: row.correlationId,
      accepted: true,
      status: isReview ? 'HUMAN_APPROVAL_REQUIRED' : 'DUPLICATE',
      jobId: row.jobId,
      reviewId: row.reviewId,
      result: parsed,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Lazily resolve the default audit store (the real Prisma client behind the
 * lazy proxy). Kept in a function so importing this module never touches db.
 */
function recordAgentActionStore(): AgentActionDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { db } = require('@/lib/db') as { db: unknown };
  return db as unknown as AgentActionDb;
}

/** First bounded string field from the payload (type-guarded, never trusts). */
function payloadText(request: AgentRequest, keys: string[]): string {
  for (const key of keys) {
    const value = request.payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return '';
}

/** Stable short hash used in tests/logs where the full fingerprint is unneeded. */
export function shortCorrelationFingerprint(correlationId: string): string {
  return createHash('sha256').update(correlationId, 'utf8').digest('hex').slice(0, 12);
}

/** A correlation id the processor generates when a caller omits one. */
export function newAgentCorrelationId(): string {
  return `agent-${randomUUID()}`;
}

// Authority re-export for route/docs consumers.
export type { WriteAuthority };
