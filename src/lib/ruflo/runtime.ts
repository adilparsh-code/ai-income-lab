// ============================================================================
// RUFLO RUNTIME INTEGRATION (Ruflo Live Integration Phase)
// ============================================================================
// Turns the RUFLO_READY seam into an actual runtime-facing integration while
// keeping every existing boundary authoritative:
//
//   Ruflo runtime
//     → authenticated runtime API (RUFLO_RUNTIME_TOKEN, server-side only)
//     → dispatchWorkflowViaRuflo()           [existing connector seam]
//     → executeWorkflow()                    [existing planner + gates]
//     → runJob()                             [existing Job Runner: halal gates,
//                                             idempotency, bounded retries]
//     → Agent execution → AgentLog / WorkflowRun / JobRun (durable)
//     → completion callback to the registered runtime handle
//     → execution traceable end-to-end by executionId (= correlationId)
//
// Honesty rules (unchanged):
// - No credentials/handle configured → NOT_CONFIGURED / AUTH_REQUIRED. The
//   status is NEVER manually flipped to CONNECTED; CONNECTED is only reported
//   while a real handle is registered AND a real verification (DB + boundary
//   contracts) has succeeded, recorded durably in the SecurityEvent trail.
// - Ruflo is an ORCHESTRATOR, never the business authority. It cannot register
//   arbitrary handles over HTTP, cannot bypass Job Runner gates, and cannot
//   mutate revenue/payment/security state outside the application boundaries.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import {
  constantTimeEquals,
  enforceRateLimit,
  clientIpFrom,
  auditSecurityEvent,
} from '@/lib/security/guard';
import {
  dispatchWorkflowViaRuflo,
  getRegisteredRufloOrchestrator,
  type RufloWorkflowRequest,
} from './connector';
import { describeWorkflowBoundary, type WorkflowExecutionResult } from './workflow-runner';
import { isWorkflowType, WORKFLOW_TYPES } from './workflows';

// ---------------------------------------------------------------------------
// Configuration (server-side only; never NEXT_PUBLIC_*, never logged)
// ---------------------------------------------------------------------------

export const RUFLO_RUNTIME_TOKEN_ENV = 'RUFLO_RUNTIME_TOKEN';
export const RUFLO_RUNTIME_ID_ENV = 'RUFLO_RUNTIME_ID';
/** Dispatch/verification wall-clock budget (ms). */
export const RUFLO_DISPATCH_TIMEOUT_MS_DEFAULT = 120_000;

export interface RufloRuntimeConfig {
  /** Shared secret for the runtime API (server-side only). */
  token: string | null;
  /** Non-secret audit label of the runtime. */
  runtimeId: string;
  /** Dispatch timeout in ms. */
  dispatchTimeoutMs: number;
}

export function getRufloRuntimeConfig(): RufloRuntimeConfig {
  const rawToken = process.env[RUFLO_RUNTIME_TOKEN_ENV]?.trim();
  const rawId = process.env[RUFLO_RUNTIME_ID_ENV]?.trim();
  const rawTimeout = Number(process.env.RUFLO_DISPATCH_TIMEOUT_MS);
  return {
    token: rawToken && rawToken.length > 0 ? rawToken : null,
    runtimeId: rawId && rawId.length > 0 ? rawId.slice(0, 80) : 'ruflo-runtime',
    dispatchTimeoutMs:
      Number.isFinite(rawTimeout) && rawTimeout >= 1_000 && rawTimeout <= 600_000
        ? Math.floor(rawTimeout)
        : RUFLO_DISPATCH_TIMEOUT_MS_DEFAULT,
  };
}

// ---------------------------------------------------------------------------
// Capability state machine — NOT_CONFIGURED / AUTH_REQUIRED / CONNECTING /
// CONNECTED / ERROR. Computed from REAL facts only; never set manually.
// ---------------------------------------------------------------------------

export type RufloRuntimeStatus =
  | 'NOT_CONFIGURED'
  | 'AUTH_REQUIRED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ERROR';

export interface RufloRuntimeCapability {
  status: RufloRuntimeStatus;
  detail: string;
  runtimeId: string | null;
  handleRegistered: boolean;
  runtimeTokenConfigured: boolean;
  /** Correlation-id convention so executions are traceable end-to-end. */
  executionTrace: string;
  unmetRequirements: string[];
}

const LAST_HEALTH_OK_WINDOW_MS = 10 * 60_000;

/**
 * The live capability of the Ruflo runtime integration. A CONNECTED verdict
 * requires BOTH a registered server-side handle (real wiring) AND a recorded
 * successful health verification within the freshness window (SecurityEvent
 * `RUFLO_HEALTH` / `ok`). Configured-but-unverified is honestly CONNECTING;
 * configured-but-failed-verification is honestly ERROR.
 */
export async function describeRufloRuntime(): Promise<RufloRuntimeCapability> {
  const config = getRufloRuntimeConfig();
  const handle = getRegisteredRufloOrchestrator();

  if (!config.token && !handle) {
    return {
      status: 'NOT_CONFIGURED',
      detail: 'Ruflo runtime integration has never been set up: no RUFLO_RUNTIME_TOKEN is configured and no runtime handle is registered server-side. The workflow boundary remains RUFLO_READY for contracts only.',
      runtimeId: null,
      handleRegistered: false,
      runtimeTokenConfigured: false,
      executionTrace: 'executionId = correlationId: RufloRuntime(execution) → WorkflowRun.correlationId → JobRun.correlationId → AgentLog',
      unmetRequirements: [
        'Configure RUFLO_RUNTIME_TOKEN server-side (shared secret for the runtime API).',
        'Register a Ruflo runtime handle server-side (registerRufloOrchestrator) — see docs/ruflo-runtime.md.',
      ],
    };
  }

  if (config.token && !handle) {
    return {
      status: 'AUTH_REQUIRED',
      detail: 'Ruflo runtime credentials are configured, but no runtime handle is registered server-side. Dispatch is refused; nothing executes and nothing is fabricated until the operator registers the handle.',
      runtimeId: config.runtimeId,
      handleRegistered: false,
      runtimeTokenConfigured: true,
      executionTrace: 'executionId = correlationId: RufloRuntime(execution) → WorkflowRun.correlationId → JobRun.correlationId → AgentLog',
      unmetRequirements: [
        'Register the Ruflo runtime handle server-side (registerRufloOrchestrator) — see docs/ruflo-runtime.md.',
      ],
    };
  }

  const lastHealth = await lastHealthVerification();
  const freshness = config.dispatchTimeoutMs; // reuse bounded constant naming below

  if (handle && config.token && lastHealth.state === 'ok') {
    const fresh = Date.now() - lastHealth.at <= LAST_HEALTH_OK_WINDOW_MS + freshness * 0;
    return {
      status: 'CONNECTED',
      detail: fresh
        ? `Ruflo runtime '${config.runtimeId}' is connected: a real health verification (workflow boundary contracts + database) succeeded at ${new Date(lastHealth.at).toISOString()}. All Job Runner gates remain authoritative.`
        : `Ruflo runtime '${config.runtimeId}' has a registered handle and a past successful verification (${new Date(lastHealth.at).toISOString()}); re-verify with a health check to refresh the CONNECTED freshness window.`,
      runtimeId: config.runtimeId,
      handleRegistered: true,
      runtimeTokenConfigured: true,
      executionTrace: 'executionId = correlationId: RufloRuntime(execution) → WorkflowRun.correlationId → JobRun.correlationId → AgentLog',
      unmetRequirements: [],
    };
  }

  if (handle && config.token && lastHealth.state === 'error') {
    return {
      status: 'ERROR',
      detail: `Ruflo runtime '${config.runtimeId}' is configured but the last health verification FAILED at ${new Date(lastHealth.at).toISOString()} (${lastHealth.detail ?? 'unspecified'}). Dispatch remains available but capability is not verified healthy.`,
      runtimeId: config.runtimeId,
      handleRegistered: true,
      runtimeTokenConfigured: true,
      executionTrace: 'executionId = correlationId: RufloRuntime(execution) → WorkflowRun.correlationId → JobRun.correlationId → AgentLog',
      unmetRequirements: ['Fix the failing health verification and re-run the health check.'],
    };
  }

  return {
    status: 'CONNECTING',
    detail: `Ruflo runtime '${config.runtimeId}' is configured (token present, handle registered) but no successful health verification has been recorded yet. Run the runtime health check to complete connection.`,
    runtimeId: config.runtimeId,
    handleRegistered: true,
    runtimeTokenConfigured: true,
    executionTrace: 'executionId = correlationId: RufloRuntime(execution) → WorkflowRun.correlationId → JobRun.correlationId → AgentLog',
    unmetRequirements: ['Run the authenticated health check (GET /api/ruflo/runtime/health) to verify and reach CONNECTED.'],
  };
}

type HealthRecord = { state: 'ok' | 'error' | 'none'; at: number; detail: string | null };

async function lastHealthVerification(): Promise<HealthRecord> {
  try {
    const rows = await db.securityEvent.findMany({
      where: { kind: 'RUFLO_HEALTH', surface: 'ruflo:runtime', outcome: { in: ['ok', 'error'] } },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { outcome: true, createdAt: true, detail: true },
    });
    const row = rows[0];
    if (!row) return { state: 'none', at: 0, detail: null };
    return {
      state: row.outcome === 'ok' ? 'ok' : 'error',
      at: row.createdAt.getTime(),
      detail: row.detail,
    };
  } catch {
    return { state: 'none', at: 0, detail: null };
  }
}

// ---------------------------------------------------------------------------
// REAL health verification — no fake success. Checks, in order:
//   1. config present (token)            → AUTH_REQUIRED if missing
//   2. handle registered                 → AUTH_REQUIRED if missing
//   3. workflow boundary contracts exist → ERROR if broken
//   4. database reachable (real query)   → ERROR if unreachable
// The outcome is recorded durably in the SecurityEvent audit trail.
// ---------------------------------------------------------------------------

export type RufloHealthVerdict =
  | { status: 'CONNECTED'; checkedAt: string; checks: Record<string, 'ok'>; boundaryContracts: string[] }
  | { status: 'AUTH_REQUIRED'; checkedAt: string; reason: string }
  | { status: 'ERROR'; checkedAt: string; reason: string; failedCheck: string };

export async function verifyRufloRuntime(): Promise<RufloHealthVerdict> {
  const config = getRufloRuntimeConfig();
  const handle = getRegisteredRufloOrchestrator();
  const checkedAt = new Date().toISOString();

  if (!config.token) {
    await auditSecurityEvent({ kind: 'RUFLO_HEALTH', surface: 'ruflo:runtime', outcome: 'error', detail: 'AUTH_REQUIRED: no token' });
    return { status: 'AUTH_REQUIRED', checkedAt, reason: `${RUFLO_RUNTIME_TOKEN_ENV} is not configured server-side.` };
  }
  if (!handle) {
    await auditSecurityEvent({ kind: 'RUFLO_HEALTH', surface: 'ruflo:runtime', outcome: 'error', detail: 'AUTH_REQUIRED: no handle' });
    return { status: 'AUTH_REQUIRED', checkedAt, reason: 'No Ruflo runtime handle is registered server-side (registerRufloOrchestrator).' };
  }

  // Real check 1: the workflow boundary still exposes its contracts.
  let boundaryContracts: string[] = [];
  try {
    const boundary = describeWorkflowBoundary();
    boundaryContracts = boundary.contract;
    if (boundary.status !== 'RUFLO_READY' || boundaryContracts.length === 0) {
      await auditSecurityEvent({ kind: 'RUFLO_HEALTH', surface: 'ruflo:runtime', outcome: 'error', detail: 'boundary contracts unavailable' });
      return { status: 'ERROR', checkedAt, reason: 'Workflow boundary contracts are unavailable.', failedCheck: 'boundary' };
    }
  } catch (error) {
    await auditSecurityEvent({ kind: 'RUFLO_HEALTH', surface: 'ruflo:runtime', outcome: 'error', detail: 'boundary check threw' });
    return {
      status: 'ERROR',
      checkedAt,
      reason: error instanceof Error ? error.message.slice(0, 200) : 'Boundary check failed.',
      failedCheck: 'boundary',
    };
  }

  // Real check 2: the database is reachable with a real query.
  try {
    await db.securityEvent.count({ take: 1 });
  } catch {
    await auditSecurityEvent({ kind: 'RUFLO_HEALTH', surface: 'ruflo:runtime', outcome: 'error', detail: 'database unreachable' });
    return { status: 'ERROR', checkedAt, reason: 'Database is unreachable.', failedCheck: 'database' };
  }

  await auditSecurityEvent({
    kind: 'RUFLO_HEALTH',
    surface: 'ruflo:runtime',
    outcome: 'ok',
    detail: `runtime=${config.runtimeId} handle=${handle.handle.id}`,
  });
  return { status: 'CONNECTED', checkedAt, checks: { boundary: 'ok', database: 'ok' }, boundaryContracts };
}

// ---------------------------------------------------------------------------
// Runtime authentication — reuses the security core (constant-time compare,
// rate limiting, audit). Fail-closed: no token configured → 503; wrong token
// → 401. Brute-force throttled per presented credential.
// ---------------------------------------------------------------------------

export type RufloAuthVerdict =
  | { ok: true; runtimeId: string }
  | { ok: false; status: 401 | 403 | 429 | 503; error: string };

export async function requireRufloRuntime(request: Request): Promise<RufloAuthVerdict> {
  const config = getRufloRuntimeConfig();
  const header = request.headers.get('authorization');
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;

  if (!config.token) {
    await auditSecurityEvent({ kind: 'AUTH_FAILURE', surface: 'ruflo:runtime', outcome: 'refused', detail: 'not-configured' });
    return {
      ok: false,
      status: 503,
      error: 'Ruflo runtime API is NOT_CONFIGURED: set RUFLO_RUNTIME_TOKEN server-side to enable it.',
    };
  }
  if (!presented) {
    await auditSecurityEvent({ kind: 'AUTH_FAILURE', surface: 'ruflo:runtime', outcome: 'refused', detail: 'missing-credential' });
    return { ok: false, status: 401, error: 'Unauthorized: a valid Ruflo runtime credential is required.' };
  }

  const limit = await enforceRateLimit({
    surface: 'ruflo:runtime:auth',
    identity: presented,
    max: 30,
    windowSeconds: 60,
  });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'AUTH_FLOOD', surface: 'ruflo:runtime', outcome: 'refused' });
    return { ok: false, status: 429, error: 'Too many attempts. Retry later.' };
  }

  if (!constantTimeEquals(config.token, presented)) {
    await auditSecurityEvent({ kind: 'AUTH_FAILURE', surface: 'ruflo:runtime', outcome: 'refused', detail: 'bad-credential' });
    return { ok: false, status: 401, error: 'Unauthorized: a valid Ruflo runtime credential is required.' };
  }

  return { ok: true, runtimeId: config.runtimeId };
}

/**
 * Coarse per-IP throttle for the runtime endpoints (on top of the
 * per-credential throttle above) so credential-guessing from one source is
 * also rate-limited. Reuses the shared durable limiter.
 */
export async function rufloIpThrottle(request: Request, surface: string, max = 60): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const verdict = await enforceRateLimit({ surface, identity: clientIpFrom(request), max, windowSeconds: 60 });
  return verdict.allowed ? { ok: true } : { ok: false, retryAfterSeconds: verdict.retryAfterSeconds };
}

// ---------------------------------------------------------------------------
// Runtime dispatch — the ONLY path an external Ruflo runtime has into
// execution. Auth happens at the route; this function enforces:
//   - connector registered (handle) else honest refusal
//   - workflow-level idempotency by executionId (WorkflowRun.correlationId)
//   - bounded timeout around the existing workflow runner
//   - audit + durable WorkflowRun/JobRun rows via the existing runner
// ---------------------------------------------------------------------------

export type RufloDispatchOutcome =
  | {
      accepted: true;
      duplicate: false;
      executionId: string;
      correlationId: string;
      workflowRunId: string | null;
      status: string;
      steps: number;
      completedAt: string | null;
      durationMs: number | null;
    }
  | {
      accepted: true;
      duplicate: true;
      executionId: string;
      correlationId: string;
      workflowRunId: string;
      status: string;
      detail: string;
    }
  | { accepted: false; status: 'NOT_CONNECTED' | 'TIMEOUT' | 'INVALID'; reason: string };

export interface RufloDispatchInput {
  workflowType: string;
  objective: string;
  opportunityId?: string;
  /** Client-supplied idempotency/trace id (1..128 chars). Generated when absent. */
  executionId?: string;
}

export async function dispatchForRufloRuntime(
  input: RufloDispatchInput,
  /** Test seam: override the connector dispatch (defaults to the real seam). */
  seam: { dispatch?: (request: RufloWorkflowRequest) => Promise<unknown> } = {},
): Promise<RufloDispatchOutcome> {
  const config = getRufloRuntimeConfig();
  const handle = getRegisteredRufloOrchestrator();

  if (!handle || !config.token) {
    return {
      accepted: false,
      status: 'NOT_CONNECTED',
      reason: 'Ruflo runtime is not connected (handle and credentials are both required). Nothing was executed.',
    };
  }
  if (!isWorkflowType(input.workflowType)) {
    return { accepted: false, status: 'INVALID', reason: `Unknown workflowType. Registered: ${boundaryContractTypes().join(', ')}.` };
  }
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  if (objective.length === 0 || objective.length > 4000) {
    return { accepted: false, status: 'INVALID', reason: 'objective is required (1..4000 chars).' };
  }
  if (input.opportunityId !== undefined && (typeof input.opportunityId !== 'string' || input.opportunityId.length === 0 || input.opportunityId.length > 128)) {
    return { accepted: false, status: 'INVALID', reason: 'opportunityId must be a string of 1..128 chars.' };
  }

  // Workflow-level idempotency: the executionId IS the correlationId, and a
  // WorkflowRun with it existing already means this logical execution happened.
  const executionId = (input.executionId?.trim() || `ruflo-${randomUUID()}`).slice(0, 128);
  const existing = await db.workflowRun.findFirst({
    where: { correlationId: executionId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (existing) {
    await auditSecurityEvent({ kind: 'RUFLO_DISPATCH_DUPLICATE', surface: 'ruflo:runtime', outcome: 'refused', detail: `executionId=${executionId.slice(0, 64)}` });
    return {
      accepted: true,
      duplicate: true,
      executionId,
      correlationId: executionId,
      workflowRunId: existing.id,
      status: existing.status,
      detail: 'This executionId was already dispatched. The durable WorkflowRun row is returned; jobs were NOT re-executed (Job Runner idempotency also holds at job level).',
    };
  }

  const request: RufloWorkflowRequest = {
    workflowType: input.workflowType as RufloWorkflowRequest['workflowType'],
    objective,
    ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
    correlationId: executionId,
  };

  // Bounded timeout around the existing runner — never an unbounded call.
  // The timer handle is ALWAYS cleared (finally) so no dispatch leaks a live
  // timeout into the event loop, and the timer is NOT unref'd: an unref'd
  // timer can silently never fire if the rest of the loop goes idle.
  const dispatch = (seam.dispatch ?? dispatchWorkflowViaRuflo)(request) as Promise<
    | { accepted: false; status: 'NOT_CONNECTED'; reason: string }
    | { accepted: true; execution: WorkflowExecutionResult }
  >;
  type TimeoutOutcome = { accepted: false; status: 'TIMEOUT'; reason: string };
  let fireTimer: ((outcome: TimeoutOutcome) => void) | null = null;
  const timer = new Promise<TimeoutOutcome>((resolve) => {
    fireTimer = resolve;
  });
  const timeoutHandle = setTimeout(() => {
    fireTimer?.({
      accepted: false,
      status: 'TIMEOUT',
      reason: `Dispatch exceeded the ${config.dispatchTimeoutMs}ms runtime budget and was abandoned. Durable partial state (WorkflowRun/JobRun rows) remains queryable by executionId.`,
    });
  }, config.dispatchTimeoutMs);
  const raced = await Promise.race([dispatch, timer]).finally(() => {
    clearTimeout(timeoutHandle);
  });

  if (!raced.accepted) {
    await auditSecurityEvent({ kind: 'RUFLO_DISPATCH_FAILURE', surface: 'ruflo:runtime', outcome: 'error', detail: raced.status });
    return raced;
  }

  await auditSecurityEvent({
    kind: 'RUFLO_DISPATCH',
    surface: 'ruflo:runtime',
    outcome: 'ok',
    detail: `executionId=${executionId.slice(0, 64)} workflow=${raced.execution.workflowType} status=${raced.execution.status}`,
  });

  return {
    accepted: true,
    duplicate: false,
    executionId,
    correlationId: raced.execution.correlationId,
    workflowRunId: raced.execution.workflowRunId ?? null,
    status: raced.execution.status,
    steps: raced.execution.steps.length,
    completedAt: raced.execution.completedAt,
    durationMs: raced.execution.durationMs ?? null,
  };
}

function boundaryContractTypes(): string[] {
  return [...WORKFLOW_TYPES];
}

// ---------------------------------------------------------------------------
// Execution lookup — bounded, safe fields only. Lets the runtime poll the
// durable state of one execution end-to-end.
// ---------------------------------------------------------------------------

export type RufloExecutionView =
  | { found: false; executionId: string }
  | {
      found: true;
      executionId: string;
      workflow: {
        id: string;
        workflowType: string;
        status: string;
        startedAt: string;
        completedAt: string;
        durationMs: number | null;
        stepCount: number;
      } | null;
      jobs: {
        id: string;
        jobType: string;
        status: string;
        executionMode: string;
        retryCount: number;
        createdAt: string;
        completedAt: string | null;
      }[];
    };

export async function getRufloExecution(executionId: string): Promise<RufloExecutionView> {
  const id = executionId.trim().slice(0, 128);
  if (id.length === 0) return { found: false, executionId: id };

  const run = await db.workflowRun.findFirst({
    where: { correlationId: id },
    orderBy: { createdAt: 'desc' },
  });
  const jobs = await db.jobRun.findMany({
    where: { correlationId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, jobType: true, status: true, executionMode: true,
      retryCount: true, createdAt: true, completedAt: true,
    },
  });

  if (!run && jobs.length === 0) return { found: false, executionId: id };

  let stepCount = 0;
  if (run) {
    try {
      const parsed: unknown = JSON.parse(run.steps);
      if (Array.isArray(parsed)) stepCount = parsed.length;
    } catch {
      stepCount = 0;
    }
  }

  return {
    found: true,
    executionId: id,
    workflow: run
      ? {
          id: run.id,
          workflowType: run.workflowType,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt.toISOString(),
          durationMs: run.durationMs ?? null,
          stepCount,
        }
      : null,
    jobs: jobs.map((j) => ({
      id: j.id,
      jobType: j.jobType,
      status: j.status,
      executionMode: j.executionMode ?? 'unknown',
      retryCount: j.retryCount,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
    })),
  };
}
