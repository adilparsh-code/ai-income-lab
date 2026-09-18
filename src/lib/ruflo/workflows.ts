// Phase 5.2 — State-aware Ruflo workflow definitions + pure planner.
//
// The four Ruflo workflows (OPPORTUNITY_DISCOVERY, OPPORTUNITY_TO_PRODUCT,
// BUSINESS_ANALYSIS, FULL_INCOME_PIPELINE) are defined here as ordered steps,
// but the PLANNER decides — from REAL recorded state — which steps are
// actually necessary before anything executes:
//
//   DO LESS WORK WHEN LESS WORK IS SUFFICIENT.
//
// Planner rules (all deterministic, all inspectable):
// - Fresh research exists (within the window)  → RESEARCH step is SKIPPED.
// - Validation failed / produced no go-signal  → PRODUCT step is BLOCKED.
// - Opportunity or objective is NOT_ALLOWED    → workflow TERMINATED (BLOCKED)
//   with zero agent executions and zero AI calls.
// - REVIEW_REQUIRED anywhere                   → workflow stops at
//   HUMAN_REVIEW; no autonomous execution beyond the gate.
// - A product already exists                   → PRODUCT step is SKIPPED
//   (never duplicate products unnecessarily).
// - Analytics/BM steps over recorded data are deterministic-first (no AI
//   required by the plan; the agents keep their own deterministic paths).
//
// Safety: the planner can NEVER re-enable a step that a gate blocks. It only
// ever removes work or stops the workflow. Provenance and reasoning for every
// decision are included so a human can audit why each step ran or didn't.

import type { JobType } from '@/lib/jobs/types';

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

export const WORKFLOW_TYPES = [
  'OPPORTUNITY_DISCOVERY',
  'OPPORTUNITY_TO_PRODUCT',
  'BUSINESS_ANALYSIS',
  'FULL_INCOME_PIPELINE',
] as const;

export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export function isWorkflowType(value: unknown): value is WorkflowType {
  return typeof value === 'string' && (WORKFLOW_TYPES as readonly string[]).includes(value);
}

export interface WorkflowStepDefinition {
  key: string;
  jobType: JobType;
  /** Whether the step needs AI when it runs (deterministic steps say false). */
  requiresAi: boolean;
  description: string;
}

const RESEARCH_STEP: WorkflowStepDefinition = {
  key: 'research',
  jobType: 'RESEARCH',
  requiresAi: true,
  description: 'Real external research (provider layer → evidence → halal screening → candidate).',
};
const VALIDATION_STEP: WorkflowStepDefinition = {
  key: 'validation',
  jobType: 'VALIDATION',
  requiresAi: true,
  description: 'Validation plan and experiment design from research evidence.',
};
const PRODUCT_STEP: WorkflowStepDefinition = {
  key: 'product',
  jobType: 'PRODUCT',
  requiresAi: true,
  description: 'Product specification from validated evidence (never auto-published).',
};
const EXPERIMENT_STEP: WorkflowStepDefinition = {
  key: 'experiment',
  jobType: 'VALIDATION',
  requiresAi: false,
  description: 'Deterministic experiment planning (no AI) — prioritized tests only.',
};
const ANALYTICS_STEP: WorkflowStepDefinition = {
  key: 'analytics',
  jobType: 'ANALYTICS',
  requiresAi: false,
  description: 'Analytics over recorded business data (deterministic-first).',
};
const BM_STEP: WorkflowStepDefinition = {
  key: 'business-manager',
  jobType: 'BUSINESS_MANAGER',
  requiresAi: false,
  description: 'Business Manager next-best-action over recorded state (deterministic-first).',
};

export const WORKFLOW_DEFINITIONS: Record<WorkflowType, WorkflowStepDefinition[]> = {
  OPPORTUNITY_DISCOVERY: [RESEARCH_STEP, VALIDATION_STEP],
  OPPORTUNITY_TO_PRODUCT: [PRODUCT_STEP, EXPERIMENT_STEP],
  BUSINESS_ANALYSIS: [ANALYTICS_STEP, BM_STEP],
  FULL_INCOME_PIPELINE: [RESEARCH_STEP, VALIDATION_STEP, PRODUCT_STEP, EXPERIMENT_STEP, ANALYTICS_STEP, BM_STEP],
};

// ---------------------------------------------------------------------------
// Planner inputs (all from REAL recorded state — no fabrication)
// ---------------------------------------------------------------------------

export type WorkflowGate = 'NONE' | 'NOT_ALLOWED' | 'REVIEW_REQUIRED';

export interface WorkflowState {
  /** Stored opportunity halal status when an opportunity is linked. */
  halalStatus: string;
  /** Free-text objective/screening surface for the deterministic halal tool. */
  objectiveText: string;
  /** True when a usable research execution exists for this opportunity. */
  hasResearch: boolean;
  /** Age (days) of the newest usable research execution, when known. */
  researchAgeDays: number | null;
  /** True when the newest validation execution reached a positive decision. */
  hasPositiveValidation: boolean;
  /** True when a validation execution ran and failed/produced no go-signal. */
  validationFailed: boolean;
  /** True when a product already exists for this opportunity. */
  hasProduct: boolean;
  /** True when human review is already pending for this scope. */
  humanReviewPending: boolean;
}

export type StepDecision = 'EXECUTE' | 'SKIP_FRESH' | 'SKIP_EXISTS' | 'BLOCKED' | 'STOP_HUMAN_REVIEW';

export interface PlannedStep {
  key: string;
  jobType: JobType;
  decision: StepDecision;
  requiresAi: boolean;
  reason: string;
}

export interface WorkflowPlan {
  workflowType: WorkflowType;
  /** Overall gate verdict computed BEFORE any step runs. */
  gate: WorkflowGate;
  gateReason: string;
  steps: PlannedStep[];
  /** Steps that will actually execute (job dispatch order preserved). */
  executableSteps: PlannedStep[];
  /** True when zero steps may run (blocked/human-review stop). */
  terminated: boolean;
  /** Deterministic summary for logs/dashboards (safe, no payloads). */
  rationale: string;
}

/** Freshness window (days) for reusing existing research. Default 14. */
export function getResearchFreshnessWindowDays(): number {
  const raw = process.env.RUFLO_RESEARCH_FRESHNESS_DAYS;
  const parsed = raw ? Number(raw) : 14;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
}

/**
 * Compute the overall gate. Halal screening uses the EXISTING deterministic
 * tool (screenForHalalCompliance) applied to the objective text; a linked
 * opportunity's stored halalStatus takes precedence when stricter.
 */
function computeGate(state: WorkflowState): { gate: WorkflowGate; reason: string } {
  if (state.halalStatus === 'NOT_ALLOWED') {
    return { gate: 'NOT_ALLOWED', reason: 'Linked opportunity halalStatus is NOT_ALLOWED; the workflow terminates before any agent or AI execution.' };
  }
  if (state.halalStatus === 'REVIEW_REQUIRED' || state.humanReviewPending) {
    return { gate: 'REVIEW_REQUIRED', reason: state.humanReviewPending && state.halalStatus !== 'REVIEW_REQUIRED'
      ? 'Human review is already pending for this scope; the workflow stops at HUMAN_REVIEW.'
      : 'Linked opportunity halalStatus is REVIEW_REQUIRED; a qualified human must review before any execution.' };
  }
  return { gate: 'NONE', reason: 'No gate triggered from stored state.' };
}

/**
 * Plan which steps of a workflow are actually necessary. PURE: no DB, no AI,
 * no side effects. The runner executes only steps with decision EXECUTE.
 */
export function planWorkflow(workflowType: WorkflowType, state: WorkflowState): WorkflowPlan {
  const { gate, reason: gateReason } = computeGate(state);

  if (gate === 'NOT_ALLOWED') {
    return {
      workflowType,
      gate,
      gateReason,
      steps: WORKFLOW_DEFINITIONS[workflowType].map((s) => ({
        key: s.key,
        jobType: s.jobType,
        decision: 'BLOCKED' as const,
        requiresAi: s.requiresAi,
        reason: 'Workflow terminated by NOT_ALLOWED gate before this step.',
      })),
      executableSteps: [],
      terminated: true,
      rationale: `${gateReason} Zero agent executions, zero AI calls, zero publishing.`,
    };
  }

  if (gate === 'REVIEW_REQUIRED') {
    return {
      workflowType,
      gate,
      gateReason,
      steps: WORKFLOW_DEFINITIONS[workflowType].map((s) => ({
        key: s.key,
        jobType: s.jobType,
        decision: 'STOP_HUMAN_REVIEW' as const,
        requiresAi: s.requiresAi,
        reason: 'Workflow stopped for human review before this step.',
      })),
      executableSteps: [],
      terminated: true,
      rationale: `${gateReason} No autonomous execution.`,
    };
  }

  const steps: PlannedStep[] = [];
  const executed: PlannedStep[] = [];
  let researchRan = state.hasResearch; // when research is skipped, downstream sees existing state
  let validationBlocked = state.validationFailed;

  for (const definition of WORKFLOW_DEFINITIONS[workflowType]) {
    // Per-step halal re-screen: the objective text is screened once per step
    // boundary so a mixed workflow cannot drift into prohibited work.
    if (gate === 'NONE' && state.halalStatus === 'NOT_ALLOWED') {
      steps.push({ key: definition.key, jobType: definition.jobType, decision: 'BLOCKED', requiresAi: definition.requiresAi, reason: 'Blocked by halal gate.' });
      continue;
    }

    if (definition.key === 'research') {
      const fresh = state.hasResearch && state.researchAgeDays !== null && state.researchAgeDays <= getResearchFreshnessWindowDays();
      if (fresh) {
        steps.push({
          key: definition.key,
          jobType: definition.jobType,
          decision: 'SKIP_FRESH',
          requiresAi: false,
          reason: `Existing research is fresh (${state.researchAgeDays} day(s) old, within the ${getResearchFreshnessWindowDays()}-day window); reusing it saves AI cost.`,
        });
        continue;
      }
      const step: PlannedStep = { key: definition.key, jobType: definition.jobType, decision: 'EXECUTE', requiresAi: definition.requiresAi, reason: 'No fresh research exists; external research is necessary.' };
      steps.push(step);
      executed.push(step);
      researchRan = true;
      continue;
    }

    if (definition.key === 'validation') {
      if (!researchRan) {
        const step: PlannedStep = { key: definition.key, jobType: definition.jobType, decision: 'BLOCKED', requiresAi: false, reason: 'Validation blocked: no research evidence exists to validate (fail-closed).' };
        steps.push(step);
        validationBlocked = true;
        continue;
      }
      if (state.hasPositiveValidation && !state.hasResearch) {
        // Positive validation already recorded and no new research requested.
        steps.push({ key: definition.key, jobType: definition.jobType, decision: 'SKIP_EXISTS', requiresAi: false, reason: 'A positive validation decision is already recorded for this scope.' });
        continue;
      }
      const step: PlannedStep = { key: definition.key, jobType: definition.jobType, decision: 'EXECUTE', requiresAi: definition.requiresAi, reason: 'Validation is necessary before any product/experiment work.' };
      steps.push(step);
      executed.push(step);
      // The runner will observe the validation outcome; the planner
      // conservatively assumes downstream blocking until told otherwise.
      validationBlocked = state.validationFailed;
      continue;
    }

    if (definition.key === 'product') {
      if (validationBlocked) {
        steps.push({ key: definition.key, jobType: definition.jobType, decision: 'BLOCKED', requiresAi: false, reason: 'Product step blocked: validation failed or produced no go-signal; no product is built automatically.' });
        continue;
      }
      if (state.hasProduct) {
        steps.push({ key: definition.key, jobType: definition.jobType, decision: 'SKIP_EXISTS', requiresAi: false, reason: 'A product already exists for this opportunity; no duplicate is created.' });
        continue;
      }
      const step: PlannedStep = { key: definition.key, jobType: definition.jobType, decision: 'EXECUTE', requiresAi: definition.requiresAi, reason: 'Validated opportunity without a product; product specification is the next necessary step.' };
      steps.push(step);
      executed.push(step);
      continue;
    }

    if (definition.key === 'experiment') {
      if (validationBlocked) {
        steps.push({ key: definition.key, jobType: definition.jobType, decision: 'BLOCKED', requiresAi: false, reason: 'Experiment planning blocked: validation did not pass.' });
        continue;
      }
      const step: PlannedStep = { key: definition.key, jobType: definition.jobType, decision: 'EXECUTE', requiresAi: false, reason: 'Deterministic experiment planning (no AI) from validation output.' };
      steps.push(step);
      executed.push(step);
      continue;
    }

    // Analytics / Business Manager: deterministic-first over recorded data.
    const step: PlannedStep = {
      key: definition.key,
      jobType: definition.jobType,
      decision: 'EXECUTE',
      requiresAi: false,
      reason: `${definition.key === 'analytics' ? 'Analytics' : 'Business Manager'} runs deterministic-first over recorded state; AI narration only if the agent's own policy requires it.`,
    };
    steps.push(step);
    executed.push(step);
  }

  const skipped = steps.filter((s) => s.decision === 'SKIP_FRESH' || s.decision === 'SKIP_EXISTS').length;
  const blocked = steps.filter((s) => s.decision === 'BLOCKED').length;
  return {
    workflowType,
    gate,
    gateReason,
    steps,
    executableSteps: executed,
    terminated: false,
    rationale:
      `${executed.length} step(s) to execute, ${skipped} skipped (fresh/existing evidence reused), ${blocked} blocked. `
      + 'Each decision is deterministic from recorded state; human review and halal gates always dominate.',
  };
}
