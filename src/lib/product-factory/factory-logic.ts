// Product Factory v1 — pure view/state logic.
//
//   OPPORTUNITY → EVIDENCE → VALIDATION → CONCEPT → MVP → BUILD PLAN → MONETIZATION → DISTRIBUTION
//
// This module is PURE: no database, no network, no AI provider, no React. It
// maps an existing bounded pipeline run (RESEARCH → VALIDATION → PRODUCT) onto
// the factory workflow for display. It never creates evidence and never
// invents facts: every field shown by the factory is copied from real step
// outputs (AI_INFERENCE), fetched sources (VERIFIED_DATA / SEARCH_DISCOVERY),
// or database records — missing data is reported as missing.
//
// Client-safe: imported by server actions and client components alike.

import type { PipelineStepSummary } from '@/lib/ruflo/pipeline-logic';

// ---------------------------------------------------------------------------
// Workflow model
// ---------------------------------------------------------------------------

export type FactoryWorkflowKey =
  | 'OPPORTUNITY'
  | 'EVIDENCE'
  | 'VALIDATION'
  | 'CONCEPT'
  | 'MVP'
  | 'BUILD_PLAN'
  | 'MONETIZATION'
  | 'DISTRIBUTION';

export type FactoryStepState = 'READY' | 'PENDING' | 'FAILED' | 'BLOCKED';

export interface FactoryWorkflowStep {
  key: FactoryWorkflowKey;
  label: string;
  description: string;
  state: FactoryStepState;
  detail?: string;
}

export const FACTORY_WORKFLOW: { key: FactoryWorkflowKey; label: string; description: string }[] = [
  { key: 'OPPORTUNITY', label: 'Opportunity', description: 'The selected opportunity record and its halal status.' },
  { key: 'EVIDENCE', label: 'Evidence', description: 'External sources collected by the Real Research Engine.' },
  { key: 'VALIDATION', label: 'Validation', description: 'Validation plan, risks, and testable criteria.' },
  { key: 'CONCEPT', label: 'Product Concept', description: 'Customer, problem, solution, and value hypothesis.' },
  { key: 'MVP', label: 'MVP Specification', description: 'Prioritized MVP features.' },
  { key: 'BUILD_PLAN', label: 'Build Plan', description: 'Phased build plan with dependencies and risks.' },
  { key: 'MONETIZATION', label: 'Monetization', description: 'Monetization model and pricing hypotheses.' },
  { key: 'DISTRIBUTION', label: 'Distribution', description: 'Channels, content, and conversion path hypotheses.' },
];

// ---------------------------------------------------------------------------
// Evidence chain (from the RESEARCH step output)
// ---------------------------------------------------------------------------

export type FactorySourceType = 'VERIFIED_DATA' | 'SEARCH_DISCOVERY';

export interface FactoryEvidenceSource {
  url: string;
  domain: string;
  title: string;
  evidenceType: FactorySourceType;
  retrievedAt: string;
  /** Search-result snippet (SEARCH_DISCOVERY only; never fetched). */
  snippet?: string;
  /** Extracted page text (VERIFIED_DATA only; actually fetched). */
  excerpt?: string;
  httpStatus?: number;
  contentType?: string;
  contentLength?: number;
}

export interface FactoryResearchReport {
  status: string;
  searchProviderId: string | null;
  servedFrom: string;
  discoveryCount: number;
  verifiedCount: number;
  reasoning: string;
  ranAt: string;
}

// ---------------------------------------------------------------------------
// Validation + product views (from VALIDATION / PRODUCT step outputs)
// ---------------------------------------------------------------------------

export interface FactoryValidationView {
  recommendation: string;
  confidence: number | null;
  assumptions: string[];
  tests: { name: string; method: string; description: string }[];
  risks: { risk: string; severity: string }[];
  successCriteria: string[];
  failureCriteria: string[];
  evidenceRequirements: string[];
}

export interface FactoryConceptView {
  name: string;
  oneLine: string;
  customer: string;
  problem: string;
  solution: string;
  valueProposition: string;
  differentiation: string;
  format: string;
  useCase: string;
  evidenceType: string;
}

export interface FactoryFeatureView {
  name: string;
  description: string;
  priority: string;
}

export interface FactoryBuildPhaseView {
  phase: number;
  name: string;
  tasks: string[];
  dependencies: string[];
  expectedOutput: string;
  risk: string;
}

export interface FactoryMonetizationView {
  model: string;
  rationale: string;
  pricingHypothesis: string;
  assumptions: string[];
  risks: string[];
  evidenceNeeded: string[];
}

export interface FactoryDistributionView {
  channels: string[];
  contentStrategy: string;
  landingPageConcept: string;
  conversionPath: string[];
}

export interface FactoryProductView {
  /** True only when the PRODUCT step actually produced a concept. */
  present: boolean;
  concept: FactoryConceptView | null;
  mvpFeatures: FactoryFeatureView[];
  optionalFutureFeatures: string[];
  buildPhases: FactoryBuildPhaseView[];
  monetization: FactoryMonetizationView | null;
  distribution: FactoryDistributionView | null;
  risks: string[];
  assumptions: string[];
  evidenceNeeded: string[];
  confidence: number | null;
  humanReviewRequired: boolean;
  capabilityStatus: string | null;
}

// ---------------------------------------------------------------------------
// Aggregated run view
// ---------------------------------------------------------------------------

export type FactoryDataMode = 'LIVE' | 'MOCKED' | 'PLANNED';

export interface FactoryProvenanceSummary {
  /** Evidence-type counts across step outputs. */
  counts: Record<string, number>;
  /** Evidence-type counts across collected external sources. */
  sourceCounts: { VERIFIED_DATA: number; SEARCH_DISCOVERY: number };
  aiUsage: {
    liveSteps: number;
    fallbackSteps: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

export interface FactoryRunView {
  dataMode: FactoryDataMode;
  status: string;
  objective: string;
  opportunityId: string | null;
  humanReviewRequired: boolean;
  reasoning: string;
  workflow: FactoryWorkflowStep[];
  evidence: {
    sources: FactoryEvidenceSource[];
    report: FactoryResearchReport | null;
  };
  validation: FactoryValidationView | null;
  product: FactoryProductView;
  provenance: FactoryProvenanceSummary;
  missingEvidence: string[];
  nextActions: string[];
}

/** Structural shape accepted by buildFactoryRunView (PipelineRunResult fits). */
export interface FactoryRunLike {
  status: string;
  objective: string;
  opportunityId?: string | null;
  humanReviewRequired?: boolean;
  reasoning?: string;
  /** Optional so corrupt/partial payloads can be rendered defensively. */
  steps?: PipelineStepSummary[];
  findings?: {
    missingEvidence?: string[];
    nextActions?: string[];
    provenanceCounts?: Record<string, number>;
    aiTotals?: {
      liveSteps: number;
      fallbackSteps: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Defensive extraction helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function asNullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stepFor(steps: PipelineStepSummary[], stage: string): PipelineStepSummary | undefined {
  return steps.find((s) => s.stage === stage);
}

function findStepOutput(steps: PipelineStepSummary[], stage: string): Record<string, unknown> | null {
  const step = stepFor(steps, stage);
  return step && step.executed && isRecord(step.output) ? (step.output as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Extraction: evidence chain, validation, product
// ---------------------------------------------------------------------------

function extractEvidence(steps: PipelineStepSummary[]): FactoryRunView['evidence'] {
  const output = findStepOutput(steps, 'RESEARCH');
  if (!output) return { sources: [], report: null };

  const sources: FactoryEvidenceSource[] = [];
  for (const raw of asRecordArray(output.sources)) {
    const type = asNullableString(raw.evidenceType);
    if (type !== 'VERIFIED_DATA' && type !== 'SEARCH_DISCOVERY') continue;
    const url = asNullableString(raw.url);
    if (!url) continue;
    sources.push({
      url,
      domain: asString(raw.domain, ''),
      title: asString(raw.title, ''),
      evidenceType: type,
      retrievedAt: asString(raw.retrievedAt, ''),
      snippet: asNullableString(raw.snippet) ?? undefined,
      excerpt: asNullableString(raw.excerpt) ?? undefined,
      httpStatus: asNullableFiniteNumber(raw.httpStatus) ?? undefined,
      contentType: asNullableString(raw.contentType) ?? undefined,
      contentLength: asNullableFiniteNumber(raw.contentLength) ?? undefined,
    });
  }

  const reportRaw = isRecord(output.sourceResearch) ? output.sourceResearch : null;
  const report: FactoryResearchReport | null = reportRaw
    ? {
        status: asString(reportRaw.status, 'UNKNOWN'),
        searchProviderId: asNullableString(reportRaw.searchProviderId),
        servedFrom: asString(reportRaw.servedFrom, 'none'),
        discoveryCount:
          asNullableFiniteNumber(reportRaw.discoveryCount) ??
          sources.filter((s) => s.evidenceType === 'SEARCH_DISCOVERY').length,
        verifiedCount:
          asNullableFiniteNumber(reportRaw.verifiedCount) ??
          sources.filter((s) => s.evidenceType === 'VERIFIED_DATA').length,
        reasoning: asString(reportRaw.reasoning, ''),
        ranAt: asString(reportRaw.ranAt, ''),
      }
    : null;

  return { sources, report };
}

function extractValidation(steps: PipelineStepSummary[]): FactoryValidationView | null {
  const output = findStepOutput(steps, 'VALIDATION');
  if (!output) return null;

  const risks = asRecordArray(output.prioritizedRisks)
    .map((r) => ({ risk: asString(r.risk, ''), severity: asString(r.severity, 'MEDIUM') }))
    .filter((r) => r.risk.length > 0);

  const tests = asRecordArray(output.validationTests)
    .map((t) => ({
      name: asString(t.name, ''),
      method: asString(t.method, ''),
      description: asString(t.description, ''),
    }))
    .filter((t) => t.name.length > 0);

  return {
    recommendation: asString(output.recommendation, 'UNKNOWN'),
    confidence: asNullableFiniteNumber(output.confidence),
    assumptions: asStringArray(output.assumptions),
    tests,
    risks,
    successCriteria: asStringArray(output.successCriteria),
    failureCriteria: asStringArray(output.failureCriteria),
    evidenceRequirements: asStringArray(output.evidenceRequirements),
  };
}

function extractProduct(steps: PipelineStepSummary[]): FactoryProductView {
  const empty: FactoryProductView = {
    present: false,
    concept: null,
    mvpFeatures: [],
    optionalFutureFeatures: [],
    buildPhases: [],
    monetization: null,
    distribution: null,
    risks: [],
    assumptions: [],
    evidenceNeeded: [],
    confidence: null,
    humanReviewRequired: false,
    capabilityStatus: stepFor(steps, 'PRODUCT')?.capabilityStatus ?? null,
  };

  const step = stepFor(steps, 'PRODUCT');
  const output = findStepOutput(steps, 'PRODUCT');
  if (!output) return empty;

  const conceptRaw = isRecord(output.productConcept) ? output.productConcept : null;
  // An empty/garbage concept object (e.g. only a blank name, from a degraded
  // fallback) is NOT a produced concept — it must not render as READY.
  const conceptMeaningful = Boolean(
    conceptRaw &&
      (asNullableString(conceptRaw.productNameHypothesis) ||
        asNullableString(conceptRaw.oneLineDescription) ||
        asNullableString(conceptRaw.proposedSolution)),
  );
  const concept: FactoryConceptView | null = conceptRaw
    ? {
        name: asString(conceptRaw.productNameHypothesis, ''),
        oneLine: asString(conceptRaw.oneLineDescription, ''),
        customer: asString(conceptRaw.customer, ''),
        problem: asString(conceptRaw.problem, ''),
        solution: asString(conceptRaw.proposedSolution, ''),
        valueProposition: asString(conceptRaw.coreValueProposition, ''),
        differentiation: asString(conceptRaw.differentiationHypothesis, ''),
        format: asString(conceptRaw.productFormat, ''),
        useCase: asString(conceptRaw.primaryUseCase, ''),
        evidenceType: asString(conceptRaw.evidenceType, 'AI_INFERENCE'),
      }
    : null;

  const monetizationRaw = isRecord(output.monetizationModel) ? null : asNullableString(output.monetizationModel);
  const monetization: FactoryMonetizationView | null =
    monetizationRaw || asNullableString(output.monetizationRationale)
      ? {
          model: monetizationRaw ?? 'Not specified',
          rationale: asString(output.monetizationRationale, ''),
          pricingHypothesis: asString(output.pricingHypothesis, ''),
          assumptions: asStringArray(output.monetizationAssumptions),
          risks: asStringArray(output.monetizationRisks),
          evidenceNeeded: asStringArray(output.evidenceNeeded),
        }
      : null;

  const channels = asStringArray(output.distributionChannels);
  const distribution: FactoryDistributionView | null =
    channels.length > 0 ||
    asNullableString(output.contentStrategy) ||
    asNullableString(output.landingPageConcept)
      ? {
          channels,
          contentStrategy: asString(output.contentStrategy, ''),
          landingPageConcept: asString(output.landingPageConcept, ''),
          conversionPath: asStringArray(output.conversionPath),
        }
      : null;

  return {
    present: conceptMeaningful,
    concept,
    mvpFeatures: asRecordArray(output.mvpFeatures)
      .map((f) => ({
        name: asString(f.name, ''),
        description: asString(f.description, ''),
        priority: asString(f.priority, 'IMPORTANT'),
      }))
      .filter((f) => f.name.length > 0),
    optionalFutureFeatures: asStringArray(output.optionalFutureFeatures),
    buildPhases: asRecordArray(output.buildPhases)
      .map((p) => ({
        phase: asNullableFiniteNumber(p.phase) ?? 0,
        name: asString(p.name, ''),
        tasks: asStringArray(p.tasks),
        dependencies: asStringArray(p.dependencies),
        expectedOutput: asString(p.expectedOutput, ''),
        risk: asString(p.risk, ''),
      }))
      .filter((p) => p.name.length > 0),
    monetization,
    distribution,
    risks: asStringArray(output.risks),
    assumptions: asStringArray(output.assumptions),
    evidenceNeeded: asStringArray(output.evidenceNeeded),
    confidence: asNullableFiniteNumber(output.confidence),
    humanReviewRequired: output.humanReviewRequired === true,
    capabilityStatus: asString(step?.capabilityStatus, 'UNKNOWN'),
  };
}

// ---------------------------------------------------------------------------
// Workflow state derivation (honest: presence-based, never fabricated)
// ---------------------------------------------------------------------------

function baseStepState(runStatus: string, step: PipelineStepSummary | undefined): FactoryStepState {
  if (runStatus === 'BLOCKED') return 'BLOCKED';
  if (runStatus === 'HUMAN_REVIEW' && !step) return 'PENDING';
  if (!step || !step.executed) return 'PENDING';
  return step.success ? 'READY' : 'FAILED';
}

function buildWorkflow(
  run: FactoryRunLike,
  steps: PipelineStepSummary[],
  product: FactoryProductView,
): FactoryWorkflowStep[] {
  const runStatus = run.status;
  const researchStep = stepFor(steps, 'RESEARCH');
  const validationStep = stepFor(steps, 'VALIDATION');
  const productStep = stepFor(steps, 'PRODUCT');

  const paused = runStatus === 'HUMAN_REVIEW';
  const blocked = runStatus === 'BLOCKED';
  const blockedDetail = 'Blocked by halal compliance screening — nothing ran.';
  const reviewDetail = 'Paused for human review — nothing ran autonomously.';

  const detailFor = (state: FactoryStepState, fallback?: string): string | undefined => {
    if (state === 'BLOCKED') return blockedDetail;
    if (paused && !fallback) return reviewDetail;
    return fallback;
  };

  const opportunityState: FactoryStepState =
    blocked || paused ? (blocked ? 'BLOCKED' : 'PENDING') : run.opportunityId ? 'READY' : 'READY';
  const opportunityDetail = run.opportunityId
    ? undefined
    : 'No opportunity record linked — free-form objective.';

  const researchState = baseStepState(runStatus, researchStep);
  const researchDetail =
    researchState === 'PENDING' && !blocked
      ? 'Research has not run yet.'
      : researchState === 'FAILED'
        ? 'Research failed — no evidence chain was produced.'
        : undefined;

  const validationState = baseStepState(runStatus, validationStep);
  const validationDetail =
    validationState === 'PENDING' && !blocked
      ? 'Validation has not run yet.'
      : validationState === 'FAILED'
        ? 'Validation failed — no plan was produced.'
        : undefined;

  const productState = baseStepState(runStatus, productStep);
  const productDetail =
    productState === 'PENDING' && !blocked
      ? 'Product generation has not run yet.'
      : productState === 'FAILED'
        ? 'Product generation failed — no concept was produced.'
        : undefined;

  return [
    {
      key: 'OPPORTUNITY',
      label: FACTORY_WORKFLOW[0].label,
      description: FACTORY_WORKFLOW[0].description,
      state: opportunityState,
      detail: detailFor(opportunityState, opportunityDetail),
    },
    {
      key: 'EVIDENCE',
      label: FACTORY_WORKFLOW[1].label,
      description: FACTORY_WORKFLOW[1].description,
      state: researchState,
      detail: detailFor(researchState, researchDetail),
    },
    {
      key: 'VALIDATION',
      label: FACTORY_WORKFLOW[2].label,
      description: FACTORY_WORKFLOW[2].description,
      state: validationState,
      detail: detailFor(validationState, validationDetail),
    },
    {
      key: 'CONCEPT',
      label: FACTORY_WORKFLOW[3].label,
      description: FACTORY_WORKFLOW[3].description,
      state: product.present ? 'READY' : productState,
      detail: detailFor(product.present ? 'READY' : productState, productDetail),
    },
    {
      key: 'MVP',
      label: FACTORY_WORKFLOW[4].label,
      description: FACTORY_WORKFLOW[4].description,
      state: product.mvpFeatures.length > 0 ? 'READY' : productState,
      detail:
        product.mvpFeatures.length > 0
          ? undefined
          : detailFor(productState, 'No MVP features were produced by this run.'),
    },
    {
      key: 'BUILD_PLAN',
      label: FACTORY_WORKFLOW[5].label,
      description: FACTORY_WORKFLOW[5].description,
      state: product.buildPhases.length > 0 ? 'READY' : productState,
      detail:
        product.buildPhases.length > 0
          ? undefined
          : detailFor(productState, 'No build phases were produced by this run.'),
    },
    {
      key: 'MONETIZATION',
      label: FACTORY_WORKFLOW[6].label,
      description: FACTORY_WORKFLOW[6].description,
      state: product.monetization ? 'READY' : productState,
      detail: product.monetization ? undefined : detailFor(productState, 'No monetization view was produced.'),
    },
    {
      key: 'DISTRIBUTION',
      label: FACTORY_WORKFLOW[7].label,
      description: FACTORY_WORKFLOW[7].description,
      state: product.distribution ? 'READY' : productState,
      detail: product.distribution ? undefined : detailFor(productState, 'No distribution view was produced.'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Missing-evidence rules (explicit; nothing is inferred or fabricated)
// ---------------------------------------------------------------------------

const MAX_MISSING = 8;

function buildMissingEvidence(
  run: FactoryRunLike,
  steps: PipelineStepSummary[],
  evidence: FactoryRunView['evidence'],
  validation: FactoryValidationView | null,
  product: FactoryProductView,
): string[] {
  const missing: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (!missing.includes(trimmed) && missing.length < MAX_MISSING) missing.push(trimmed);
  };

  const researchStep = stepFor(steps, 'RESEARCH');
  if (!researchStep || !researchStep.executed) {
    push(run.status === 'BLOCKED'
      ? 'No evidence was collected: the run was blocked by halal compliance before research ran.'
      : 'Research has not run — no evidence chain exists yet.');
  } else if (!researchStep.success) {
    push('Research failed — no evidence chain was produced for this run.');
  } else if (evidence.report?.status === 'NOT_CONFIGURED') {
    push('Live search discovery is not configured — no external sources were collected. Configure a search provider to gather real evidence.');
  } else {
    if (evidence.sources.length === 0) {
      push('No external sources were collected for this run; everything shown is AI inference and user input.');
    } else if (evidence.sources.every((s) => s.evidenceType === 'SEARCH_DISCOVERY')) {
      push('No VERIFIED_DATA sources: nothing was fetched and validated from the origin — all external items are unverified discovery leads.');
    }
  }

  const validationStep = stepFor(steps, 'VALIDATION');
  if ((!validationStep || !validationStep.executed) && run.status !== 'BLOCKED') {
    push('Validation has not run — no validation tests or success/failure criteria exist yet.');
  }
  if (validation) {
    for (const req of validation.evidenceRequirements) push(req);
  }

  const productStep = stepFor(steps, 'PRODUCT');
  if (!productStep || !productStep.executed) {
    if (run.status !== 'BLOCKED') push('Product generation has not run — no concept exists yet.');
  } else {
    for (const needed of product.evidenceNeeded) push(needed);
  }

  // Persisted run findings (from the pipeline's own collector) are merged in
  // last so both sources agree without duplicating logic.
  for (const item of run.findings?.missingEvidence ?? []) push(item);

  return missing;
}

// ---------------------------------------------------------------------------
// Data mode + provenance
// ---------------------------------------------------------------------------

function computeDataMode(steps: PipelineStepSummary[]): FactoryDataMode {
  const executed = steps.filter((s) => s.executed);
  if (executed.length === 0) return 'PLANNED';
  if (executed.some((s) => s.capabilityStatus === 'LIVE' && !s.fallbackUsed)) return 'LIVE';
  return 'MOCKED';
}

function computeProvenance(
  run: FactoryRunLike,
  steps: PipelineStepSummary[],
  evidence: FactoryRunView['evidence'],
): FactoryProvenanceSummary {
  const counts: Record<string, number> = { ...(run.findings?.provenanceCounts ?? {}) };
  if (Object.keys(counts).length === 0) {
    for (const step of steps) {
      if (!step.executed) continue;
      counts[step.evidenceType] = (counts[step.evidenceType] ?? 0) + 1;
    }
  }
  const aiTotals = run.findings?.aiTotals ?? {
    liveSteps: steps.filter((s) => s.executed && s.aiUsage).length,
    fallbackSteps: steps.filter((s) => s.executed && s.fallbackUsed).length,
    inputTokens: steps.reduce((acc, s) => acc + (s.aiUsage?.inputTokens ?? 0), 0),
    outputTokens: steps.reduce((acc, s) => acc + (s.aiUsage?.outputTokens ?? 0), 0),
    estimatedCostUsd: steps.reduce((acc, s) => acc + (s.aiUsage?.estimatedCostUsd ?? 0), 0),
  };
  return {
    counts,
    sourceCounts: {
      VERIFIED_DATA: evidence.sources.filter((s) => s.evidenceType === 'VERIFIED_DATA').length,
      SEARCH_DISCOVERY: evidence.sources.filter((s) => s.evidenceType === 'SEARCH_DISCOVERY').length,
    },
    aiUsage: aiTotals,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Build the display view for one factory run. Every field is copied from real
 * step outputs; absent data is reported as absent. This function cannot
 * fabricate anything — it has no data source besides the run itself.
 */
export function buildFactoryRunView(run: FactoryRunLike): FactoryRunView {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const evidence = extractEvidence(steps);
  const validation = extractValidation(steps);
  const product = extractProduct(steps);

  const missingEvidence = buildMissingEvidence(run, steps, evidence, validation, product);
  const nextActions = (run.findings?.nextActions ?? []).slice(0, 8);
  const humanReviewRequired =
    run.humanReviewRequired === true || run.status === 'HUMAN_REVIEW' || product.humanReviewRequired;

  return {
    dataMode: computeDataMode(steps),
    status: run.status,
    objective: run.objective,
    opportunityId: run.opportunityId ?? null,
    humanReviewRequired,
    reasoning: run.reasoning ?? '',
    workflow: buildWorkflow(run, steps, product),
    evidence,
    validation,
    product,
    provenance: computeProvenance(run, steps, evidence),
    missingEvidence,
    nextActions,
  };
}

// ---------------------------------------------------------------------------
// Run classification (which persisted runs are Product Factory runs?)
// ---------------------------------------------------------------------------

const FACTORY_STAGES = new Set(['RESEARCH', 'VALIDATION', 'PRODUCT']);

/**
 * A persisted PipelineRun is a Product Factory run when it executed at least
 * one step and every executed stage is inside the factory subset. Full
 * pipeline runs (EXPERIMENT/TRACKING) and corrupt records are excluded.
 */
export function looksLikeFactoryRun(parsed: unknown): boolean {
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return false;
  const executedStages = (parsed.steps as unknown[])
    .filter(isRecord)
    .map((s) => asNullableString(s.stage))
    .filter((s): s is string => s !== null && s !== undefined);
  if (executedStages.length === 0) return false;
  return executedStages.every((stage) => FACTORY_STAGES.has(stage));
}
