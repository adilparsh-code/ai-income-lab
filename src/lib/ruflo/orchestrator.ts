// Phase 5: bounded Opportunity → Product pipeline orchestrator (narrow internal
// interface). Runs ONE bounded business-loop workflow end to end:
//
//   RESEARCH → VALIDATION → PRODUCT → EXPERIMENT → TRACKING
//
// using ONLY the existing agent registry, the provider-agnostic generation
// layer, and the pure lifecycle/pipeline-logic modules. It adds routing, safety
// gates, and run persistence; it does not replace the domain model or agents.
//
// Safety boundaries (docs/ruflo-integration-v4.3.md):
// - Research/analysis/drafting/planning are autonomous-capable; PUBLISH,
//   pricing, spending, and other irreversible actions are NOT executed here.
//   The EXPERIMENT stage only selects a prioritized experiment plan; actually
//   creating/running experiments and recording outcomes stays human-gated.
// - NOT_ALLOWED halal status: hard stop, downstream agents are never invoked
//   and the AI provider is NEVER called for prohibited work.
// - REVIEW_REQUIRED: no autonomous execution; the run reports HUMAN_REVIEW.
// - Provenance is preserved per step; the run is classified MOCKED only when
//   every step came from the deterministic path, VERIFIED_DATA only when a
//   step explicitly produced VERIFIED_DATA from database-sourced fields.

import { db } from '@/lib/db';
import { agentRegistry } from '@/lib/agents/agent-registry';
import type { AgentRequest, AgentResult } from '@/lib/agents/types';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { logger } from '@/lib/server-log';
import { deriveLifecycleStage, type LifecycleStage } from './lifecycle';
import {
  PIPELINE_ORDER,
  PIPELINE_STAGE_META,
  STAGE_AGENT,
  selectExperimentPlan,
  computeStageProgress,
  aggregateRunStatus,
  collectFindings,
  classifyRunProvenance,
  type PipelineStage,
  type PipelineStepSummary,
  type PipelineRunStatus,
  type StageProgress,
  type ExperimentPlanItem,
  type RunFindings,
  type RunProvenance,
  type ValidationOutputLike,
} from './pipeline-logic';

export type { PipelineStage, PipelineRunStatus, StageProgress, ExperimentPlanItem };

export interface PipelineStepResult {
  stage: PipelineStage;
  agentType: string;
  executed: boolean;
  success: boolean;
  /** Why the step did/did not run; always safe to show. */
  note: string;
  agentResult?: AgentResult;
  /** Normalized, serializable summary used for progress, findings, and DB. */
  summary: PipelineStepSummary;
  durationMs: number;
}

export interface PipelineRunResult {
  /** PipelineRun record id (auditability); absent only if persistence failed. */
  runId?: string;
  status: PipelineRunStatus;
  opportunityId?: string;
  objective: string;
  /** Lifecycle position derived from REAL stored data after the run. */
  lifecycleStage: LifecycleStage;
  lifecycleRationale: string;
  steps: PipelineStepResult[];
  /** Canonical 5-stage progress (includes stages never attempted). */
  progress: StageProgress[];
  /** Prioritized experiments selected by the EXPERIMENT stage (if run). */
  experimentPlan: ExperimentPlanItem[];
  findings: RunFindings;
  provenance: RunProvenance;
  reasoning: string;
  humanReviewRequired: boolean;
  executionTime: number;
}

export interface PipelineRequest {
  opportunityId?: string;
  /** One objective drives the whole bounded run. */
  objective: string;
  halalRequirements?: string[];
  /**
   * Stages to execute (defaults to the full bounded loop). Always executed in
   * canonical order regardless of the order supplied here.
   */
  stages?: PipelineStage[];
}

const BLOCKED = 'NOT_ALLOWED';
const REVIEW = 'REVIEW_REQUIRED';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact, de-duplicated stage list in canonical order (empty → full loop). */
function resolveStages(requested?: PipelineStage[]): PipelineStage[] {
  if (!requested || requested.length === 0) return PIPELINE_ORDER;
  const set = new Set(requested);
  return PIPELINE_ORDER.filter((s) => set.has(s));
}

/**
 * Load one opportunity (id or highest non-blocked score). Returns null when no
 * eligible opportunity exists — callers must handle that, never fabricate one.
 */
async function resolveOpportunity(opportunityId?: string) {
  if (opportunityId) {
    const found = await db.opportunity.findUnique({
      where: { id: opportunityId },
      select: { id: true, title: true, status: true, halalStatus: true, category: true, problemSolved: true },
    });
    return found;
  }
  return db.opportunity.findFirst({
    where: {
      halalStatus: { not: BLOCKED },
      status: { notIn: ['REJECTED', 'PAUSED'] },
    },
    orderBy: { overallScore: 'desc' },
    select: { id: true, title: true, status: true, halalStatus: true, category: true, problemSolved: true },
  });
}

/**
 * Derive the lifecycle position from REAL stored data after a run, reusing the
 * existing pure lifecycle model so the pipeline and dashboard stay consistent.
 */
async function computeLifecycleStage(opportunityId?: string): Promise<{ stage: LifecycleStage; rationale: string }> {
  if (!opportunityId) {
    return {
      stage: 'RESEARCH',
      rationale: 'No linked opportunity record; lifecycle position cannot be derived from stored data.',
    };
  }
  try {
    const [opp, experiments, products, oppRevenues] = await Promise.all([
      db.opportunity.findUnique({ where: { id: opportunityId } }),
      db.experiment.findMany({ where: { opportunityId }, select: { id: true, decision: true } }),
      db.product.findMany({ where: { opportunityId }, select: { id: true, status: true } }),
      db.revenue.findMany({ where: { opportunityId }, select: { id: true } }),
    ]);
    if (!opp) {
      return { stage: 'RESEARCH', rationale: 'Linked opportunity record not found.' };
    }
    const linkedProductIds = products.map((p) => p.id);
    const productRevenues = linkedProductIds.length
      ? await db.revenue.findMany({ where: { productId: { in: linkedProductIds } }, select: { id: true } })
      : [];
    const [researchLog, validationLog] = await Promise.all([
      db.agentLog.findFirst({ where: { agentType: 'research', input: { contains: opportunityId } }, select: { id: true } }),
      db.agentLog.findFirst({ where: { agentType: 'validation', input: { contains: opportunityId } }, select: { id: true } }),
    ]);

    const view = deriveLifecycleStage({
      opportunity: {
        id: opp.id,
        title: opp.title,
        status: opp.status,
        halalStatus: opp.halalStatus,
        overallScore: opp.overallScore,
      },
      experiments: experiments.length,
      products: products.length,
      revenues: new Set([...oppRevenues.map((r) => r.id), ...productRevenues.map((r) => r.id)]).size,
      completedExperimentDecisions: experiments.filter((e) =>
        ['SCALE', 'KILL', 'PAUSE'].includes(e.decision ?? '')
      ).length,
      positiveExperimentDecisions: experiments.filter((e) => e.decision === 'SCALE').length,
      publishedProducts: products.filter((p) => ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status)).length,
      hasResearchLog: Boolean(researchLog),
      hasValidationLog: Boolean(validationLog),
    });
    return { stage: view.currentStage, rationale: view.rationale };
  } catch (error) {
    logger.error('Pipeline could not derive lifecycle stage', error, { opportunityId });
    return { stage: 'RESEARCH', rationale: 'Lifecycle position could not be computed from stored data.' };
  }
}

/** Persist the run for auditability/dashboard history. Never throws. */
async function persistRun(result: Omit<PipelineRunResult, 'runId'>): Promise<string | undefined> {
  try {
    const entry = await db.pipelineRun.create({
      data: {
        opportunityId: result.opportunityId ?? null,
        objective: result.objective,
        currentStage: result.lifecycleStage,
        status: result.status,
        result: JSON.stringify(result),
        aiInputTokens: result.findings.aiTotals.inputTokens > 0 ? result.findings.aiTotals.inputTokens : null,
        aiOutputTokens: result.findings.aiTotals.outputTokens > 0 ? result.findings.aiTotals.outputTokens : null,
        estimatedCostUsd: result.findings.aiTotals.estimatedCostUsd > 0 ? result.findings.aiTotals.estimatedCostUsd : null,
        completedAt: new Date(),
        durationMs: result.executionTime,
      },
    });
    return entry.id;
  } catch (error) {
    logger.error('Pipeline run persistence failed', error);
    return undefined;
  }
}

/** Execute one agent step, absorbing thrown errors into a failed step. */
async function runAgentStep(
  stage: PipelineStage,
  request: AgentRequest,
  note: string,
): Promise<PipelineStepResult> {
  const started = Date.now();
  let result: AgentResult;
  try {
    result = await agentRegistry.executeAgent(request);
  } catch (error) {
    logger.error('Pipeline step threw unexpectedly', error, { agentType: request.agentType });
    result = {
      success: false,
      output: {},
      reasoning: error instanceof Error ? `Step failed: ${error.message}` : 'Step failed with an unknown error',
      evidenceType: 'AI_INFERENCE',
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime: 0,
    };
  }

  // The pipeline stage is passed explicitly: agent types and pipeline stages
  // are NOT 1:1 (the analytics agent implements the TRACKING stage, and the
  // validation agent also powers the deterministic EXPERIMENT planning), so
  // deriving the stage from the agent type would mislabel step summaries.
  const summary: PipelineStepSummary = {
    stage,
    executed: true,
    success: result.success,
    note,
    evidenceType: result.evidenceType,
    capabilityStatus: result.capabilityStatus,
    fallbackUsed: result.fallbackUsed ?? false,
    durationMs: result.executionTime,
    output: isRecord(result.output) ? result.output : undefined,
    aiUsage: result.aiUsage ?? null,
  };
  return { stage, agentType: request.agentType, executed: true, success: result.success, note, agentResult: result, summary, durationMs: Date.now() - started };
}

/** Deterministic (non-agent) step, e.g. experiment plan selection. */
function deterministicStep(
  stage: PipelineStage,
  success: boolean,
  note: string,
  output: Record<string, unknown>,
  inherited: { evidenceType: string; capabilityStatus?: string; fallbackUsed: boolean },
  durationMs: number,
): PipelineStepResult {
  const summary: PipelineStepSummary = {
    stage,
    executed: true,
    success,
    note,
    evidenceType: inherited.evidenceType,
    capabilityStatus: inherited.capabilityStatus,
    fallbackUsed: inherited.fallbackUsed,
    durationMs,
    output,
    aiUsage: null,
  };
  return { stage, agentType: STAGE_AGENT[stage], executed: true, success, note, summary, durationMs };
}

function skippedResult(stage: PipelineStage, note: string): PipelineStepResult {
  const summary: PipelineStepSummary = {
    stage,
    executed: false,
    success: false,
    note,
    evidenceType: 'AI_INFERENCE',
    fallbackUsed: false,
    durationMs: 0,
  };
  return { stage, agentType: STAGE_AGENT[stage], executed: false, success: false, note, summary, durationMs: 0 };
}

/**
 * Run the bounded Opportunity → Product pipeline. Every stage is halal-gated;
 * a hard block stops the run immediately and never calls downstream agents or
 * the AI provider for prohibited work. Failures fail closed: downstream stages
 * are skipped (never silently executed on top of broken upstream data).
 */
export async function runPipeline(request: PipelineRequest): Promise<PipelineRunResult> {
  const started = Date.now();
  const steps: PipelineStepResult[] = [];
  const requestedStages = resolveStages(request.stages);
  const stageIncluded = (stage: PipelineStage) => requestedStages.includes(stage);

  const finalize = async (
    args: {
      status: PipelineRunStatus;
      opportunityId?: string;
      objective: string;
      reasoning: string;
      humanReviewRequired: boolean;
      skipStageNote?: Partial<Record<PipelineStage, string>>;
    },
  ): Promise<PipelineRunResult> => {
    const { status, opportunityId, objective, reasoning, humanReviewRequired } = args;
    const summaries = steps.map((s) => s.summary);
    const flags = {
      blocked: status === 'BLOCKED',
      humanReviewRequired:
        humanReviewRequired ||
        summaries.some((s) => s.output?.humanReviewRequired === true),
    };
    const findings = collectFindings(summaries);
    const provenance = classifyRunProvenance(summaries);
    // For failure/finish exits the explicit flow status is refined by the
    // shared aggregator: e.g. a run whose only executed stage failed is
    // FAILED (not PARTIAL), and any step output demanding human review
    // promotes the run to HUMAN_REVIEW.
    const aggregated = aggregateRunStatus(summaries, {
      blocked: status === 'BLOCKED',
      humanReviewRequired:
        humanReviewRequired || summaries.some((s) => s.output?.humanReviewRequired === true),
    });
    const effectiveStatus: PipelineRunStatus =
      status === 'PARTIAL' || status === 'COMPLETED' ? aggregated : status;
    const lifecycle = await computeLifecycleStage(opportunityId);
    const experimentPlan =
      (steps.find((s) => s.stage === 'EXPERIMENT' && s.summary.output)?.summary.output
        ?.experimentPlan as ExperimentPlanItem[] | undefined) ?? [];

    const notes = args.skipStageNote ?? {};
    const progress = computeStageProgress(summaries).map((p) =>
      p.state === 'SKIPPED' && notes[p.stage] ? { ...p, note: notes[p.stage] } : p,
    );

    const base: Omit<PipelineRunResult, 'runId'> = {
      status: effectiveStatus,
      opportunityId,
      objective,
      lifecycleStage: lifecycle.stage,
      lifecycleRationale: lifecycle.rationale,
      steps,
      progress,
      experimentPlan,
      findings,
      provenance,
      reasoning,
      humanReviewRequired: flags.humanReviewRequired,
      executionTime: Date.now() - started,
    };
    const runId = await persistRun(base);
    return { ...base, runId };
  };

  // 0. Objective resolution. When an opportunity is linked, its stored title /
  // problem can seed the objective (user data, never invented market facts).
  let objective = (request.objective ?? '').trim();
  let opportunity: Awaited<ReturnType<typeof resolveOpportunity>> = null;
  try {
    opportunity = await resolveOpportunity(request.opportunityId);
  } catch (error) {
    logger.error('Pipeline could not load opportunity', error);
    return finalize({
      status: 'FAILED',
      opportunityId: request.opportunityId,
      objective,
      reasoning: 'Pipeline failed: database error while loading the opportunity.',
      humanReviewRequired: false,
    });
  }

  if (request.opportunityId && !opportunity) {
    return finalize({
      status: 'FAILED',
      opportunityId: request.opportunityId,
      objective,
      reasoning: `Pipeline failed: opportunity "${request.opportunityId}" not found.`,
      humanReviewRequired: false,
    });
  }

  if (objective.length === 0 && opportunity) {
    objective = opportunity.problemSolved
      ? `Evaluate and plan: ${opportunity.title} — ${opportunity.problemSolved}`
      : `Evaluate and plan: ${opportunity.title}`;
  }

  if (objective.length === 0) {
    return finalize({
      status: 'FAILED',
      opportunityId: opportunity?.id,
      objective,
      reasoning: 'Pipeline rejected: an objective is required (or select an opportunity to use its stored problem statement).',
      humanReviewRequired: false,
    });
  }

  // 1. HARD HALAL GATE — deterministic screening of the objective itself.
  const halalStatus = opportunity?.halalStatus ?? 'UNKNOWN';
  const screen = screenForHalalCompliance(
    objective,
    '',
    opportunity?.category ?? '',
    '',
    (request.halalRequirements ?? []).join(' '),
  );
  if (screen.status === BLOCKED || halalStatus === BLOCKED) {
    return finalize({
      status: 'BLOCKED',
      opportunityId: opportunity?.id,
      objective,
      reasoning:
        'Pipeline blocked: halal compliance screening returned NOT_ALLOWED. No agent was executed and the AI provider was NOT called.',
      humanReviewRequired: false,
    });
  }

  const humanReview = screen.status === REVIEW || halalStatus === REVIEW;
  if (humanReview) {
    return finalize({
      status: 'HUMAN_REVIEW',
      opportunityId: opportunity?.id,
      objective,
      reasoning:
        'Pipeline paused: REVIEW_REQUIRED halal status. No autonomous execution; a qualified human must review before any agent runs.',
      humanReviewRequired: true,
    });
  }

  // 2. Stage loop with fail-closed gates between stages.
  const shouldRun = (stage: PipelineStage) => stageIncluded(stage);

  // ---- RESEARCH ----
  if (shouldRun('RESEARCH')) {
    const researchStep = await runAgentStep(
      'RESEARCH',
      {
        agentType: 'research',
        action: 'ruflo_pipeline_research',
        input: {
          researchObjective: objective,
          opportunityId: opportunity?.id,
          halalRequirements: request.halalRequirements,
        },
        opportunityId: opportunity?.id,
      },
      'Stage 1 of the bounded business loop.',
    );
    steps.push(researchStep);
    if (!researchStep.success) {
      return finalize({
        status: 'PARTIAL',
        opportunityId: opportunity?.id,
        objective,
        reasoning: 'Research stage failed; downstream stages were not attempted (fail-closed).',
        humanReviewRequired: false,
        skipStageNote: {
          VALIDATION: 'Skipped: research failed (fail-closed).',
          PRODUCT: 'Skipped: research failed (fail-closed).',
          EXPERIMENT: 'Skipped: research failed (fail-closed).',
          TRACKING: 'Skipped: research failed (fail-closed).',
        },
      });
    }
  }

  // ---- VALIDATION ----
  if (shouldRun('VALIDATION')) {
    const validationStep = await runAgentStep(
      'VALIDATION',
      {
        agentType: 'validation',
        action: 'ruflo_pipeline_validation',
        input: {
          opportunityId: opportunity?.id,
          validationObjective: `Validate the opportunity researched in this pipeline run: ${objective}`,
        },
        opportunityId: opportunity?.id,
      },
      'Stage 2 of the bounded business loop.',
    );
    steps.push(validationStep);
    if (!validationStep.success) {
      return finalize({
        status: 'PARTIAL',
        opportunityId: opportunity?.id,
        objective,
        reasoning: 'Validation stage failed; downstream stages were not attempted (fail-closed).',
        humanReviewRequired: false,
        skipStageNote: {
          PRODUCT: 'Skipped: validation failed (fail-closed).',
          EXPERIMENT: 'Skipped: validation failed (fail-closed).',
          TRACKING: 'Skipped: validation failed (fail-closed).',
        },
      });
    }
  }

  // ---- PRODUCT ----
  if (shouldRun('PRODUCT')) {
    const productStep = await runAgentStep(
      'PRODUCT',
      {
        agentType: 'product',
        action: 'ruflo_pipeline_product',
        input: {
          opportunityId: opportunity?.id,
          productObjective: `Create a product concept for: ${objective}`,
          productType: 'DIGITAL_PRODUCT',
        },
        opportunityId: opportunity?.id,
      },
      'Stage 3 of the bounded business loop. Publishing, pricing, and spend decisions remain human-gated.',
    );
    steps.push(productStep);
    if (!productStep.success) {
      return finalize({
        status: 'PARTIAL',
        opportunityId: opportunity?.id,
        objective,
        reasoning: 'Product stage failed; downstream stages were not attempted (fail-closed).',
        humanReviewRequired: false,
        skipStageNote: {
          EXPERIMENT: 'Skipped: product stage failed (fail-closed).',
          TRACKING: 'Skipped: product stage failed (fail-closed).',
        },
      });
    }
  }

  // ---- EXPERIMENT (deterministic planning; no agent, no AI call) ----
  if (shouldRun('EXPERIMENT')) {
    const validationOutput = steps.find((s) => s.stage === 'VALIDATION')?.summary.output;
    if (!validationOutput) {
      steps.push(skippedResult('EXPERIMENT', 'Skipped: no validation output available to derive an experiment plan from.'));
    } else {
      const planStarted = Date.now();
      const validationSummary = steps.find((s) => s.stage === 'VALIDATION')!.summary;
      const plan = selectExperimentPlan(validationOutput as ValidationOutputLike, 3);
      steps.push(
        deterministicStep(
          'EXPERIMENT',
          plan.length > 0,
          plan.length > 0
            ? `Selected ${plan.length} prioritized experiment(s) from the validation plan. Actually creating and running experiments stays human-gated.`
            : 'No experiments could be selected: the validation stage produced no testable experiments or tests.',
          { experimentPlan: plan },
          {
            evidenceType: validationSummary.evidenceType,
            capabilityStatus: validationSummary.capabilityStatus,
            fallbackUsed: validationSummary.fallbackUsed,
          },
          Date.now() - planStarted,
        ),
      );
      if (plan.length === 0) {
        return finalize({
          status: 'PARTIAL',
          opportunityId: opportunity?.id,
          objective,
          reasoning: 'Experiment planning produced no testable experiments; tracking was not attempted (fail-closed).',
          humanReviewRequired: false,
          skipStageNote: { TRACKING: 'Skipped: experiment planning produced no plan (fail-closed).' },
        });
      }
    }
  }

  // ---- TRACKING ----
  if (shouldRun('TRACKING')) {
    const trackingStep = await runAgentStep(
      'TRACKING',
      {
        agentType: 'analytics',
        action: 'ruflo_pipeline_tracking',
        input: {
          analysisObjective: `Track recorded experiment, product, and revenue data for: ${objective}`,
          analysisScope: opportunity?.id ? 'OPPORTUNITIES' : 'OVERVIEW',
          opportunityId: opportunity?.id,
        },
        opportunityId: opportunity?.id,
      },
      'Stage 5 of the bounded business loop: analytics over real recorded data only.',
    );
    steps.push(trackingStep);
    if (!trackingStep.success) {
      return finalize({
        status: 'PARTIAL',
        opportunityId: opportunity?.id,
        objective,
        reasoning: 'Tracking stage failed; the run stopped with earlier stage outputs intact.',
        humanReviewRequired: false,
      });
    }
  }

  const firstNotRun = PIPELINE_ORDER.find(
    (s) => stageIncluded(s) && !steps.some((step) => step.stage === s),
  );
  if (firstNotRun) {
    return finalize({
      status: 'PARTIAL',
      opportunityId: opportunity?.id,
      objective,
      reasoning: `Pipeline stopped before the ${PIPELINE_STAGE_META[firstNotRun].label} stage.`,
      humanReviewRequired: false,
      skipStageNote: { [firstNotRun]: 'Not attempted.' },
    });
  }

  const stageList = steps.filter((s) => s.executed).map((s) => s.stage).join(' → ');
  return finalize({
    status: 'COMPLETED',
    opportunityId: opportunity?.id,
    objective,
    reasoning:
      `Bounded pipeline finished: ${stageList}. ` +
      'All outputs are AI_INFERENCE unless a step explicitly marks a field VERIFIED_DATA. ' +
      'Publishing, pricing, spend, and irreversible actions remain human-gated.',
    humanReviewRequired: false,
  });
}
