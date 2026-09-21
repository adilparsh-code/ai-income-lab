// Phase 5.2 — Ruflo workflow runner (the execution half of workflows.ts).
//
// Executes ONLY what the pure planner approved, strictly through the EXISTING
// boundaries:
//
//   Workflow Runner → runJob() (existing) → AgentRegistry → Agents → AI/Research
//                          ↓
//                     JobRun (existing persistence, idempotency, halal gates)
//
// The runner does NOT re-implement agents, halal gates, retries, or
// idempotency — runJob already owns all of them (a NOT_ALLOWED opportunity is
// BLOCKED there before any agent/AI call; REVIEW_REQUIRED stops with no
// autonomous execution; retries are bounded and only for provider-shaped
// DEGRADED failures). The runner adds: workflow-level planning, per-step job
// payload construction, fail-closed step chaining, and a durable workflow
// summary on the WorkflowRun record.
//
// Ruflo integration boundary: external orchestrators call executeWorkflow()
// (mirrored by the Ruflo adapter). No Ruflo package is installed — the
// boundary stays RUFLO_READY / NOT_CONNECTED.

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { runJob, type RunJobOptions } from '@/lib/jobs/job-runner';
import type { JobOutcome, JobPayload, JobType } from '@/lib/jobs/types';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { logger } from '@/lib/server-log';
import { planWorkflow, type WorkflowState, type WorkflowType, type WorkflowPlan, type PlannedStep } from './workflows';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowStepResult {
  key: string;
  jobType: string;
  decision: string;
  /** Status returned by runJob for executed steps; decision for skipped ones. */
  status: string;
  jobId: string | null;
  correlationId: string;
  deduplicated: boolean;
  reason: string;
  /** Compact, safe step output summary (no payloads, no secrets). */
  summary: Record<string, unknown> | null;
}

export interface WorkflowExecutionResult {
  workflowId: string;
  workflowType: WorkflowType;
  status: 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'HUMAN_REVIEW' | 'FAILED' | 'DEGRADED';
  correlationId: string;
  opportunityId: string | null;
  plan: {
    gate: string;
    gateReason: string;
    terminated: boolean;
    rationale: string;
    steps: { key: string; jobType: string; decision: string; reason: string }[];
  };
  steps: WorkflowStepResult[];
  /** WorkflowRun record id when persistence succeeded. */
  workflowRunId: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface ExecuteWorkflowOptions extends RunJobOptions {
  /** Test seam: override planning inputs (state comes from the DB otherwise). */
  stateOverrides?: Partial<WorkflowState>;
  /** Test seam: supply the workflow state directly (skips DB gathering). */
  providedState?: WorkflowState;
  /** Test seam: override step dispatch (defaults to runJob for EXECUTE steps). */
  dispatch?: (jobType: string, payload: Record<string, unknown>, correlationId: string) => Promise<{
    status: string;
    jobId: string | null;
    deduplicated: boolean;
    result: Record<string, unknown> | null;
  }>;
  /** Test/dry-run seam: skip WorkflowRun persistence (no durable row). */
  skipPersistence?: boolean;
}

// ---------------------------------------------------------------------------
// State gathering (real recorded state only)
// ---------------------------------------------------------------------------

/** Research is considered usable when a successful research AgentLog exists. */
async function gatherWorkflowState(opportunityId: string | null, objectiveText: string): Promise<WorkflowState> {
  const state: WorkflowState = {
    halalStatus: 'HALAL',
    objectiveText,
    hasResearch: false,
    researchAgeDays: null,
    hasPositiveValidation: false,
    validationFailed: false,
    hasProduct: false,
    humanReviewPending: false,
  };

  let opportunity: { halalStatus: string; status: string } | null = null;
  if (opportunityId) {
    opportunity = await db.opportunity.findUnique({
      where: { id: opportunityId },
      select: { halalStatus: true, status: true },
    });
    if (!opportunity) {
      // Fail closed: an unknown opportunity must not run workflows.
      state.halalStatus = 'NOT_ALLOWED';
      state.objectiveText = `__invalid_opportunity__ ${objectiveText}`.slice(0, 4000);
      return state;
    }
    state.halalStatus = opportunity.halalStatus;
  }

  // Deterministic screening of the objective text (existing tool).
  const screen = screenForHalalCompliance(objectiveText, '', '', '', '');
  if (screen.status === 'NOT_ALLOWED') {
    state.halalStatus = 'NOT_ALLOWED';
  } else if (screen.status === 'REVIEW_REQUIRED' && state.halalStatus === 'HALAL') {
    state.halalStatus = 'REVIEW_REQUIRED';
  }

  if (!opportunityId) return state;

  const [researchLog, validationLogs, products] = await Promise.all([
    db.agentLog.findFirst({
      where: { agentType: 'research', input: { contains: opportunityId }, success: true },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    db.agentLog.findMany({
      where: { agentType: 'validation', input: { contains: opportunityId }, success: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { output: true, createdAt: true },
    }),
    db.product.findMany({ where: { opportunityId }, select: { id: true }, take: 1 }),
  ]);

  if (researchLog) {
    state.hasResearch = true;
    state.researchAgeDays = Math.max(0, Math.floor((Date.now() - researchLog.createdAt.getTime()) / 86_400_000));
  }

  for (const log of validationLogs) {
    try {
      const output = JSON.parse(log.output) as { recommendation?: string };
      if (output.recommendation === 'PROMISING') {
        state.hasPositiveValidation = true;
      } else if (output.recommendation === 'BLOCKED' || output.recommendation === 'WEAK_SIGNAL') {
        state.validationFailed = true;
      }
    } catch {
      // Unreadable historical output: ignore it rather than guess.
    }
  }

  state.hasProduct = products.length > 0;
  return state;
}

// ---------------------------------------------------------------------------
// Job payload construction (bounded, validated by job-definitions downstream)
// ---------------------------------------------------------------------------

function buildStepPayload(
  step: PlannedStep,
  input: { objective: string; opportunityId: string | null; productType?: string; monetizationPreference?: string; stages?: string[] },
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (input.opportunityId) base.opportunityId = input.opportunityId;

  switch (step.jobType) {
    case 'RESEARCH':
      return { ...base, researchObjective: input.objective.slice(0, 4000) };
    case 'VALIDATION':
      return step.key === 'experiment'
        ? { ...base, validationObjective: `Select prioritized experiments for: ${input.objective.slice(0, 3800)}` }
        : { ...base, validationObjective: `Validate the opportunity researched in this workflow: ${input.objective.slice(0, 3800)}` };
    case 'PRODUCT':
      return {
        ...base,
        productObjective: `Create a product specification for: ${input.objective.slice(0, 3800)}`,
        productType: input.productType ?? 'DIGITAL_PRODUCT',
        ...(input.monetizationPreference ? { monetizationPreference: input.monetizationPreference } : {}),
      };
    case 'ANALYTICS':
      return input.opportunityId
        ? { ...base, analyticsObjective: `Analyze recorded business data for: ${input.objective.slice(0, 3800)}` }
        : { analyticsObjective: input.objective.slice(0, 4000) };
    case 'BUSINESS_MANAGER':
      return { ...base, objective: input.objective.slice(0, 4000), decisionScope: 'FULL_BUSINESS_REVIEW' };
    default:
      return { ...base, objective: input.objective.slice(0, 4000) };
  }
}

// ---------------------------------------------------------------------------
// Persistence (WorkflowRun — same shape family as PipelineRun/JobRun)
// ---------------------------------------------------------------------------

async function persistWorkflowRun(result: Omit<WorkflowExecutionResult, 'workflowRunId'>): Promise<string | null> {
  try {
    const entry = await db.workflowRun.create({
      data: {
        workflowType: result.workflowType,
        status: result.status,
        correlationId: result.correlationId,
        opportunityId: result.opportunityId,
        steps: JSON.stringify(result.steps),
        plan: JSON.stringify(result.plan),
        startedAt: new Date(result.startedAt),
        completedAt: new Date(result.completedAt),
        durationMs: result.durationMs,
      },
    });
    return entry.id;
  } catch (error) {
    logger.error('WorkflowRun persistence failed; execution result is still returned', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ExecuteWorkflowInput {
  workflowType: WorkflowType;
  objective: string;
  opportunityId?: string;
  productType?: string;
  monetizationPreference?: string;
  correlationId?: string;
}

/**
 * Execute a state-aware workflow. Each planned EXECUTE step dispatches through
 * runJob() (existing idempotency + halal gates + bounded retries). Steps the
 * planner skipped/blocked are reported with their deterministic reasons.
 * Fail-closed: a FAILED/BLOCKED/HUMAN_REVIEW step stops the workflow.
 */
export async function executeWorkflow(
  input: ExecuteWorkflowInput,
  options: ExecuteWorkflowOptions = {},
): Promise<WorkflowExecutionResult> {
  const startedAt = new Date();
  const correlationId = input.correlationId?.trim() || `wf-${randomUUID()}`;
  const opportunityId = input.opportunityId ?? null;
  const objective = input.objective.trim();

  // 1. Plan from real recorded state (halal gate included).
  const state = options.providedState ?? (await gatherWorkflowState(opportunityId, objective));
  if (options.stateOverrides) Object.assign(state, options.stateOverrides);
  const plan: WorkflowPlan = planWorkflow(input.workflowType, state);

  const steps: WorkflowStepResult[] = [];
  let workflowStatus: WorkflowExecutionResult['status'] = 'COMPLETED';

  // 2. Terminated workflows record the plan and stop before any execution.
  if (plan.terminated) {
    workflowStatus = plan.gate === 'NOT_ALLOWED' ? 'BLOCKED' : 'HUMAN_REVIEW';
    for (const planned of plan.steps) {
      steps.push({
        key: planned.key,
        jobType: planned.jobType,
        decision: planned.decision,
        status: workflowStatus,
        jobId: null,
        correlationId,
        deduplicated: false,
        reason: planned.reason,
        summary: null,
      });
    }
    return finalize({ workflowId: `wf-${randomUUID()}`, workflowType: input.workflowType, status: workflowStatus, correlationId, opportunityId, plan, steps, startedAt, options });
  }

  // 3. Execute only planned steps, fail-closed between steps.
  let stopped = false;
  for (const planned of plan.steps) {
    if (planned.decision !== 'EXECUTE') {
      steps.push({
        key: planned.key,
        jobType: planned.jobType,
        decision: planned.decision,
        status: planned.decision === 'SKIP_FRESH' ? 'SKIPPED_FRESH' : planned.decision === 'SKIP_EXISTS' ? 'SKIPPED_EXISTS' : 'BLOCKED',
        jobId: null,
        correlationId,
        deduplicated: false,
        reason: planned.reason,
        summary: null,
      });
      continue;
    }

    if (stopped) {
      steps.push({
        key: planned.key,
        jobType: planned.jobType,
        decision: 'BLOCKED',
        status: 'NOT_RUN',
        jobId: null,
        correlationId,
        deduplicated: false,
        reason: 'Not run: an earlier step failed or was stopped (fail-closed chaining).',
        summary: null,
      });
      continue;
    }

    const payload = buildStepPayload(planned, {
      objective,
      opportunityId,
      productType: input.productType,
      monetizationPreference: input.monetizationPreference,
    });
    const dispatch = options.dispatch
      ? options.dispatch
      : async (jt: string, pl: Record<string, unknown>, corr: string) => {
          const o: JobOutcome = await runJob(jt as JobType, pl as JobPayload, corr, options);
          return { status: o.status, jobId: o.jobId, deduplicated: o.deduplicated, result: o.result };
        };
    const outcome = await dispatch(planned.jobType, payload, correlationId);

    steps.push({
      key: planned.key,
      jobType: planned.jobType,
      decision: planned.decision,
      status: outcome.status,
      jobId: outcome.jobId,
      correlationId,
      deduplicated: outcome.deduplicated,
      reason: planned.reason,
      summary: outcome.result,
    });

    if (outcome.status === 'BLOCKED') {
      workflowStatus = 'BLOCKED';
      stopped = true;
    } else if (outcome.status === 'HUMAN_REVIEW') {
      workflowStatus = 'HUMAN_REVIEW';
      stopped = true;
    } else if (outcome.status === 'FAILED') {
      // Release pipelines (PRODUCT_LAUNCH) have no partial success: a failed
      // step fails the run. Agent workflows keep the PARTIAL convention.
      workflowStatus = input.workflowType === 'PRODUCT_LAUNCH' ? 'FAILED' : 'PARTIAL';
      stopped = true;
    } else if (outcome.status === 'DEGRADED' && input.workflowType === 'PRODUCT_LAUNCH') {
      // A degraded launch step means a provider boundary reported
      // NOT_CONNECTED/UNAVAILABLE: stop downstream (never publish an
      // undeployed product) and report DEGRADED instead of a fabricated
      // success.
      workflowStatus = 'DEGRADED';
      stopped = true;
    }
  }

  if (workflowStatus === 'COMPLETED') {
    if (steps.some((s) => s.status === 'DEGRADED')) {
      workflowStatus = 'PARTIAL';
    } else if (
      steps.length > 0 &&
      steps.every((s) => s.status !== 'SUCCEEDED') &&
      steps.some((s) => s.decision === 'BLOCKED')
    ) {
      // The planner blocked every step (e.g. failed validation): reporting
      // COMPLETED would misrepresent a run in which nothing executed.
      workflowStatus = 'BLOCKED';
    }
  }

  return finalize({ workflowId: `wf-${randomUUID()}`, workflowType: input.workflowType, status: workflowStatus, correlationId, opportunityId, plan, steps, startedAt, options });
}

async function finalize(args: {
  workflowId: string;
  workflowType: WorkflowType;
  status: WorkflowExecutionResult['status'];
  correlationId: string;
  opportunityId: string | null;
  plan: WorkflowPlan;
  steps: WorkflowStepResult[];
  startedAt: Date;
  options: ExecuteWorkflowOptions;
}): Promise<WorkflowExecutionResult> {
  const completedAt = new Date();
  const result: Omit<WorkflowExecutionResult, 'workflowRunId'> = {
    workflowId: args.workflowId,
    workflowType: args.workflowType,
    status: args.status,
    correlationId: args.correlationId,
    opportunityId: args.opportunityId,
    plan: {
      gate: args.plan.gate,
      gateReason: args.plan.gateReason,
      terminated: args.plan.terminated,
      rationale: args.plan.rationale,
      steps: args.plan.steps.map((s) => ({ key: s.key, jobType: s.jobType, decision: s.decision, reason: s.reason })),
    },
    steps: args.steps,
    startedAt: args.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - args.startedAt.getTime(),
  };
  const workflowRunId = args.options.skipPersistence ? null : await persistWorkflowRun(result);
  return { ...result, workflowRunId };
}

/** Boundary surface for a future external orchestrator (status stays honest). */
export function describeWorkflowBoundary(): { contract: string[]; status: 'RUFLO_READY' | 'NOT_CONNECTED' } {
  return {
    contract: [
      'executeWorkflow({ workflowType, objective, opportunityId?, correlationId? })',
      'runJob(jobType, payload, correlationId?) — existing job runner',
    ],
    status: 'RUFLO_READY',
  };
}

// ---------------------------------------------------------------------------
// Read-side access (safe, compact fields only — no payloads)
// ---------------------------------------------------------------------------

export interface WorkflowActivityItem {
  id: string;
  workflowType: string;
  status: string;
  correlationId: string;
  opportunityId: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number | null;
}

/** Recent workflow runs for dashboards/APIs. Never includes payloads. */
export async function getRecentWorkflowRuns(limit = 10): Promise<WorkflowActivityItem[]> {
  const rows = await db.workflowRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: Math.min(50, Math.max(1, Math.floor(limit))),
    select: {
      id: true,
      workflowType: true,
      status: true,
      correlationId: true,
      opportunityId: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    workflowType: row.workflowType,
    status: row.status,
    correlationId: row.correlationId,
    opportunityId: row.opportunityId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    durationMs: row.durationMs,
  }));
}
