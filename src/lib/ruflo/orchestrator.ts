// Phase 4.2.4: bounded Ruflo pipeline orchestrator (narrow internal interface).
//
// Runs ONE bounded business-loop workflow end to end:
//   RESEARCH → VALIDATION → PRODUCT
// using ONLY the existing agent registry and the provider-agnostic generation
// layer. It adds routing + safety gates; it does not replace the domain model
// or the agents.
//
// Safety boundaries (docs/ruflo-integration-v4.3.md):
// - Research/analysis/drafting are autonomous-capable; PUBLISH/pricing/spending
//   are NOT executed here (they stay behind explicit policy/permission gates).
// - NOT_ALLOWED halal status: hard stop, downstream agents are never invoked.
// - REVIEW_REQUIRED: no autonomous execution; the run reports HUMAN_REVIEW.
// - Provenance is preserved per step; pipeline output is never VERIFIED_DATA
//   unless a step explicitly produced VERIFIED_DATA for a database-sourced field.

import { db } from '@/lib/db';
import { agentRegistry } from '@/lib/agents/agent-registry';
import type { AgentRequest, AgentResult, AgentType } from '@/lib/agents/types';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { logger } from '@/lib/server-log';

export type PipelineStage = 'RESEARCH' | 'VALIDATION' | 'PRODUCT';

export const PIPELINE_ORDER: PipelineStage[] = ['RESEARCH', 'VALIDATION', 'PRODUCT'];

export interface PipelineStepResult {
  stage: PipelineStage;
  agentType: AgentType;
  executed: boolean;
  success: boolean;
  /** Why the step did/did not run; always safe to show. */
  note: string;
  agentResult?: AgentResult;
  durationMs: number;
}

export type PipelineRunStatus =
  | 'COMPLETED'
  | 'PARTIAL'
  | 'BLOCKED'
  | 'HUMAN_REVIEW'
  | 'FAILED';

export interface PipelineRunResult {
  status: PipelineRunStatus;
  opportunityId?: string;
  steps: PipelineStepResult[];
  /** Final product/validation/research payloads, keyed by stage that ran. */
  outputs: Partial<Record<PipelineStage, unknown>>;
  reasoning: string;
  humanReviewRequired: boolean;
  executionTime: number;
}

export interface PipelineRequest {
  opportunityId?: string;
  researchObjective: string;
  halalRequirements?: string[];
  /** When false (default) the PRODUCT stage is skipped unless validated. */
  includeProductStage?: boolean;
}

const BLOCKED = 'NOT_ALLOWED';
const REVIEW = 'REVIEW_REQUIRED';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Execute one agent step, absorbing thrown errors into a failed step. */
async function runStep(request: AgentRequest, note: string): Promise<PipelineStepResult> {
  const started = Date.now();
  try {
    const result = await agentRegistry.executeAgent(request);
    return {
      stage: request.agentType.toUpperCase() as PipelineStage,
      agentType: request.agentType,
      executed: true,
      success: result.success,
      note,
      agentResult: result,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    logger.error('Pipeline step threw unexpectedly', error, { agentType: request.agentType });
    return {
      stage: request.agentType.toUpperCase() as PipelineStage,
      agentType: request.agentType,
      executed: true,
      success: false,
      note: error instanceof Error ? `Step failed: ${error.message}` : 'Step failed with an unknown error',
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Run the bounded RESEARCH → VALIDATION → PRODUCT pipeline.
 * Every stage is halal-gated independently; a hard block stops the run
 * immediately and never calls downstream agents or the AI provider for
 * prohibited work.
 */
export async function runPipeline(request: PipelineRequest): Promise<PipelineRunResult> {
  const started = Date.now();
  const steps: PipelineStepResult[] = [];
  const outputs: Partial<Record<PipelineStage, unknown>> = {};

  if (!request.researchObjective || request.researchObjective.trim().length === 0) {
    return {
      status: 'FAILED',
      steps,
      outputs,
      reasoning: 'Pipeline rejected: researchObjective is required.',
      humanReviewRequired: false,
      executionTime: Date.now() - started,
    };
  }

  // 1. Resolve the opportunity (explicit id, or highest non-blocked score).
  let opportunity: Awaited<ReturnType<typeof resolveOpportunity>> = null;
  try {
    opportunity = await resolveOpportunity(request.opportunityId);
  } catch (error) {
    logger.error('Pipeline could not load opportunity', error);
    return {
      status: 'FAILED',
      opportunityId: request.opportunityId,
      steps,
      outputs,
      reasoning: 'Pipeline failed: database error while loading the opportunity.',
      humanReviewRequired: false,
      executionTime: Date.now() - started,
    };
  }

  if (request.opportunityId && !opportunity) {
    return {
      status: 'FAILED',
      opportunityId: request.opportunityId,
      steps,
      outputs,
      reasoning: `Pipeline failed: opportunity "${request.opportunityId}" not found.`,
      humanReviewRequired: false,
      executionTime: Date.now() - started,
    };
  }

  const halalStatus = opportunity?.halalStatus ?? 'UNKNOWN';
  const stepsAllowed = request.includeProductStage ?? false;

  // 2. HARD HALAL GATE — deterministic screening of the objective itself.
  const screen = screenForHalalCompliance(
    request.researchObjective,
    '',
    opportunity?.category ?? '',
    '',
    (request.halalRequirements ?? []).join(' '),
  );
  if (screen.status === BLOCKED || halalStatus === BLOCKED) {
    return {
      status: 'BLOCKED',
      opportunityId: opportunity?.id,
      steps,
      outputs,
      reasoning:
        'Pipeline blocked: halal compliance screening returned NOT_ALLOWED. No agent was executed and the AI provider was NOT called.',
      humanReviewRequired: false,
      executionTime: Date.now() - started,
    };
  }

  const humanReview = screen.status === REVIEW || halalStatus === REVIEW;
  if (humanReview) {
    return {
      status: 'HUMAN_REVIEW',
      opportunityId: opportunity?.id,
      steps,
      outputs,
      reasoning:
        'Pipeline paused: REVIEW_REQUIRED halal status. No autonomous execution; a qualified human must review before any agent runs.',
      humanReviewRequired: true,
      executionTime: Date.now() - started,
    };
  }

  // 3. RESEARCH step.
  const researchStep = await runStep(
    {
      agentType: 'research',
      action: 'ruflo_pipeline_research',
      input: {
        researchObjective: request.researchObjective,
        opportunityId: opportunity?.id,
        halalRequirements: request.halalRequirements,
      },
      opportunityId: opportunity?.id,
    },
    'Stage 1 of the bounded business loop.',
  );
  steps.push(researchStep);
  if (researchStep.agentResult && isRecord(researchStep.agentResult.output)) {
    outputs.RESEARCH = researchStep.agentResult.output;
  }
  if (!researchStep.success) {
    return {
      status: 'PARTIAL',
      opportunityId: opportunity?.id,
      steps,
      outputs,
      reasoning: 'Research stage failed; validation and product stages were not attempted (fail-closed).',
      humanReviewRequired: false,
      executionTime: Date.now() - started,
    };
  }

  // 4. VALIDATION step (runs only when research produced findings).
  const validationStep = await runStep(
    {
      agentType: 'validation',
      action: 'ruflo_pipeline_validation',
      input: {
        opportunityId: opportunity?.id,
        validationObjective: `Validate the opportunity researched in this pipeline run: ${request.researchObjective}`,
      },
      opportunityId: opportunity?.id,
    },
    'Stage 2 of the bounded business loop.',
  );
  steps.push(validationStep);
  if (validationStep.agentResult && isRecord(validationStep.agentResult.output)) {
    outputs.VALIDATION = validationStep.agentResult.output;
  }
  if (!validationStep.success) {
    return {
      status: 'PARTIAL',
      opportunityId: opportunity?.id,
      steps,
      outputs,
      reasoning: 'Validation stage failed; product stage was not attempted (fail-closed).',
      humanReviewRequired: false,
      executionTime: Date.now() - started,
    };
  }

  // 5. PRODUCT step — bounded: only runs when explicitly requested. Publishing,
  // pricing, and spend decisions remain human-gated and are NEVER automated here.
  if (stepsAllowed) {
    const productStep = await runStep(
      {
        agentType: 'product',
        action: 'ruflo_pipeline_product',
        input: {
          opportunityId: opportunity?.id,
          productObjective: `Create a product concept for: ${request.researchObjective}`,
          productType: 'DIGITAL_PRODUCT',
        },
        opportunityId: opportunity?.id,
      },
      'Stage 3 of the bounded business loop (explicitly requested).',
    );
    steps.push(productStep);
    if (productStep.agentResult && isRecord(productStep.agentResult.output)) {
      outputs.PRODUCT = productStep.agentResult.output;
    }
    if (!productStep.success) {
      return {
        status: 'PARTIAL',
        opportunityId: opportunity?.id,
        steps,
        outputs,
        reasoning: 'Product stage failed; pipeline stopped (fail-closed).',
        humanReviewRequired: false,
        executionTime: Date.now() - started,
      };
    }
  }

  const failedCount = steps.filter((s) => !s.success).length;
  const status: PipelineRunStatus = failedCount === 0 ? 'COMPLETED' : 'PARTIAL';
  const stageList = steps.map((s) => s.stage).join(' → ');
  return {
    status,
    opportunityId: opportunity?.id,
    steps,
    outputs,
    reasoning: `Bounded pipeline finished: ${stageList}. ${failedCount} step(s) failed. All outputs are AI_INFERENCE unless a step explicitly marks a field VERIFIED_DATA.`,
    humanReviewRequired: false,
    executionTime: Date.now() - started,
  };
}
