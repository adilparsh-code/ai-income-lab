// Phase 4.5.2 — Ruflo Adapter boundary (PLANNED / NOT_CONNECTED).
//
// This is the SINGLE integration point a future external orchestrator (Ruflo)
// will use. It intentionally knows nothing about agents, prompts, or AI
// providers — it forwards validated requests to the Job Runner, which enforces
// the existing safety architecture (halal gates, human review, no arbitrary
// execution).
//
//   Ruflo Adapter  →  Job Runner  →  Agent Registry  →  Agent  →  AI Provider
//                                                     ↓
//                                                  AgentLog
//
// Status: the adapter is INACTIVE. Nothing imports it from a scheduler, no
// Ruflo package is installed, and no background execution exists. It must
// never be labelled LIVE until a real orchestrator drives it end-to-end.

import { runJob, type RunJobOptions } from './job-runner';
import { isJobType, type JobOutcome, type JobPayload, type JobType, type RufloIntegrationStatus } from './types';

export interface RufloDispatchRequest {
  /** Workflow or job type, e.g. 'OPPORTUNITY_PIPELINE' or 'RESEARCH'. */
  jobType: unknown;
  payload: unknown;
  /** Orchestrator-supplied correlation/idempotency id. */
  correlationId?: unknown;
}

export interface RufloDispatchResult {
  accepted: boolean;
  /** Why the dispatch was rejected, when it was. */
  reason?: string;
  outcome?: JobOutcome;
}

export interface RufloAdapterInfo {
  status: RufloIntegrationStatus;
  note: string;
}

/**
 * Validate + forward a dispatch request to the job runner. Invalid job types
 * and malformed payloads are rejected without creating any rows or touching
 * any agent — there is no arbitrary-code or arbitrary-agent execution path.
 */
export async function rufloDispatch(
  request: RufloDispatchRequest,
  options: RunJobOptions = {},
): Promise<RufloDispatchResult> {
  if (!isJobType(request.jobType)) {
    return {
      accepted: false,
      reason: `Unknown jobType. Must be one of the registered job types (got: ${typeof request.jobType}).`,
    };
  }
  const jobType: JobType = request.jobType;
  if (typeof request.payload !== 'object' || request.payload === null || Array.isArray(request.payload)) {
    return { accepted: false, reason: 'payload must be a JSON object.' };
  }
  if (
    request.correlationId !== undefined &&
    (typeof request.correlationId !== 'string' || request.correlationId.trim().length === 0 || request.correlationId.length > 200)
  ) {
    return { accepted: false, reason: 'correlationId must be a non-empty string of at most 200 characters.' };
  }

  const outcome = await runJob(jobType, request.payload as JobPayload, request.correlationId as string | undefined, options);
  return { accepted: true, outcome };
}

/** Boundary metadata for status surfaces. Never claims LIVE. */
export function describeRufloAdapter(): RufloAdapterInfo {
  return {
    status: 'NOT_CONNECTED',
    note:
      'Adapter boundary exists and is tested, but no orchestrator is connected. '
        + 'The application is fully functional without Ruflo; enabling it later requires no changes to agents.',
  };
}
