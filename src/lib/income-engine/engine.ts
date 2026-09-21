// Phase 7 — Real Income Execution Engine (core).
//
// Turns the target business loop into an executable, auditable state machine
// per opportunity, composed ENTIRELY from existing layers (no duplicated
// logic):
//
//   DISCOVER → RESEARCH → VALIDATE → DECIDE → BUILD → PUBLISH →
//   TRAFFIC → CONVERT → REVENUE → ANALYZE → LEARN → (repeat via IMPROVE)
//
//   stage derivation   → EXISTING deriveLifecycleStage (Phase 4.2.4)
//   stage execution    → EXISTING runJob (idempotency, halal gates, retries)
//   build/publish      → EXISTING factory jobs (PRODUCT_CREATE/DEPLOY/PUBLISH)
//   traffic/convert    → EXISTING /api/events + /api/revenue ingestion rules
//   analyze/learn      → EXISTING deterministic profitability + memory layers
//
// Safety invariants (unchanged from the underlying layers):
//   - NOT_ALLOWED hard-blocks before any job dispatch (runJob + lifecycle).
//   - REVIEW_REQUIRED stops at HUMAN_REVIEW; no autonomous approval.
//   - PUBLISH is human-gated: without a humanApprovalToken the underlying
//     boundary refuses (NOT_AUTHORIZED / PUBLISHING_UNAVAILABLE) and the loop
//     records that refusal honestly.
//   - Nothing is fabricated: every stage state names the real records it is
//     derived from; missing data is reported, never invented.
//   - The engine never touches Target95/GoldWatcher-style external systems;
//     publishing/spending stay behind explicit human approval.

import { db } from '@/lib/db';
import { runJob } from '@/lib/jobs/job-runner';
import type { JobOutcome, JobType } from '@/lib/jobs/types';
import { buildOpportunityBusinessMemory } from '@/lib/agents/memory-store';
import {
  deriveLifecycleStage,
  LIFECYCLE_ORDER,
  type LifecycleStage,
} from '@/lib/ruflo/lifecycle';
import { logger } from '@/lib/server-log';

// ---------------------------------------------------------------------------
// Loop state (derived from real records only)
// ---------------------------------------------------------------------------

export type LoopStage =
  | 'DISCOVER' | 'RESEARCH' | 'VALIDATE' | 'DECIDE' | 'BUILD' | 'PUBLISH'
  | 'TRAFFIC' | 'CONVERT' | 'REVENUE' | 'ANALYZE' | 'LEARN';

export const LOOP_ORDER: LoopStage[] = [
  'DISCOVER', 'RESEARCH', 'VALIDATE', 'DECIDE', 'BUILD', 'PUBLISH',
  'TRAFFIC', 'CONVERT', 'REVENUE', 'ANALYZE', 'LEARN',
];

export interface IncomeLoopState {
  opportunity: {
    id: string;
    title: string;
    status: string;
    halalStatus: string;
    overallScore: number;
  } | null;
  halalGate: {
    status: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
    blocked: boolean;
    reviewRequired: boolean;
    reason: string | null;
  };
  currentStage: LoopStage | null;
  stageIndex: number;
  stages: {
    stage: LoopStage;
    complete: boolean;
    evidence: string;
    evidenceType: 'VERIFIED_DATA' | 'AI_INFERENCE' | 'NONE';
  }[];
  /** Deterministic, stage-specific blocker when the loop cannot advance. */
  advanceBlocker: string | null;
  productId: string | null;
  metrics: {
    experiments: number;
    positiveDecisions: number;
    completedDecisions: number;
    products: number;
    publishedProducts: number;
    trafficEvents: number;
    revenueRecords: number;
    netRevenue: number;
    learningsRecorded: number;
  };
  dataMode: 'LIVE_DATA' | 'NO_DATA';
  generatedAt: string;
}

const JOB_FOR_STAGE: Partial<Record<LoopStage, JobType>> = {
  RESEARCH: 'RESEARCH',
  VALIDATE: 'VALIDATION',
  DECIDE: 'VALIDATION',
  BUILD: 'PRODUCT_CREATE',
  PUBLISH: 'PRODUCT_PUBLISH',
  ANALYZE: 'ANALYTICS',
};

async function loadLoopInputs(opportunityId: string) {
  const opportunity = await db.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opportunity) return null;

  const [experiments, products, revenues, trafficEvents, researchLog, validationLog] = await Promise.all([
    db.experiment.findMany({
      where: { opportunityId },
      select: { id: true, decision: true, visitors: true, sales: true, revenue: true },
    }),
    db.product.findMany({
      where: { opportunityId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, status: true },
    }),
    db.revenue.findMany({
      where: { opportunityId },
      select: { netRevenue: true },
    }),
    db.productEvent.count({ where: { opportunityId } }),
    db.agentLog.findFirst({
      where: { agentType: 'research', success: true, input: { contains: opportunityId } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    db.agentLog.findFirst({
      where: { agentType: 'validation', success: true, input: { contains: opportunityId } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
  ]);

  const completedDecisions = experiments.filter((e) => ['SCALE', 'KILL'].includes(e.decision ?? '')).length;
  const positiveDecisions = experiments.filter((e) => e.decision === 'SCALE').length;
  const publishedProducts = products.filter((p) => ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status)).length;
  const netRevenue = revenues.reduce((s, r) => s + r.netRevenue, 0);
  const primaryProduct = products[0] ?? null;

  // Learnings: bounded, real memory entries via the existing Phase 5.2 store.
  const memory = await buildOpportunityBusinessMemory(opportunityId, { limit: 6 }).catch(() => []);

  return {
    opportunity,
    experiments,
    completedDecisions,
    positiveDecisions,
    products,
    publishedProducts,
    primaryProduct,
    revenues,
    netRevenue,
    trafficEvents,
    hasResearchLog: researchLog !== null,
    hasValidationLog: validationLog !== null,
    memoryCount: memory.length,
    memory,
  };
}

/** Derive the full loop state for one opportunity. Pure read; never mutates. */
export async function getIncomeLoopState(opportunityId: string): Promise<IncomeLoopState | null> {
  const inputs = await loadLoopInputs(opportunityId);
  if (!inputs) return null;

  const { opportunity } = inputs;
  const halal = opportunity.halalStatus;
  const blocked = halal === 'NOT_ALLOWED';
  const reviewRequired = halal === 'REVIEW_REQUIRED';

  // Reuse the EXISTING lifecycle derivation for the deterministic stage.
  const lifecycle = deriveLifecycleStage({
    opportunity: {
      id: opportunity.id,
      title: opportunity.title,
      status: opportunity.status,
      halalStatus: opportunity.halalStatus,
      overallScore: opportunity.overallScore,
    },
    experiments: inputs.experiments.length,
    products: inputs.products.length,
    revenues: inputs.revenues.length,
    completedExperimentDecisions: inputs.completedDecisions,
    positiveExperimentDecisions: inputs.positiveDecisions,
    publishedProducts: inputs.publishedProducts,
    hasResearchLog: inputs.hasResearchLog,
    hasValidationLog: inputs.hasValidationLog,
  });

  // Map lifecycle stage onto the Phase 7 loop (MARKET/MEASURE/IMPROVE fold
  // into TRAFFIC→REVENUE→LEARN; DECIDE exists in both).
  const stageMap: Record<string, LoopStage> = {
    DISCOVER: 'DISCOVER',
    RESEARCH: 'RESEARCH',
    VALIDATE: 'VALIDATE',
    DECIDE: 'DECIDE',
    BUILD: 'BUILD',
    PUBLISH: 'PUBLISH',
    MARKET: 'TRAFFIC',
    MEASURE: 'REVENUE',
    IMPROVE: 'LEARN',
  };
  let currentStage = stageMap[lifecycle.currentStage] ?? 'RESEARCH';
  // Loop frontier refinement: the deterministic lifecycle keeps an opportunity
  // at RESEARCH until validation artifacts exist or the status changes. Once
  // research evidence is on file, the loop's next actionable stage is
  // VALIDATE — otherwise the loop would stall forever at a completed stage.
  // Deterministic: identical records → identical frontier.
  if (currentStage === 'RESEARCH' && inputs.hasResearchLog) {
    currentStage = 'VALIDATE';
  }

  const stages = LOOP_ORDER.map((stage) => {
    const complete =
      stage === 'DISCOVER' ? true :
      stage === 'RESEARCH' ? inputs.hasResearchLog :
      stage === 'VALIDATE' ? inputs.experiments.length > 0 :
      stage === 'DECIDE' ? inputs.completedDecisions > 0 :
      stage === 'BUILD' ? inputs.products.length > 0 :
      stage === 'PUBLISH' ? inputs.publishedProducts > 0 :
      stage === 'TRAFFIC' ? inputs.trafficEvents > 0 :
      stage === 'CONVERT' ? inputs.experiments.some((e) => e.sales > 0) || inputs.revenues.length > 0 :
      stage === 'REVENUE' ? inputs.revenues.length > 0 :
      stage === 'ANALYZE' ? inputs.revenues.length > 0 || inputs.completedDecisions > 0 :
      /* LEARN */ inputs.memoryCount > 0;
    const evidence =
      stage === 'DISCOVER' ? 'Opportunity record exists.' :
      stage === 'RESEARCH' ? (inputs.hasResearchLog ? 'Research AgentLog on file.' : 'No research execution recorded.') :
      stage === 'VALIDATE' ? (inputs.experiments.length > 0 ? `${inputs.experiments.length} experiment(s) recorded.` : 'No experiments recorded.') :
      stage === 'DECIDE' ? (inputs.completedDecisions > 0 ? `${inputs.completedDecisions} final experiment decision(s) (SCALE/KILL).` : 'No final experiment decision yet.') :
      stage === 'BUILD' ? (inputs.products.length > 0 ? `${inputs.products.length} product(s) created.` : 'No product created.') :
      stage === 'PUBLISH' ? (inputs.publishedProducts > 0 ? `${inputs.publishedProducts} published/earning product(s).` : 'No published product yet.') :
      stage === 'TRAFFIC' ? (inputs.trafficEvents > 0 ? `${inputs.trafficEvents} traffic event(s) ingested.` : 'No traffic events recorded.') :
      stage === 'CONVERT' ? (inputs.experiments.some((e) => e.sales > 0) || inputs.revenues.length > 0 ? 'Conversion (sales) recorded.' : 'No sales/conversions recorded.') :
      stage === 'REVENUE' ? (inputs.revenues.length > 0 ? `$${inputs.netRevenue.toFixed(2)} net revenue recorded.` : 'No revenue records.') :
      stage === 'ANALYZE' ? (inputs.revenues.length > 0 || inputs.completedDecisions > 0 ? 'Deterministic analytics available from recorded outcomes.' : 'No outcome data to analyze.') :
      (inputs.memoryCount > 0 ? `${inputs.memoryCount} bounded memory learning(s) on file.` : 'No learnings recorded yet.');
    const evidenceType: IncomeLoopState['stages'][number]['evidenceType'] =
      stage === 'DISCOVER' || stage === 'RESEARCH' && inputs.hasResearchLog ? 'VERIFIED_DATA' :
      complete ? 'VERIFIED_DATA' :
      (stage === 'RESEARCH' || stage === 'VALIDATE' || stage === 'ANALYZE') ? 'AI_INFERENCE' :
      'NONE';
    return { stage, complete, evidence, evidenceType };
  });

  // Deterministic advance blocker (why the loop cannot/should not advance).
  let advanceBlocker: string | null = null;
  if (blocked) {
    advanceBlocker = 'Opportunity is NOT_ALLOWED; the loop is hard-blocked and no job may run.';
  } else if (reviewRequired) {
    advanceBlocker = 'Opportunity is REVIEW_REQUIRED; a qualified human must review before the loop advances.';
  } else if (
    (currentStage === 'DECIDE' || currentStage === 'BUILD') &&
    inputs.completedDecisions > 0 &&
    inputs.positiveDecisions === 0
  ) {
    // Loop gate: verified-negative validation blocks product building. The
    // lifecycle stage alone is not sufficient here (a VALIDATED status can
    // coexist with a KILL decision) — the recorded decisions are authoritative.
    advanceBlocker =
      'Validation completed WITHOUT a positive (SCALE) decision. Building a product now would mean '
      + 'building on a losing signal — iterate or kill the hypothesis first.';
  } else if (currentStage === 'PUBLISH' && !inputs.primaryProduct) {
    advanceBlocker = 'Publishing requires a product; none exists yet.';
  }

  return {
    opportunity: {
      id: opportunity.id,
      title: opportunity.title,
      status: opportunity.status,
      halalStatus: opportunity.halalStatus,
      overallScore: opportunity.overallScore,
    },
    halalGate: {
      status: (blocked ? 'NOT_ALLOWED' : reviewRequired ? 'REVIEW_REQUIRED' : 'HALAL'),
      blocked,
      reviewRequired,
      reason: lifecycle.rationale,
    },
    currentStage,
    stageIndex: LOOP_ORDER.indexOf(currentStage),
    stages,
    advanceBlocker,
    productId: inputs.primaryProduct?.id ?? null,
    metrics: {
      experiments: inputs.experiments.length,
      positiveDecisions: inputs.positiveDecisions,
      completedDecisions: inputs.completedDecisions,
      products: inputs.products.length,
      publishedProducts: inputs.publishedProducts,
      trafficEvents: inputs.trafficEvents,
      revenueRecords: inputs.revenues.length,
      netRevenue: inputs.netRevenue,
      learningsRecorded: inputs.memoryCount,
    },
    dataMode: inputs.experiments.length + inputs.products.length + inputs.revenues.length + inputs.trafficEvents > 0
      ? 'LIVE_DATA'
      : 'NO_DATA',
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Advance: execute exactly ONE deterministic stage action through runJob
// ---------------------------------------------------------------------------

export type AdvanceStatus =
  | 'DISPATCHED' | 'COMPLETED' | 'BLOCKED' | 'HUMAN_REVIEW' | 'FAILED'
  | 'DEGRADED' | 'SKIPPED_NO_ACTION' | 'AWAITING_HUMAN_INPUT';

export interface AdvanceOutcome {
  ok: boolean;
  status: AdvanceStatus;
  stage: LoopStage | null;
  message: string;
  jobId: string | null;
  jobStatus: string | null;
  deduplicated: boolean;
  /** Compact safe result summary from the underlying job (no payloads). */
  result: Record<string, unknown> | null;
}

/**
 * Execute the current stage's bounded action through the EXISTING job runner.
 * One stage per call — the loop advances only as fast as real evidence is
 * produced, and every dispatch passes through runJob's halal gates.
 */
export async function advanceIncomeLoop(
  opportunityId: string,
  options: { humanApprovalToken?: string; objective?: string } = {},
): Promise<AdvanceOutcome> {
  const state = await getIncomeLoopState(opportunityId);
  if (!state) {
    return { ok: false, status: 'FAILED', stage: null, message: 'Opportunity not found; nothing was executed.', jobId: null, jobStatus: null, deduplicated: false, result: null };
  }
  if (state.halalGate.blocked) {
    return { ok: false, status: 'BLOCKED', stage: state.currentStage, message: state.advanceBlocker ?? 'Blocked.', jobId: null, jobStatus: null, deduplicated: false, result: null };
  }
  if (state.halalGate.reviewRequired) {
    return { ok: false, status: 'HUMAN_REVIEW', stage: state.currentStage, message: state.advanceBlocker ?? 'Human review required before the loop can advance.', jobId: null, jobStatus: null, deduplicated: false, result: null };
  }
  const stage = state.currentStage;
  if (!stage) {
    return { ok: false, status: 'SKIPPED_NO_ACTION', stage: null, message: 'No stage to advance.', jobId: null, jobStatus: null, deduplicated: false, result: null };
  }

  // Loop gate: never build on a losing verified signal (covers DECIDE and
  // BUILD positions; PUBLISH/PUBLISH-adjacent stages were already gated by
  // the same blocker at BUILD).
  if (state.advanceBlocker && (stage === 'DECIDE' || stage === 'BUILD')) {
    return { ok: false, status: 'BLOCKED', stage, message: state.advanceBlocker, jobId: null, jobStatus: null, deduplicated: false, result: null };
  }

  const jobType = JOB_FOR_STAGE[stage];
  if (!jobType) {
    // TRAFFIC / CONVERT / REVENUE / LEARN are human-data stages: the system
    // ingests what really happened; it cannot invent traffic or sales.
    return {
      ok: true,
      status: 'AWAITING_HUMAN_INPUT',
      stage,
      message:
        stage === 'TRAFFIC'
          ? 'Traffic is recorded by real ingestion (POST /api/events). The engine cannot fabricate visitors.'
          : stage === 'CONVERT' || stage === 'REVENUE'
            ? 'Revenue/conversions are recorded by real ingestion (POST /api/revenue). The engine cannot invent sales.'
            : 'Learnings are derived from recorded outcomes; run analytics or record more real data first.',
      jobId: null,
      jobStatus: null,
      deduplicated: false,
      result: null,
    };
  }

  const correlationId = `income-loop:${opportunityId}:${stage}`;
  let payload: Record<string, unknown>;
  switch (stage) {
    case 'RESEARCH':
      payload = {
        opportunityId,
        researchObjective: (options.objective ?? `Research market demand for: ${state.opportunity?.title ?? opportunityId}`).slice(0, 4000),
      };
      break;
    case 'VALIDATE':
    case 'DECIDE':
      payload = {
        opportunityId,
        validationObjective: (options.objective ?? `Design validation experiments and decide for: ${state.opportunity?.title ?? opportunityId}`).slice(0, 4000),
      };
      break;
    case 'BUILD':
      payload = { opportunityId, productType: 'DIGITAL_PRODUCT' };
      break;
    case 'PUBLISH':
      if (!state.productId) {
        return { ok: false, status: 'FAILED', stage, message: 'No product exists to publish.', jobId: null, jobStatus: null, deduplicated: false, result: null };
      }
      payload = { productId: state.productId, channel: 'DIGITAL_PRODUCT', humanApprovalToken: options.humanApprovalToken };
      break;
    case 'ANALYZE':
      payload = { opportunityId, analyticsObjective: `Analyze recorded outcomes for: ${state.opportunity?.title ?? opportunityId}` };
      break;
    default:
      payload = { opportunityId };
  }

  try {
    const outcome: JobOutcome = await runJob(jobType, payload as never, correlationId);
    const status: AdvanceStatus =
      outcome.status === 'SUCCEEDED' ? 'COMPLETED'
      : outcome.status === 'BLOCKED' ? 'BLOCKED'
      : outcome.status === 'HUMAN_REVIEW' ? 'HUMAN_REVIEW'
      : outcome.status === 'DEGRADED' ? 'DEGRADED'
      : outcome.status === 'FAILED' ? 'FAILED'
      : 'DISPATCHED';
    return {
      ok: outcome.status === 'SUCCEEDED' || outcome.status === 'DEGRADED',
      status,
      stage,
      message: stageMessage(stage, outcome),
      jobId: outcome.jobId,
      jobStatus: outcome.status,
      deduplicated: outcome.deduplicated,
      result: outcome.result,
    };
  } catch (error) {
    logger.error('Income loop advance failed', error, { opportunityId, stage });
    return {
      ok: false,
      status: 'FAILED',
      stage,
      message: 'Stage execution failed (storage/runtime error). Nothing was fabricated.',
      jobId: null,
      jobStatus: null,
      deduplicated: false,
      result: null,
    };
  }
}

function stageMessage(stage: LoopStage, outcome: JobOutcome): string {
  if (outcome.deduplicated) return `${stage} already ran for this loop position (idempotent); no duplicate execution.`;
  switch (outcome.status) {
    case 'SUCCEEDED': return `${stage} stage completed through the existing job runner.`;
    case 'BLOCKED': return `${stage} stage was hard-blocked by safety gates. Nothing executed.`;
    case 'HUMAN_REVIEW': return `${stage} stage requires human review. No autonomous execution.`;
    case 'DEGRADED': return `${stage} stage ran in degraded mode (provider unavailable); deterministic fallback used.`;
    default: return `${stage} stage failed. Inspect the job record for the honest error.`;
  }
}

// ---------------------------------------------------------------------------
// Learning: deterministic loop learnings from recorded outcomes
// ---------------------------------------------------------------------------

export interface LoopLearning {
  learning: string;
  evidenceType: 'VERIFIED_DATA' | 'AI_INFERENCE';
  sourceRef: string;
}

/**
 * Derive the loop's current learnings deterministically from REAL outcome
 * data (no AI): validation verdicts, revenue health, traffic reality.
 * These feed future decisions through the existing memory store.
 */
export async function deriveLoopLearnings(opportunityId: string): Promise<LoopLearning[]> {
  const inputs = await loadLoopInputs(opportunityId);
  if (!inputs) return [];
  const learnings: LoopLearning[] = [];

  if (inputs.completedDecisions > 0 && inputs.positiveDecisions === 0) {
    learnings.push({
      learning: 'All completed validation experiments ended without SCALE: the current product hypothesis did not earn real demand. Iterate the offer or kill the line.',
      evidenceType: 'VERIFIED_DATA',
      sourceRef: `Experiment:${inputs.experiments[0]?.id ?? 'n/a'}`,
    });
  }
  if (inputs.positiveDecisions > 0 && inputs.products.length === 0) {
    learnings.push({
      learning: 'Validation reached SCALE but no product was built — the loop is leaving verified demand unmonetized.',
      evidenceType: 'VERIFIED_DATA',
      sourceRef: `Experiment:${inputs.experiments[0]?.id ?? 'n/a'}`,
    });
  }
  if (inputs.products.length > 0 && inputs.publishedProducts === 0 && inputs.trafficEvents === 0) {
    learnings.push({
      learning: 'A product exists but nothing is published and no traffic was recorded: the bottleneck is distribution, not the product.',
      evidenceType: 'VERIFIED_DATA',
      sourceRef: `Product:${inputs.primaryProduct?.id ?? 'n/a'}`,
    });
  }
  if (inputs.publishedProducts > 0 && inputs.trafficEvents > 0 && inputs.revenues.length === 0) {
    learnings.push({
      learning: 'Traffic arrived but produced no recorded revenue: the bottleneck is conversion (offer, pricing, or checkout).',
      evidenceType: 'VERIFIED_DATA',
      sourceRef: `ProductEvent:${inputs.primaryProduct?.id ?? 'n/a'}`,
    });
  }
  if (inputs.revenues.length > 0 && inputs.netRevenue <= 0) {
    learnings.push({
      learning: `Recorded net revenue is $${inputs.netRevenue.toFixed(2)}: unit economics are not contribution-positive. Review fees and costs before scaling.`,
      evidenceType: 'VERIFIED_DATA',
      sourceRef: `Revenue:${inputs.revenues.length} rows`,
    });
  }
  if (inputs.revenues.length > 0 && inputs.netRevenue > 0) {
    learnings.push({
      learning: `Positive net revenue of $${inputs.netRevenue.toFixed(2)} recorded: double down on the working acquisition path and reinvest deliberately.`,
      evidenceType: 'VERIFIED_DATA',
      sourceRef: `Revenue:${inputs.revenues.length} rows`,
    });
  }
  if (learnings.length === 0 && inputs.memory.length > 0) {
    learnings.push({
      learning: 'No decisive outcome data yet; memory entries carry the current context forward.',
      evidenceType: 'AI_INFERENCE',
      sourceRef: 'AgentContext memory',
    });
  }
  return learnings;
}

/** List actionable (non-blocked, non-finished) opportunities for the engine UI. */
export async function getLoopCandidates(limit = 12): Promise<{ id: string; title: string; overallScore: number; status: string; halalStatus: string }[]> {
  const rows = await db.opportunity.findMany({
    where: { status: { notIn: ['REJECTED', 'PAUSED'] }, halalStatus: { not: 'NOT_ALLOWED' } },
    orderBy: { overallScore: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
    select: { id: true, title: true, overallScore: true, status: true, halalStatus: true },
  });
  return rows;
}

/** Re-export for API/UI convenience. */
export { LIFECYCLE_ORDER, type LifecycleStage };
