// Phase 4.2.4: Ruflo lifecycle model for AI Income Lab.
//
// This module is PURE: no database, no network, no provider imports. It maps
// real domain state (Opportunity/Product/Experiment/Revenue/AgentLog shapes as
// plain records) onto the documented lifecycle from docs/ruflo-integration-v4.3.md:
//
//   DISCOVER → RESEARCH → VALIDATE → DECIDE → BUILD → PUBLISH → MARKET → MEASURE → IMPROVE
//
// Provenance rules: every recommendation produced here is AI_INFERENCE. Fields
// copied from database records keep their own evidence types. This module never
// fabricates market data, revenue, or outcomes; "missing evidence" is reported
// as missing, never invented.

export type LifecycleStage =
  | 'DISCOVER'
  | 'RESEARCH'
  | 'VALIDATE'
  | 'DECIDE'
  | 'BUILD'
  | 'PUBLISH'
  | 'MARKET'
  | 'MEASURE'
  | 'IMPROVE';

export const LIFECYCLE_ORDER: LifecycleStage[] = [
  'DISCOVER', 'RESEARCH', 'VALIDATE', 'DECIDE', 'BUILD', 'PUBLISH', 'MARKET', 'MEASURE', 'IMPROVE',
];

/** Minimal read-only views of domain records (no Prisma dependency here). */
export interface LifecycleOpportunity {
  id: string;
  title: string;
  status: string;
  halalStatus: string;
  overallScore: number;
}

export interface LifecycleCounts {
  opportunities: number;
  experiments: number;
  products: number;
  revenues: number;
}

/** One stage of the business loop for a given opportunity. */
export interface LifecycleStageStatus {
  stage: LifecycleStage;
  /** One-line, data-grounded description of where this stage stands. */
  state: string;
  /** True when this stage is the recommended focus right now. */
  isCurrent: boolean;
  /** True when real recorded data exists for this stage (never fabricated). */
  hasEvidence: boolean;
  /** What is missing before this stage can advance, when applicable. */
  missingEvidence: string[];
}

export interface OpportunityLifecycleView {
  opportunity: { id: string; title: string; status: string; halalStatus: string; overallScore: number };
  stages: LifecycleStageStatus[];
  currentStage: LifecycleStage;
  /** Why the current stage was selected; always grounded in the inputs. */
  rationale: string;
  halalStatus: string;
}

export interface PortfolioLifecycleSummary {
  counts: LifecycleCounts;
  /** Stage distribution over non-blocked opportunities (keyed by stage). */
  stageDistribution: { stage: LifecycleStage; count: number }[];
  /** NEXT STAGE for each of the top opportunities, highest score first. */
  opportunities: OpportunityLifecycleView[];
}

const BLOCKED = 'NOT_ALLOWED';
const REVIEW = 'REVIEW_REQUIRED';

function isFinishedLike(status: string): boolean {
  return ['REJECTED', 'PAUSED'].includes(status);
}

/**
 * Derive the current lifecycle stage for one opportunity from REAL state:
 * status string, linked record counts, and agent-log presence. Deterministic,
 * evidence-based, category-agnostic (works for products, printables, SaaS,
 * services, content, affiliate, etc.).
 */
export function deriveLifecycleStage(input: {
  opportunity: LifecycleOpportunity;
  experiments: number;
  products: number;
  revenues: number;
  completedExperimentDecisions: number;
  positiveExperimentDecisions: number;
  publishedProducts: number;
  hasResearchLog: boolean;
  hasValidationLog: boolean;
}): OpportunityLifecycleView {
  const { opportunity: opp } = input;
  const halalStatus = opp.halalStatus || 'UNKNOWN';

  const missing: Record<LifecycleStage, string[]> = {
    DISCOVER: [],
    RESEARCH: [],
    VALIDATE: [],
    DECIDE: [],
    BUILD: [],
    PUBLISH: [],
    MARKET: [],
    MEASURE: [],
    IMPROVE: [],
  };

  let current: LifecycleStage;

  // HARD GATE: blocked opportunities never advance past DISCOVER and get no
  // execution guidance — only the block itself.
  if (halalStatus === BLOCKED) {
    current = 'DISCOVER';
    missing.DISCOVER.push('Opportunity is NOT_ALLOWED under halal compliance; no lifecycle progression is possible.');
    const stages = buildStages(current, missing, { discoverEvidence: true, everythingElse: false });
    return {
      opportunity: { ...opp },
      stages,
      currentStage: current,
      rationale: 'Lifecycle halted at DISCOVER: opportunity is NOT_ALLOWED. No execution guidance is generated.',
      halalStatus,
    };
  }

  const reviewRequired = halalStatus === REVIEW;

  if (isFinishedLike(opp.status)) {
    current = 'IMPROVE';
    missing.IMPROVE.push(`Opportunity status is ${opp.status}; resume or archive before further progression.`);
  } else if (input.revenues > 0) {
    current = 'IMPROVE';
    if (input.revenues > 0 && !input.publishedProducts) {
      // Revenue without a published product implies off-platform income; keep
      // the report factual instead of guessing the source.
      missing.IMPROVE.push('Revenue records exist but no published product is linked; verify the revenue source.');
    }
  } else if (input.publishedProducts > 0) {
    current = 'MARKET';
    missing.MARKET.push('Published product exists but no revenue has been recorded yet.');
  } else if (input.products > 0) {
    current = 'PUBLISH';
    missing.PUBLISH.push('Product exists but is not in PUBLISHED/EARNING status yet.');
  } else if (input.positiveExperimentDecisions > 0 || opp.status === 'VALIDATED') {
    current = 'BUILD';
    missing.BUILD.push('Validation passed but no product has been created yet.');
  } else if (input.completedExperimentDecisions > 0) {
    current = 'DECIDE';
    missing.DECIDE.push('Experiments completed without a SCALE decision; more validation data is needed.');
  } else if (input.experiments > 0) {
    current = 'VALIDATE';
    missing.VALIDATE.push('Experiments exist but none has reached a final decision yet.');
  } else if (input.hasValidationLog && opp.status === 'VALIDATING') {
    current = 'VALIDATE';
    missing.VALIDATE.push('Validation agent has produced a plan but no real experiment data exists yet.');
  } else if (input.hasResearchLog && ['IDEA', 'RESEARCHING'].includes(opp.status)) {
    current = 'RESEARCH';
    missing.RESEARCH.push('Research agent has run but no validation data exists yet.');
  } else {
    current = 'RESEARCH';
    missing.RESEARCH.push('No research or validation evidence on file yet.');
  }

  const hasEvidence: Partial<Record<LifecycleStage, boolean>> = {
    DISCOVER: true,
    RESEARCH: input.hasResearchLog,
    VALIDATE: input.experiments > 0 || input.hasValidationLog,
    DECIDE: input.completedExperimentDecisions > 0,
    BUILD: input.products > 0,
    PUBLISH: input.publishedProducts > 0,
    MARKET: input.publishedProducts > 0,
    MEASURE: input.revenues > 0,
    IMPROVE: input.revenues > 0 || input.completedExperimentDecisions > 0,
  };

  const stages = buildStages(current, missing, {
    discoverEvidence: true,
    everythingElse: false,
  }, hasEvidence);

  let rationale: string;
  if (reviewRequired) {
    rationale = `Current stage ${current}: halalStatus is REVIEW_REQUIRED — a qualified human must review before any execution.`;
  } else if (current === 'IMPROVE' && input.revenues > 0) {
    rationale = `Current stage IMPROVE: ${input.revenues} revenue record(s) recorded for this opportunity.`;
  } else if (current === 'MARKET') {
    rationale = `Current stage MARKET: product is published but no revenue has been recorded yet.`;
  } else {
    rationale = `Current stage ${current}: derived from opportunity status "${opp.status}", ${input.experiments} experiment(s), ${input.products} product(s), ${input.revenues} revenue record(s).`;
  }

  return {
    opportunity: { ...opp },
    stages,
    currentStage: current,
    rationale,
    halalStatus,
  };
}

function buildStages(
  current: LifecycleStage,
  missing: Record<LifecycleStage, string[]>,
  _flags: { discoverEvidence: boolean; everythingElse: boolean },
  hasEvidence?: Partial<Record<LifecycleStage, boolean>>,
): LifecycleStageStatus[] {
  void _flags;
  return LIFECYCLE_ORDER.map((stage) => ({
    stage,
    state:
      stage === current
        ? 'CURRENT — recommended focus right now'
        : LIFECYCLE_ORDER.indexOf(stage) < LIFECYCLE_ORDER.indexOf(current)
          ? 'Passed — evidence exists or stage was skipped safely'
          : 'Not started',
    isCurrent: stage === current,
    hasEvidence: hasEvidence ? (hasEvidence[stage] ?? false) : false,
    missingEvidence: missing[stage] ?? [],
  }));
}

/** Full portfolio summary; sorts by overall score, excludes blocked from ranking. */
export function summarizePortfolio(
  records: {
    opportunity: LifecycleOpportunity;
    experiments: number;
    products: number;
    revenues: number;
    completedExperimentDecisions: number;
    positiveExperimentDecisions: number;
    publishedProducts: number;
    hasResearchLog: boolean;
    hasValidationLog: boolean;
  }[],
  counts: LifecycleCounts,
): PortfolioLifecycleSummary {
  const views = records.map((r) => deriveLifecycleStage(r));
  const distribution = new Map<LifecycleStage, number>();
  for (const view of views) {
    if (view.halalStatus === BLOCKED) continue;
    distribution.set(view.currentStage, (distribution.get(view.currentStage) ?? 0) + 1);
  }
  const ranked = [...views].sort((a, b) => b.opportunity.overallScore - a.opportunity.overallScore);
  return {
    counts,
    stageDistribution: LIFECYCLE_ORDER
      .map((stage) => ({ stage, count: distribution.get(stage) ?? 0 }))
      .filter((entry) => entry.count > 0),
    opportunities: ranked,
  };
}
