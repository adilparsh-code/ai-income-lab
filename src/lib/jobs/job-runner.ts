// Phase 4.5.2 — Job Runner.
//
// Executes jobs through the EXISTING AgentRegistry / pipeline orchestrator —
// it never re-implements agent or AI logic, and it never bypasses agent-level
// safety checks. The runner adds durable job state, idempotency, and a
// fail-safe retry policy on top.
//
// Safety contract (enforced HERE, before any agent/AI invocation):
// - Payload validation failure → FAILED (invalid input; never retried).
// - Unknown opportunity        → FAILED (missing opportunity; never retried).
// - Opportunity NOT_ALLOWED    → BLOCKED. No agent, no AI call, no network.
// - Opportunity REVIEW_REQUIRED→ HUMAN_REVIEW. No autonomous execution.
// - HALAL (or no opportunity)  → execute through the existing agents, whose
//   own deterministic halal screening still applies (defense in depth).
//
// Retry policy: only provider/network-shaped failures (the agent-level result
// reported fallbackUsed with a failure) are retryable, bounded by
// JOB_MAX_RETRIES. Validation failures, missing opportunities, halal blocks,
// and human-review pauses are NEVER retried. No infinite loops.
//
// DB access goes through the narrow, injectable JobDb surface so tests are
// hermetic (no DB, no network, no AI).

import { randomUUID } from 'node:crypto';
import { agentRegistry } from '@/lib/agents/agent-registry';
import { runPipeline } from '@/lib/ruflo/orchestrator';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { logger } from '@/lib/server-log';
import {
  executeFactoryJob,
  mapFactoryOutcomeToStatus,
  type FactoryJobOutcome,
  type FactoryJobOptions,
} from '@/lib/product-factory/factory-jobs';
import { validateJobPayload } from './job-definitions';
import { classifyFailure, planRecovery, type FailureClassification, type RecoveryPlan } from '@/lib/ops/failure-recovery';
import {
  JOB_TYPE_TO_AGENT,
  isFactoryJobType,
  isServiceJobType,
  type JobOutcome,
  type JobPayload,
  type JobStatus,
  type JobType,
  type JobExecutionMode,
} from './types';
import {
  isWorkAuthorized,
  canTransitionDeliverable,
  type DeliverableState,
} from '@/lib/commercial/engagement-states';
import { isDeliverableKind, evaluateMicroServiceQa, findMicroService } from '@/lib/commercial/micro-services';

const MAX_RETRIES = readPositiveInt('JOB_MAX_RETRIES', 2);

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(5, Math.floor(parsed));
}

// ---------------------------------------------------------------------------
// Injectable DB surface (structural; the real Prisma client satisfies it)
// ---------------------------------------------------------------------------

export interface JobOpportunityRow {
  id: string;
  title: string;
  problemSolved: string;
  category: string;
  businessModel: string;
  monetizationMethod: string;
  halalStatus: string;
}

export interface JobEngagementRow {
  id: string;
  state: string;
  paymentState: string;
  engagementType: string;
  exposureCapUsd: number;
  lowRiskExceptionApplied: boolean;
}

export interface JobDeliverableRow {
  id: string;
  state: string;
  kind: string;
  revisionCount: number;
  revisionLimit: number;
  isPreview: boolean;
}

export interface JobRunRow {
  id: string;
  jobType: string;
  status: string;
  correlationId: string;
  idempotencyKey: string;
  opportunityId: string | null;
  agentType: string | null;
  input: string;
  output: string | null;
  resultRef: string | null;
  error: string | null;
  retryCount: number;
  executionMode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface JobDb {
  opportunity: {
    findUnique(args: { where: { id: string } }): Promise<JobOpportunityRow | null>;
  };
  /**
   * Phase 11.3 — optional. Required only by service jobs, which consult the
   * engagement payment gate BEFORE executing anything. A client without these
   * methods makes service jobs fail closed rather than run unauthorized.
   */
  serviceEngagement?: {
    findUnique(args: { where: { id: string } }): Promise<JobEngagementRow | null>;
  };
  deliverable?: {
    findUnique(args: { where: { id: string } }): Promise<JobDeliverableRow | null>;
  };
  jobRun: {
    findUnique(args: { where: { idempotencyKey: string } }): Promise<JobRunRow | null>;
    findMany?(args: { where: { jobType: string; input: string; status: string } }): Promise<JobRunRow[]>;
    create(args: { data: NewJobRunData }): Promise<JobRunRow>;
    update(args: { where: { id: string }; data: Partial<NewJobRunData> }): Promise<JobRunRow>;
  };
  failureRecord?: {
    create(args: { data: NewFailureRecordData }): Promise<unknown>;
  };
}

export interface NewFailureRecordData {
  classification: string;
  retryCount: number;
  maxRetries: number;
  lastError: string;
  recoveryState: string;
  deadLettered: boolean;
  resumePoint: string | null;
  correlationId: string;
  relatedEntityType: string;
  relatedEntityId: string;
  opportunityId: string | null;
}

export interface NewJobRunData {
  jobType: string;
  status: string;
  correlationId: string;
  idempotencyKey: string;
  opportunityId: string | null;
  agentType: string | null;
  input: string;
  output: string | null;
  resultRef: string | null;
  error: string | null;
  retryCount: number;
  executionMode: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * The real Prisma client behind a lazy proxy (same pattern as src/lib/db.ts):
 * construction is deferred to first use, so tests and pure imports never touch
 * a database, and the module stays compatible with the CJS test transform.
 */
const defaultDb = new Proxy({} as JobDb, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('@/lib/db') as { db: unknown };
    const client = db as unknown as JobDb;
    const value = Reflect.get(client as object, prop);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

// ---------------------------------------------------------------------------
// Result extraction helpers (safe fields only)
// ---------------------------------------------------------------------------

function safeAgentResultSummary(result: {
  success: boolean;
  reasoning: string;
  evidenceType: string;
  capabilityStatus?: string;
  fallbackUsed?: boolean;
  executionTime: number;
  error?: string;
  output?: unknown;
}): Record<string, unknown> {
  const outputRecord =
    typeof result.output === 'object' && result.output !== null
      ? (result.output as Record<string, unknown>)
      : {};
  return {
    success: result.success,
    reasoning: String(result.reasoning ?? '').slice(0, 500),
    evidenceType: result.evidenceType,
    capabilityStatus: result.capabilityStatus ?? null,
    fallbackUsed: result.fallbackUsed ?? false,
    executionTime: Number.isFinite(result.executionTime) ? result.executionTime : 0,
    agentLogId: typeof outputRecord.agentLogId === 'string' ? outputRecord.agentLogId : null,
    halalStatus: typeof outputRecord.halalStatus === 'string' ? outputRecord.halalStatus : null,
    recommendation: typeof outputRecord.recommendation === 'string' ? String(outputRecord.recommendation).slice(0, 300) : null,
  };
}

/** Map an AgentResult + opportunity halal status onto an explicit job status. */
export function mapAgentOutcomeToStatus(
  result: { success: boolean; fallbackUsed?: boolean; capabilityStatus?: string },
  humanReviewRequired: boolean,
  opportunityBlocked: boolean,
): JobStatus {
  if (opportunityBlocked) return 'BLOCKED';
  if (humanReviewRequired) return 'HUMAN_REVIEW';
  if (result.success && !result.fallbackUsed) return 'SUCCEEDED';
  if (result.success && result.fallbackUsed) return 'DEGRADED';
  if (result.fallbackUsed) return 'DEGRADED';
  return 'FAILED';
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunJobOptions {
  /** Test seam: override the executor source (registry/pipeline). */
  db?: JobDb;
  /** Test seam: execute an agent job without touching AgentRegistry. */
  executeAgentJob?: (jobType: JobType, payload: JobPayload) => Promise<{
    success: boolean;
    reasoning: string;
    evidenceType: string;
    capabilityStatus?: string;
    fallbackUsed?: boolean;
    executionTime: number;
    error?: string;
    output?: unknown;
  }>;
  /** Test seam: execute the pipeline job without touching the orchestrator. */
  executePipelineJob?: (payload: JobPayload) => Promise<{
    status: string;
    runId?: string;
    steps: unknown[];
    aiTotals?: Record<string, unknown>;
  }>;
  /** Test seam: execute a factory job without touching provider boundaries. */
  executeFactoryJob?: (jobType: string, payload: JobPayload) => Promise<FactoryJobOutcome>;
  /**
   * Factory execution options (deployment/publishing providers, persistence
   * seam). Ignored for non-factory job types.
   */
  factory?: FactoryJobOptions;
  /** Durable attempt number for bounded recovery decisions. */
  retryCount?: number;
}

export async function runJob(
  jobType: JobType,
  payload: JobPayload,
  correlationId?: string,
  options: RunJobOptions = {},
): Promise<JobOutcome> {
  const db = options.db ?? defaultDb;
  const corr = correlationId?.trim() || `job-${randomUUID()}`;
  const idempotencyKey = `${jobType}:${corr}`;

  // 1. Payload validation — invalid input is rejected up front, never retried.
  const validation = validateJobPayload(jobType, payload);
  if (!validation.valid) {
    return finishWithoutRow(jobType, corr, idempotencyKey, 'FAILED',
      `Invalid job payload: ${validation.errors.join('; ')}`);
  }

  // 2. Idempotency — an existing row for the same logical job is returned as-is.
  let existing: JobRunRow | null = null;
  try {
    existing = await db.jobRun.findUnique({ where: { idempotencyKey } });
  } catch (error) {
    logger.warn('Job idempotency lookup failed; continuing without dedup', {
      error: String(error).slice(0, 150),
    });
  }
  if (existing && !isTerminal(existing.status)) {
    // Already queued/running: report it without re-executing.
    return toOutcome(existing, true);
  }
  if (existing && isTerminal(existing.status)) {
    // Completed work: return the recorded outcome (idempotent re-read).
    return toOutcome(existing, true);
  }

  // 3. Create the QUEUED row, then transition to RUNNING (durable state).
  let row: JobRunRow;
  try {
    row = await db.jobRun.create({
      data: {
        jobType,
        status: 'QUEUED',
        correlationId: corr,
        idempotencyKey,
        opportunityId: typeof payload.opportunityId === 'string' ? payload.opportunityId : null,
        agentType: jobType in JOB_TYPE_TO_AGENT ? JOB_TYPE_TO_AGENT[jobType as keyof typeof JOB_TYPE_TO_AGENT] : null,
        input: JSON.stringify(payload),
        output: null,
        resultRef: null,
        error: null,
        retryCount: Math.max(0, Math.min(MAX_RETRIES, options.retryCount ?? 0)),
        executionMode: null,
        startedAt: null,
        completedAt: null,
      },
    });
    row = await db.jobRun.update({ where: { id: row.id }, data: { status: 'RUNNING', startedAt: new Date() } });
  } catch (error) {
    logger.error('Job row creation failed; job not executed', error, { jobType });
    return finishWithoutRow(jobType, corr, idempotencyKey, 'FAILED',
      'Job could not be queued due to a storage error. It was NOT executed.');
  }

  // 4. Opportunity verification + HALAL GATES (before any agent/AI access).
  const opportunityId = typeof payload.opportunityId === 'string' ? payload.opportunityId : null;
  let opportunity: JobOpportunityRow | null = null;
  if (opportunityId) {
    try {
      opportunity = await db.opportunity.findUnique({ where: { id: opportunityId } });
    } catch (error) {
      logger.warn('Job opportunity lookup failed', { error: String(error).slice(0, 150) });
    }
    if (!opportunity) {
      return finishRow(db, row, 'FAILED', null,
        `Opportunity "${opportunityId}" was not found.`, null, row.retryCount);
    }
    if (opportunity.halalStatus === 'NOT_ALLOWED') {
      logger.info('Job blocked by halal gate (NOT_ALLOWED); no agent or AI call made', { jobType, opportunityId });
      return finishRow(db, row, 'BLOCKED', null,
        'Blocked: opportunity halalStatus is NOT_ALLOWED. No agent or AI provider was invoked.', null, row.retryCount);
    }
    if (opportunity.halalStatus === 'REVIEW_REQUIRED') {
      return finishRow(db, row, 'HUMAN_REVIEW', null,
        'Paused: opportunity halalStatus is REVIEW_REQUIRED. A qualified human must review before any execution.', null, row.retryCount);
    }
  }

  // 5. Execute through the EXISTING agents / pipeline / factory boundaries.
  try {
    if (jobType === 'OPPORTUNITY_PIPELINE') {
      return await executeWorkflowJob(db, row, payload, options);
    }
    if (isFactoryJobType(jobType)) {
      return await executeFactoryJobViaRunner(db, row, jobType, payload, opportunity, options);
    }
    if (isServiceJobType(jobType)) {
      return await executeServiceJobViaRunner(db, row, jobType, payload);
    }
    return await executeSingleAgentJob(db, row, jobType, payload, opportunity, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Job execution threw', error, { jobType, jobId: row.id });
    return finishRow(db, row, 'FAILED', null, `Job execution failed: ${message}`.slice(0, 500), null, row.retryCount);
  }
}

/**
 * Phase 5.3 — Factory job branch. Deterministic factory operations that run
 * through the SAME idempotency/halal gates as agent jobs. No AI is invoked;
 * high-impact actions (DEPLOY/PUBLISH) require the payload's human approval
 * token and are executed only through the provider boundaries, which refuse
 * when unconfigured.
 */
async function executeFactoryJobViaRunner(
  db: JobDb,
  row: JobRunRow,
  jobType: JobType,
  payload: JobPayload,
  opportunity: JobOpportunityRow | null,
  options: RunJobOptions,
): Promise<JobOutcome> {
  const outcome = await (options.executeFactoryJob
    ? options.executeFactoryJob(jobType, payload)
    : executeFactoryJob(jobType, payload, options.factory));

  const status = mapFactoryOutcomeToStatus(outcome, opportunity?.halalStatus === 'NOT_ALLOWED');
  const executionMode: JobExecutionMode = 'MOCKED'; // deterministic ops; no AI, no network claims
  return finishRow(db, row, status, {
    factoryJob: jobType,
    productId: typeof payload.productId === 'string' ? payload.productId : null,
    ...(outcome.summary ?? {}),
  }, outcome.error ?? null, null, row.retryCount, executionMode);
}

/**
 * Phase 11.3 — service job branch. Bounded, deterministic, and gated by the
 * engagement's REAL payment state before anything executes:
 *
 *   - SERVICE_BUILD / SERVICE_QA / SERVICE_DELIVERY require an engagement that
 *     is already authorized (WORK_AUTHORIZED … DELIVERY_AUTHORIZED) or an
 *     explicitly configured, audited low-risk exception. UNPAID → executing is
 *     refused here, not merely documented upstream.
 *   - The engagement lookup FAILS CLOSED: a client without the service tables
 *     refuses the job instead of skipping the gate.
 *   - No AI is invoked and no network call is made: these jobs move the
 *     governed state machines forward and record the real outcome.
 */
async function executeServiceJobViaRunner(
  db: JobDb,
  row: JobRunRow,
  jobType: JobType,
  payload: JobPayload,
): Promise<JobOutcome> {
  const engagementId = typeof payload.engagementId === 'string' ? payload.engagementId : null;
  if (!engagementId) {
    return finishRow(db, row, 'FAILED', null, 'engagementId is required for service jobs.', null, row.retryCount);
  }

  if (!db.serviceEngagement) {
    return finishRow(
      db, row, 'BLOCKED', null,
      'Service job refused: the payment gate could not be evaluated (fail-closed).', null, row.retryCount,
    );
  }

  let engagement: JobEngagementRow | null = null;
  try {
    engagement = await db.serviceEngagement.findUnique({ where: { id: engagementId } });
  } catch (error) {
    logger.warn('Service engagement lookup failed; refusing (fail-closed)', {
      error: String(error).slice(0, 150), jobId: row.id,
    });
  }
  if (!engagement) {
    return finishRow(db, row, 'FAILED', null, `Engagement "${engagementId}" was not found.`, null, row.retryCount);
  }

  // THE PAYMENT GATE. Unauthorized work is structurally impossible here.
  const authorized = isWorkAuthorized(engagement.state) || engagement.lowRiskExceptionApplied;
  if (!authorized) {
    logger.info('Service job blocked by payment gate; nothing executed', { jobType, engagementId, state: engagement.state });
    return finishRow(
      db, row, 'BLOCKED', null,
      `Blocked: engagement state ${engagement.state} is not authorized for work. `
      + 'WORK_AUTHORIZED requires PAYMENT_VERIFIED (a verified provider webhook, provider API, or approved admin manual verification).',
      null, row.retryCount,
    );
  }

  if (jobType === 'SERVICE_BUILD') {
    return finishRow(db, row, 'SUCCEEDED', {
      serviceJob: jobType,
      engagementId,
      engagementType: engagement.engagementType,
      microServiceKind: typeof payload.microServiceKind === 'string' ? payload.microServiceKind : null,
      bounded: true,
    }, null, null, row.retryCount, 'MOCKED');
  }

  // SERVICE_QA and SERVICE_DELIVERY are deliverable-scoped.
  const deliverableId = typeof payload.deliverableId === 'string' ? payload.deliverableId : null;
  if (!deliverableId) {
    return finishRow(db, row, 'FAILED', null, 'deliverableId is required for SERVICE_QA and SERVICE_DELIVERY.', null, row.retryCount);
  }
  if (!db.deliverable) {
    return finishRow(db, row, 'BLOCKED', null, 'Service job refused: deliverable state could not be read (fail-closed).', null, row.retryCount);
  }
  const deliverable = await db.deliverable.findUnique({ where: { id: deliverableId } }).catch(() => null);
  if (!deliverable) {
    return finishRow(db, row, 'FAILED', null, `Deliverable "${deliverableId}" was not found.`, null, row.retryCount);
  }

  if (jobType === 'SERVICE_QA') {
    // QA is DISTINCT from generation and FAILS CLOSED: a check that was not
    // reported as passed is treated as not passed.
    const definition = typeof payload.microServiceKind === 'string' ? findMicroService(payload.microServiceKind) : null;
    const reported = Array.isArray(payload.qaChecks)
      ? payload.qaChecks.filter((c): c is { check: string; passed: unknown; detail?: unknown } =>
        typeof c === 'object' && c !== null && typeof (c as { check?: unknown }).check === 'string')
      : [];
    const verdict: ReturnType<typeof evaluateMicroServiceQa> = definition
      ? evaluateMicroServiceQa(definition, reported)
      : {
        passed: false,
        failed: [{ check: 'known-catalog-definition', passed: false, detail: 'No catalogue definition available; QA fails closed.' }],
        reason: 'QA could not be evaluated from a bounded catalogue definition.',
      };

    if (!verdict.passed) {
      return finishRow(db, row, 'FAILED', {
        serviceJob: jobType,
        deliverableId,
        qaPassed: false,
        failedChecks: verdict.failed.slice(0, 5),
      }, verdict.reason, null, row.retryCount, 'MOCKED');
    }
    return finishRow(db, row, 'SUCCEEDED', {
      serviceJob: jobType,
      deliverableId,
      qaPassed: true,
      checks: verdict.checks.length,
    }, null, null, row.retryCount, 'MOCKED');
  }

  // SERVICE_DELIVERY — the state machine decides whether release is legal.
  if (!isDeliverableKind(deliverable.kind)) {
    return finishRow(db, row, 'FAILED', null, `Deliverable kind "${deliverable.kind}" is not a bounded deliverable kind.`, null, row.retryCount);
  }
  const verdict = canTransitionDeliverable({
    from: deliverable.state as DeliverableState,
    to: 'DELIVERED',
    actor: 'ADMIN',
    revisionCount: deliverable.revisionCount,
    revisionLimit: deliverable.revisionLimit,
    engagementState: engagement.state,
    isPreview: deliverable.isPreview,
  });
  if (!verdict.ok) {
    return finishRow(db, row, 'BLOCKED', null, `Delivery refused: ${verdict.reason}`, null, row.retryCount, 'MOCKED');
  }
  return finishRow(db, row, 'SUCCEEDED', {
    serviceJob: jobType,
    deliverableId,
    released: true,
  }, null, null, row.retryCount, 'MOCKED');
}

async function executeSingleAgentJob(
  db: JobDb,
  row: JobRunRow,
  jobType: JobType,
  payload: JobPayload,
  opportunity: JobOpportunityRow | null,
  options: RunJobOptions,
): Promise<JobOutcome> {
  const executor = options.executeAgentJob ?? defaultAgentExecutor;
  const result = await executor(jobType, payload);

  // Defense in depth: the runner screens free-text objectives too. A
  // NOT_ALLOWED screen verdict upgrades the outcome to BLOCKED even if the
  // agent's own gate somehow returned content (the agents already hard-block).
  let humanReview = false;
  let blocked = opportunity?.halalStatus === 'NOT_ALLOWED';
  if (!blocked) {
    const screen = screenForHalalCompliance(
      firstString(payload, ['researchObjective', 'validationObjective', 'productObjective', 'analyticsObjective', 'objective']) ?? '',
      firstString(payload, ['targetAudience', 'customerProblem']) ?? '',
      opportunity?.category ?? 'Digital Products',
      opportunity?.businessModel ?? 'Direct Sales',
      firstString(payload, ['monetizationPreference']) ?? opportunity?.monetizationMethod ?? 'ONE_TIME_PURCHASE',
    );
    if (screen.status === 'NOT_ALLOWED') blocked = true;
    else if (screen.status === 'REVIEW_REQUIRED') humanReview = true;
  }

  const status = mapAgentOutcomeToStatus(result, humanReview, blocked);
  const summary = safeAgentResultSummary(result);
  const executionMode: JobExecutionMode = result.capabilityStatus === 'LIVE' ? 'LIVE' : 'MOCKED';
  const resultRef = summary.agentLogId ? { agentLogId: summary.agentLogId } : null;

  return finishRow(db, row, status, summary, result.error ?? null, resultRef, row.retryCount, executionMode);
}

async function executeWorkflowJob(
  db: JobDb,
  row: JobRunRow,
  payload: JobPayload,
  options: RunJobOptions,
): Promise<JobOutcome> {
  const executor = options.executePipelineJob ?? defaultPipelineExecutor;
  const run = await executor(payload);

  const status: JobStatus =
    run.status === 'COMPLETED' ? 'SUCCEEDED'
      : run.status === 'BLOCKED' ? 'BLOCKED'
        : run.status === 'HUMAN_REVIEW' ? 'HUMAN_REVIEW'
          : run.status === 'PARTIAL' ? 'DEGRADED'
            : 'FAILED';

  const blockedRun = run.status === 'BLOCKED' && run.steps.length === 0;
  if (blockedRun) {
    logger.info('Pipeline job hard-blocked by halal gate; zero steps executed', { jobId: row.id });
  }

  const output = {
    status: run.status,
    runId: run.runId ?? null,
    stepsExecuted: run.steps.length,
    blockedWithZeroSteps: blockedRun,
  };
  const resultRef = run.runId ? { pipelineRunId: run.runId } : null;

  return finishRow(db, row, status, output, null, resultRef, row.retryCount);
}

// ---------------------------------------------------------------------------
// Retry (safe, bounded, explicit)
// ---------------------------------------------------------------------------

/** Only provider/network-shaped degraded failures are retryable. */
export function isRetryableFailure(status: JobStatus): boolean {
  return status === 'DEGRADED';
}

/**
 * Retry a failed job with a NEW correlation id (so the retry gets a fresh,
 * idempotent attempt instead of colliding with the previous row).
 * BLOCKED / HUMAN_REVIEW / FAILED(validation|missing opportunity) are never
 * retried. Bounded by JOB_MAX_RETRIES.
 */
export async function retryJob(
  jobType: JobType,
  payload: JobPayload,
  options: RunJobOptions = {},
): Promise<JobOutcome> {
  const db = options.db ?? defaultDb;
  const retryIndex = await nextRetryIndex(db, jobType, payload);
  if (retryIndex > MAX_RETRIES) {
    return {
      jobId: 'n/a',
      jobType,
      status: 'FAILED',
      deduplicated: false,
      result: null,
      error: `Retry limit (${MAX_RETRIES}) reached for this job payload.`,
      executionMode: null,
      retryCount: retryIndex - 1,
    };
  }
  return runJob(jobType, payload, `retry-${retryIndex}-${randomUUID()}`, { ...options, retryCount: retryIndex - 1 });
}

async function nextRetryIndex(db: JobDb, jobType: JobType, payload: JobPayload): Promise<number> {
  if (!db.jobRun.findMany) return 1;
  try {
    const priorAttempts = await db.jobRun.findMany({
      where: { jobType, input: JSON.stringify(payload), status: 'DEGRADED' },
    });
    return priorAttempts.length + 1;
  } catch (error) {
    logger.warn('Retry history lookup failed; refusing autonomous retry', {
      error: String(error).slice(0, 150),
      jobType,
    });
    return MAX_RETRIES + 1;
  }
}

// ---------------------------------------------------------------------------
// Finalization helpers
// ---------------------------------------------------------------------------

function failureFor(status: string, error: string | null, retryCount: number): {
  classification: FailureClassification;
  plan: RecoveryPlan;
} | null {
  if (status === 'SUCCEEDED') return null;
  const classification = status === 'DEGRADED'
    ? classifyFailure({ error: 'Provider unavailable; degraded execution.', status: 'PROVIDER_UNAVAILABLE' })
    : classifyFailure({ error, status });
  return {
    classification,
    plan: planRecovery({
      classification: classification.classification,
      retryCount,
      maxRetries: MAX_RETRIES,
      resumePoint: 'CURRENT_STAGE',
    }),
  };
}

function isTerminal(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'BLOCKED', 'HUMAN_REVIEW', 'DEGRADED'].includes(status);
}

function toOutcome(row: JobRunRow, deduplicated: boolean): JobOutcome {
  return {
    jobId: row.id,
    jobType: row.jobType as JobType,
    status: row.status as JobStatus,
    deduplicated,
    result: safeParse(row.output),
    error: row.error,
    executionMode: (row.executionMode as JobExecutionMode | null) ?? null,
    retryCount: row.retryCount,
  };
}

function safeParse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function finishWithoutRow(
  jobType: JobType,
  correlationId: string,
  idempotencyKey: string,
  status: JobStatus,
  error: string,
): JobOutcome {
  return {
    jobId: 'n/a',
    jobType,
    status,
    deduplicated: false,
    result: null,
    error,
    executionMode: null,
    retryCount: 0,
  };
}

async function finishRow(
  db: JobDb,
  row: JobRunRow,
  status: JobStatus,
  output: Record<string, unknown> | null,
  error: string | null,
  resultRef: Record<string, unknown> | null,
  retryCount: number,
  executionMode: JobExecutionMode | null = null,
): Promise<JobOutcome> {
  const recovery = failureFor(status, error, retryCount);
  try {
    await db.jobRun.update({
      where: { id: row.id },
      data: {
        status,
        output: output ? JSON.stringify(output) : null,
        error,
        resultRef: resultRef ? JSON.stringify(resultRef) : null,
        retryCount,
        executionMode,
        completedAt: new Date(),
      },
    });
    if (recovery && db.failureRecord) {
      const deadLettered = recovery.plan.action === 'DEAD_LETTER';
      const recoveryState = recovery.plan.action === 'RETRY'
        ? 'RETRYING'
        : recovery.plan.action === 'HUMAN_REVIEW'
          ? 'HUMAN_REVIEW'
          : deadLettered
            ? 'DEAD_LETTER'
            : 'RESOLVED';
      await db.failureRecord.create({
        data: {
          classification: recovery.classification.classification,
          retryCount: recovery.plan.nextRetryCount,
          maxRetries: MAX_RETRIES,
          lastError: recovery.classification.reason.slice(0, 400),
          recoveryState,
          deadLettered,
          resumePoint: recovery.plan.resumePoint,
          correlationId: row.correlationId,
          relatedEntityType: 'JOB_RUN',
          relatedEntityId: row.id,
          opportunityId: row.opportunityId,
        },
      });
    }
  } catch (updateError) {
    logger.warn('Job row finalization failed; execution outcome is still returned', {
      error: String(updateError).slice(0, 150),
    });
  }
  return {
    jobId: row.id,
    jobType: row.jobType as JobType,
    status,
    deduplicated: false,
    result: output,
    error,
    executionMode,
    retryCount,
  };
}

// ---------------------------------------------------------------------------
// Default executors (AgentRegistry / pipeline orchestrator)
// ---------------------------------------------------------------------------

async function defaultAgentExecutor(
  jobType: JobType,
  payload: JobPayload,
): Promise<{
  success: boolean;
  reasoning: string;
  evidenceType: string;
  capabilityStatus?: string;
  fallbackUsed?: boolean;
  executionTime: number;
  error?: string;
  output?: unknown;
}> {
  const agentType = JOB_TYPE_TO_AGENT[jobType as keyof typeof JOB_TYPE_TO_AGENT];
  const result = await agentRegistry.executeAgent({
    agentType,
    action: `job:${jobType.toLowerCase()}`,
    input: payload,
    ...(typeof payload.opportunityId === 'string' ? { opportunityId: payload.opportunityId } : {}),
  });
  return {
    success: result.success,
    reasoning: result.reasoning,
    evidenceType: String(result.evidenceType),
    capabilityStatus: result.capabilityStatus,
    fallbackUsed: result.fallbackUsed,
    executionTime: result.executionTime,
    error: result.error,
    output: result.output,
  };
}

async function defaultPipelineExecutor(payload: JobPayload): Promise<{
  status: string;
  runId?: string;
  steps: unknown[];
  aiTotals?: Record<string, unknown>;
}> {
  const run = await runPipeline({
    objective: String(payload.objective ?? ''),
    opportunityId: typeof payload.opportunityId === 'string' ? payload.opportunityId : undefined,
    ...(Array.isArray(payload.stages) ? { stages: payload.stages as ('RESEARCH' | 'VALIDATION' | 'PRODUCT' | 'EXPERIMENT' | 'TRACKING')[] } : {}),
  });
  return {
    status: run.status,
    runId: run.runId,
    steps: run.steps,
    aiTotals: (run.findings as { aiTotals?: Record<string, unknown> } | undefined)?.aiTotals,
  };
}

function firstString(payload: JobPayload, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}
