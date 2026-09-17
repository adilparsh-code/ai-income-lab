// Phase 5: pure pipeline logic for the unified business workflow.
//
//   OPPORTUNITY → RESEARCH → VALIDATION → PRODUCT → EXPERIMENT → TRACKING
//
// This module is PURE: no database, no network, no AI provider, no React. It is
// imported by the server orchestrator, server actions, AND client components
// (metadata only), so it must stay dependency-free.
//
// Provenance rules: nothing here creates evidence. Values are copied from
// agent outputs (AI_INFERENCE), database records (VERIFIED_DATA), or user
// input (USER_ENTERED) and keep their original classification. Missing data is
// reported as missing — never fabricated.

// ---------------------------------------------------------------------------
// Canonical stage model
// ---------------------------------------------------------------------------

export type PipelineStage = 'RESEARCH' | 'VALIDATION' | 'PRODUCT' | 'EXPERIMENT' | 'TRACKING';

export const PIPELINE_ORDER: PipelineStage[] = [
  'RESEARCH',
  'VALIDATION',
  'PRODUCT',
  'EXPERIMENT',
  'TRACKING',
];

/** Agent that executes each stage (registry types; TRACKING is analytics). */
export const STAGE_AGENT: Record<PipelineStage, string> = {
  RESEARCH: 'research',
  VALIDATION: 'validation',
  PRODUCT: 'product',
  EXPERIMENT: 'validation',
  TRACKING: 'analytics',
};

export interface PipelineStageMeta {
  stage: PipelineStage;
  label: string;
  description: string;
}

export const PIPELINE_STAGE_META: Record<PipelineStage, PipelineStageMeta> = {
  RESEARCH: {
    stage: 'RESEARCH',
    label: 'Research',
    description: 'Gather AI-inference findings and signals about the problem space.',
  },
  VALIDATION: {
    stage: 'VALIDATION',
    label: 'Validation',
    description: 'Turn findings into a testable validation plan with explicit criteria.',
  },
  PRODUCT: {
    stage: 'PRODUCT',
    label: 'Product',
    description: 'Shape a product concept and MVP plan from validated context.',
  },
  EXPERIMENT: {
    stage: 'EXPERIMENT',
    label: 'Experiment',
    description: 'Select the highest-priority experiments to run first.',
  },
  TRACKING: {
    stage: 'TRACKING',
    label: 'Tracking',
    description: 'Review recorded experiments, products and revenue for next actions.',
  },
};

export type PipelineRunStatus = 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'HUMAN_REVIEW' | 'FAILED';

// ---------------------------------------------------------------------------
// Experiment plan selection (deterministic, from Validation Agent output)
// ---------------------------------------------------------------------------

export interface ExperimentPlanItem {
  id: string;
  name: string;
  hypothesis: string;
  method: string;
  /** Missing thresholds stay null — never invented. */
  metric: string | null;
  successThreshold: number | null;
  failureThreshold: number | null;
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
  priority: number;
  source: 'VALIDATION_EXPERIMENT' | 'VALIDATION_TEST';
  status: 'PLANNED';
}

/** Minimal structural view of the Validation Agent result (no agent import). */
export interface ValidationOutputLike {
  experimentRecommendations?: unknown;
  validationTests?: unknown;
}

const VALID_EFFORT = ['LOW', 'MEDIUM', 'HIGH'] as const;
type Effort = (typeof VALID_EFFORT)[number];

function asEffort(value: unknown): Effort {
  const v = typeof value === 'string' ? value.toUpperCase() : '';
  return (VALID_EFFORT as readonly string[]).includes(v) ? (v as Effort) : 'MEDIUM';
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Positive finite number, or null when absent/invalid — never guessed. */
function asNullablePositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Deterministically select the experiments to run first from a Validation
 * Agent result. Prefers full experiment recommendations, falling back to
 * validation tests when none exist. Items are ordered by priority, capped at
 * `maxExperiments`, and thresholds are passed through verbatim (null when the
 * agent did not provide one). No thresholds, metrics, or outcomes are invented.
 */
export function selectExperimentPlan(
  validation: ValidationOutputLike | null | undefined,
  maxExperiments = 3,
): ExperimentPlanItem[] {
  const recommendations = isRecordArray(validation?.experimentRecommendations);
  const tests = isRecordArray(validation?.validationTests);

  if (recommendations.length > 0) {
    const items = recommendations.map((e, i) => ({
      id: asString(e.id, `exp-${i + 1}`),
      name: asString(e.experimentName ?? e.name, `Experiment ${i + 1}`),
      hypothesis: asString(e.hypothesis, 'Hypothesis not specified by the validation agent.'),
      method: asString(e.method, 'EXPERIMENT'),
      metric: asNullableString(e.metric),
      successThreshold: asNullablePositiveNumber(e.successThreshold),
      failureThreshold: asNullablePositiveNumber(e.failureThreshold),
      effort: asEffort(e.estimatedEffort),
      priority:
        typeof e.priority === 'number' && Number.isFinite(e.priority)
          ? Math.max(1, Math.floor(e.priority))
          : i + 1,
      source: 'VALIDATION_EXPERIMENT' as const,
      status: 'PLANNED' as const,
    }));
    return items.sort((a, b) => a.priority - b.priority).slice(0, maxExperiments);
  }

  if (tests.length > 0) {
    const items = tests.map((t, i) => ({
      id: asString(t.id, `test-${i + 1}`),
      name: asString(t.name, `Validation test ${i + 1}`),
      hypothesis: asString(t.description, 'Test purpose not specified by the validation agent.'),
      method: asString(t.method, 'MANUAL_RESEARCH'),
      metric: null,
      successThreshold: null,
      failureThreshold: null,
      effort: asEffort(t.estimatedEffort),
      priority:
        typeof t.priority === 'number' && Number.isFinite(t.priority)
          ? Math.max(1, Math.floor(t.priority))
          : i + 1,
      source: 'VALIDATION_TEST' as const,
      status: 'PLANNED' as const,
    }));
    return items.sort((a, b) => a.priority - b.priority).slice(0, maxExperiments);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Step summaries + stage progress
// ---------------------------------------------------------------------------

export interface AiUsageLike {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}

/** Normalized, serializable view of one executed pipeline step. */
export interface PipelineStepSummary {
  stage: PipelineStage;
  executed: boolean;
  success: boolean;
  note: string;
  evidenceType: string;
  capabilityStatus?: string;
  fallbackUsed: boolean;
  durationMs: number;
  output?: Record<string, unknown>;
  aiUsage?: AiUsageLike | null;
}

export type StageProgressState = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface StageProgress {
  stage: PipelineStage;
  label: string;
  state: StageProgressState;
  note?: string;
}

/**
 * Compute per-stage progress from executed step summaries. Stages after the
 * last executed one are PENDING; stages before an executed stage that did not
 * run themselves are SKIPPED (fail-closed skipping, not silent success).
 */
export function computeStageProgress(steps: PipelineStepSummary[]): StageProgress[] {
  const byStage = new Map(steps.map((s) => [s.stage, s]));
  // "Last executed" is measured in CANONICAL stage order, not array order, so a
  // stage between two executed stages (e.g. VALIDATION between RESEARCH and
  // PRODUCT) is correctly reported as SKIPPED rather than PENDING.
  const executedCanonicalIndexes = steps
    .filter((s) => s.executed)
    .map((s) => PIPELINE_ORDER.indexOf(s.stage))
    .filter((i) => i >= 0);
  const lastExecutedIndex =
    executedCanonicalIndexes.length > 0 ? Math.max(...executedCanonicalIndexes) : -1;

  return PIPELINE_ORDER.map((stage, index) => {
    const step = byStage.get(stage);
    if (step) {
      return {
        stage,
        label: PIPELINE_STAGE_META[stage].label,
        state: step.success ? ('SUCCEEDED' as const) : ('FAILED' as const),
        note: step.note,
      };
    }
    return {
      stage,
      label: PIPELINE_STAGE_META[stage].label,
      state: index < lastExecutedIndex ? ('SKIPPED' as const) : ('PENDING' as const),
    };
  });
}

// ---------------------------------------------------------------------------
// Run status aggregation + findings collection
// ---------------------------------------------------------------------------

export interface RunFlags {
  blocked: boolean;
  humanReviewRequired: boolean;
}

/**
 * Aggregate the overall run status. Precedence: a hard halal block always wins
 * (BLOCKED), then human review (HUMAN_REVIEW), then failure analysis
 * (FAILED when nothing succeeded, PARTIAL when some steps failed,
 * COMPLETED when every executed step succeeded).
 */
export function aggregateRunStatus(
  steps: PipelineStepSummary[],
  flags: RunFlags,
): PipelineRunStatus {
  if (flags.blocked) return 'BLOCKED';
  if (flags.humanReviewRequired) return 'HUMAN_REVIEW';
  const executed = steps.filter((s) => s.executed);
  if (executed.length === 0) return 'FAILED';
  const failed = executed.filter((s) => !s.success);
  if (failed.length === 0) return 'COMPLETED';
  if (failed.length === executed.length) return 'FAILED';
  return 'PARTIAL';
}

export interface RunFindings {
  risks: string[];
  assumptions: string[];
  missingEvidence: string[];
  nextActions: string[];
  provenanceCounts: Record<string, number>;
  aiTotals: {
    liveSteps: number;
    fallbackSteps: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

const MAX_FINDINGS_PER_CATEGORY = 8;

function pushUnique(list: string[], value: string, cap = MAX_FINDINGS_PER_CATEGORY): void {
  if (list.length >= cap) return;
  const trimmed = value.trim();
  if (trimmed.length > 0 && !list.includes(trimmed)) list.push(trimmed);
}

/** Extract risks from a step output in either string[] or prioritized form. */
function extractRisks(output: Record<string, unknown>): string[] {
  const risks: string[] = [];
  for (const r of isRecordArray(output.prioritizedRisks)) {
    const risk = asNullableString(r.risk);
    if (risk) pushUnique(risks, severitySuffix(risk, r.severity));
  }
  for (const r of Array.isArray(output.risks) ? output.risks : []) {
    if (typeof r === 'string') pushUnique(risks, r);
    else if (isRecord(r)) {
      const text = asNullableString(r.risk ?? r.description);
      if (text) pushUnique(risks, severitySuffix(text, r.severity));
    }
  }
  return risks;
}

function severitySuffix(text: string, severity: unknown): string {
  const s = typeof severity === 'string' && severity.length > 0 ? severity.toUpperCase() : null;
  return s ? `${text} [${s}]` : text;
}

/**
 * Collect cross-step findings (risks, assumptions, missing evidence, next
 * actions, provenance rollup, AI usage totals) from normalized step summaries.
 * Only values present in the outputs are reported — nothing is fabricated.
 */
export function collectFindings(steps: PipelineStepSummary[]): RunFindings {
  const risks: string[] = [];
  const assumptions: string[] = [];
  const missingEvidence: string[] = [];
  const nextActions: string[] = [];
  const provenanceCounts: Record<string, number> = {};

  const countProvenance = (type: unknown): void => {
    if (typeof type !== 'string' || type.length === 0) return;
    provenanceCounts[type] = (provenanceCounts[type] ?? 0) + 1;
  };

  for (const step of steps) {
    countProvenance(step.evidenceType);
    const output = step.output;
    if (!output) continue;

    // Evidence arrays on agent outputs ({ type, content } items).
    for (const item of isRecordArray(output.evidence)) countProvenance(item.type);

    for (const r of extractRisks(output)) pushUnique(risks, r);

    for (const a of Array.isArray(output.assumptions) ? output.assumptions : []) {
      if (typeof a === 'string') pushUnique(assumptions, a);
    }

    for (const key of ['evidenceNeeded', 'evidenceRequirements']) {
      for (const e of Array.isArray(output[key]) ? output[key] : []) {
        if (typeof e === 'string') pushUnique(missingEvidence, e);
      }
    }
    const warnings = isRecord(output.dataSummary)
      ? output.dataSummary.insufficientDataWarnings
      : undefined;
    for (const w of Array.isArray(warnings) ? warnings : []) {
      if (typeof w === 'string') pushUnique(missingEvidence, w);
    }

    // Next actions, per stage, from whatever the agent actually produced.
    if (step.stage === 'VALIDATION') {
      for (const t of isRecordArray(output.validationTests)) {
        const name = asNullableString(t.name);
        if (name) pushUnique(nextActions, `Run validation test: ${name}`);
      }
    }
    if (step.stage === 'PRODUCT') {
      const essential = isRecordArray(output.mvpFeatures).find(
        (f) => f.priority === 'ESSENTIAL',
      );
      const name = essential ? asNullableString(essential.name) : null;
      if (name) pushUnique(nextActions, `Build MVP feature: ${name}`);
    }
    if (step.stage === 'EXPERIMENT' && Array.isArray(output.experimentPlan)) {
      for (const e of isRecordArray(output.experimentPlan)) {
        const name = asNullableString(e.name);
        if (name) pushUnique(nextActions, `Run experiment: ${name}`);
      }
    }
    if (step.stage === 'TRACKING') {
      for (const a of isRecordArray(output.nextBestActions)) {
        const action = asNullableString(a.action);
        if (action) pushUnique(nextActions, action);
      }
    }
  }

  const aiTotals = steps.reduce(
    (acc, step) => {
      if (step.fallbackUsed) acc.fallbackSteps += 1;
      if (step.aiUsage) {
        acc.liveSteps += 1;
        acc.inputTokens += step.aiUsage.inputTokens;
        acc.outputTokens += step.aiUsage.outputTokens;
        acc.estimatedCostUsd += step.aiUsage.estimatedCostUsd;
      }
      return acc;
    },
    { liveSteps: 0, fallbackSteps: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
  );

  return { risks, assumptions, missingEvidence, nextActions, provenanceCounts, aiTotals };
}

// ---------------------------------------------------------------------------
// Provenance labelling for persisted run payloads
// ---------------------------------------------------------------------------

export type RunProvenance = 'AI_INFERENCE' | 'VERIFIED_DATA' | 'USER_ENTERED' | 'MOCKED';

/**
 * Classification for the persisted run payload as a whole. Step outputs keep
 * their own provenance inside the payload; VERIFIED_DATA is only ever reached
 * when a step explicitly marked its output VERIFIED_DATA (database-sourced).
 */
export function classifyRunProvenance(steps: PipelineStepSummary[]): RunProvenance {
  const executed = steps.filter((s) => s.executed);
  if (executed.length === 0) return 'AI_INFERENCE';
  if (executed.every((s) => s.capabilityStatus === 'MOCKED' || s.fallbackUsed)) return 'MOCKED';
  if (executed.every((s) => s.evidenceType === 'VERIFIED_DATA')) return 'VERIFIED_DATA';
  return 'AI_INFERENCE';
}
