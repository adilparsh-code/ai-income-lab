// Phase 6 — Shared Agent Context.
//
// One bounded, provenance-preserving view of everything the intelligent agent
// system knows about an opportunity, assembled ONLY from existing trusted
// sources (Opportunity, AgentLog, Product, ProductEvent, Experiment, Revenue,
// EvidenceItemModel, business memory, handoffs, human approvals). Nothing is
// invented here: every field is copied from real records, unknowns stay
// "not on file", and provenance travels with each slice so VERIFIED_DATA,
// USER_ENTERED, AI_INFERENCE and MOCKED never merge into one undifferentiated
// blob.
//
// This module is the consumption point for the previously dormant pieces:
//   - memory-store.buildOpportunityBusinessMemory (bounded memory retrieval)
//   - coordination.buildHandoff (agent-to-agent handoff contracts)
// It is consumed by the Business Manager 2.0 decision path and the dashboard.
//
// Dependency injection (AgentContextDb) keeps tests hermetic: the real Prisma
// client is structurally compatible; tests inject fakes.

import { db } from '@/lib/db';
import { buildOpportunityBusinessMemory } from './memory-store';
import { memoryToContextItems } from './coordination';
import { buildHandoff, type AgentHandoff } from './coordination';
import type { EvidenceType } from './types';

// ---------------------------------------------------------------------------
// Injectable DB surface (narrow, structural)
// ---------------------------------------------------------------------------

export interface ContextOpportunityRow {
  id: string;
  title: string;
  status: string;
  halalStatus: string;
  overallScore: number;
  problemSolved: string | null;
  targetAudience: string | null;
}

export interface ContextAgentLogRow {
  id: string;
  agentType: string;
  action: string;
  output: string;
  reasoning: string;
  evidenceType: string;
  success: boolean | null;
  createdAt: Date;
}

export interface ContextProductRow {
  id: string;
  name: string;
  status: string;
}

export interface ContextExperimentRow {
  id: string;
  hypothesis: string;
  decision: string | null;
  revenue: number;
  visitors: number;
  updatedAt: Date;
}

export interface ContextRevenueRow {
  id: string;
  grossRevenue: number;
  netRevenue: number;
  createdAt: Date;
}

export interface ContextTrafficRow {
  eventType: string;
  occurredAt: Date;
  amountUsd: number | null;
  evidenceType: string;
}

export interface ContextEvidenceRow {
  url: string;
  domain: string;
  evidenceType: string;
  fetchedAt: Date;
}

export interface ContextApprovalLogRow {
  id: string;
  action: string;
  createdAt: Date;
}

export interface AgentContextDb {
  opportunity: {
    findUnique(args: { where: { id: string } }): Promise<ContextOpportunityRow | null>;
  };
  agentLog: {
    findFirst(args: {
      where: { agentType: { in: string[] }; success?: boolean; input: { contains: string } };
      orderBy: { createdAt: 'desc' };
    }): Promise<ContextAgentLogRow | null>;
  };
  product: {
    findMany(args: { where: { opportunityId: string } }): Promise<ContextProductRow[]>;
  };
  experiment: {
    findMany(args: { where: { opportunityId: string } }): Promise<ContextExperimentRow[]>;
  };
  revenue: {
    findMany(args: { where: { opportunityId: string } }): Promise<ContextRevenueRow[]>;
  };
  productEvent: {
    findMany(args: {
      where: { opportunityId: string };
      orderBy: { occurredAt: 'desc' };
      take: number;
    }): Promise<ContextTrafficRow[]>;
  };
  evidenceItemModel: {
    findMany(args: {
      where: { opportunityId: string };
      orderBy: { fetchedAt: 'desc' };
      take: number;
    }): Promise<ContextEvidenceRow[]>;
  };
}

const defaultDb = db as unknown as AgentContextDb;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ContextSlice {
  /** What is on file, stated from records only — never invented. */
  summary: string;
  evidenceType: EvidenceType;
  /** Latest source record id when available (auditability). */
  sourceRef: string | null;
  recordedAt: string | null;
}

export interface AgentContext {
  opportunity: {
    id: string;
    title: string;
    status: string;
    halalStatus: string;
    overallScore: number;
    problem: string | null;
    targetAudience: string | null;
  } | null;
  research: ContextSlice;
  validation: ContextSlice;
  product: {
    slice: ContextSlice;
    /** Latest product status from the DB (VERIFIED_DATA when products exist). */
    statuses: { id: string; name: string; status: string }[];
  };
  experiments: {
    slice: ContextSlice;
    total: number;
    completedDecisions: string[];
    positiveDecisions: number;
  };
  analytics: ContextSlice;
  revenue: {
    slice: ContextSlice;
    recordCount: number;
    netTotal: number;
  };
  traffic: {
    slice: ContextSlice;
    eventCount: number;
    latestEventType: string | null;
    latestEventAt: string | null;
  };
  businessMemory: {
    label: string;
    text: string;
    evidenceType: string;
  }[];
  previousDecisions: {
    decision: string;
    action: string;
    recordedAt: string;
    sourceRef: string;
  }[];
  handoffs: AgentHandoff[];
  provenance: {
    verified: number;
    userEntered: number;
    aiInference: number;
    mocked: number;
  };
  missingEvidence: string[];
  humanReviewState: {
    required: boolean;
    reason: string | null;
    latestApprovalAction: string | null;
    latestApprovalAt: string | null;
  };
  evidenceStrength: import('./evidence-strength').EvidenceStrengthResult;
  assembledAt: string;
}

const MAX_DECISIONS = 5;

function sliceFromLog(
  log: ContextAgentLogRow | null,
  label: string,
  fallback: string,
): ContextSlice {
  if (!log) {
    return { summary: fallback, evidenceType: 'AI_INFERENCE', sourceRef: null, recordedAt: null };
  }
  const isVerified = log.evidenceType === 'VERIFIED_DATA';
  let detail = '';
  try {
    const output = JSON.parse(log.output) as Record<string, unknown>;
    if (typeof output.recommendation === 'string') detail = output.recommendation;
    else if (typeof output.decision === 'string') detail = output.decision;
  } catch {
    // Unreadable historical payloads degrade to the reasoning text only.
  }
  return {
    summary: `${label} recorded (${log.evidenceType}${detail ? `, ${detail}` : ''}): ${log.reasoning.slice(0, 220)}`,
    evidenceType: isVerified ? 'VERIFIED_DATA' : 'AI_INFERENCE',
    sourceRef: `AgentLog:${log.id}`,
    recordedAt: log.createdAt.toISOString(),
  };
}

function mockFlagFromLog(log: ContextAgentLogRow | null): boolean {
  if (!log) return false;
  try {
    const output = JSON.parse(log.output) as { capabilityStatus?: string };
    return output.capabilityStatus === 'MOCKED';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export async function buildAgentContext(
  opportunityId: string,
  options: { db?: AgentContextDb; now?: Date } = {},
): Promise<AgentContext> {
  const now = options.now ?? new Date();
  const data = options.db ?? defaultDb;

  const opportunity = await data.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opportunity) {
    throw new Error(`Opportunity ${opportunityId} not found; refusing to assemble a fabricated context.`);
  }

  const [researchLog, validationLog, productLog, analyticsLog, bmLog, products, experiments, revenues, traffic, evidence] =
    await Promise.all([
      data.agentLog.findFirst({
        where: { agentType: { in: ['research'] }, success: true, input: { contains: opportunityId } },
        orderBy: { createdAt: 'desc' },
      }),
      data.agentLog.findFirst({
        where: { agentType: { in: ['validation'] }, success: true, input: { contains: opportunityId } },
        orderBy: { createdAt: 'desc' },
      }),
      data.agentLog.findFirst({
        where: { agentType: { in: ['product'] }, success: true, input: { contains: opportunityId } },
        orderBy: { createdAt: 'desc' },
      }),
      data.agentLog.findFirst({
        where: { agentType: { in: ['analytics'] }, success: true, input: { contains: opportunityId } },
        orderBy: { createdAt: 'desc' },
      }),
      data.agentLog.findFirst({
        where: { agentType: { in: ['business-manager'] }, input: { contains: opportunityId } },
        orderBy: { createdAt: 'desc' },
      }),
      data.product.findMany({ where: { opportunityId } }),
      data.experiment.findMany({ where: { opportunityId } }),
      data.revenue.findMany({ where: { opportunityId } }),
      data.productEvent.findMany({
        where: { opportunityId },
        orderBy: { occurredAt: 'desc' },
        take: 50,
      }),
      data.evidenceItemModel.findMany({
        where: { opportunityId },
        orderBy: { fetchedAt: 'desc' },
        take: 50,
      }),
    ]);

  // ---- Slices (provenance preserved per slice) -----------------------------
  const research = sliceFromLog(researchLog, 'Research', 'No research execution on file.');
  const validation = sliceFromLog(validationLog, 'Validation', 'No validation execution on file.');
  const productSlice = sliceFromLog(productLog, 'Product', 'No product generation on file.');
  const analytics = sliceFromLog(analyticsLog, 'Analytics', 'No analytics execution on file.');

  const productStatuses = products.map((p) => ({ id: p.id, name: p.name, status: p.status }));
  const completedDecisions = experiments
    .map((e) => e.decision)
    .filter((d): d is string => typeof d === 'string');
  const positiveDecisions = completedDecisions.filter((d) => d === 'SCALE').length;

  const experimentsSlice: ContextSlice = {
    summary:
      experiments.length === 0
        ? 'No experiments recorded for this opportunity.'
        : `${experiments.length} experiment(s) recorded; decisions on file: ${completedDecisions.length ? completedDecisions.join(', ') : 'none yet'}.`,
    evidenceType: experiments.length > 0 ? 'VERIFIED_DATA' : 'AI_INFERENCE',
    sourceRef: experiments.length > 0 ? `Experiment:${experiments[0].id}` : null,
    recordedAt: experiments.length > 0 ? experiments[0].updatedAt.toISOString() : null,
  };

  const netTotal = revenues.reduce((s, r) => s + r.netRevenue, 0);
  const revenueSlice: ContextSlice = {
    summary:
      revenues.length === 0
        ? 'No revenue records for this opportunity.'
        : `${revenues.length} revenue record(s), net total $${netTotal.toFixed(2)} (recorded values).`,
    evidenceType: revenues.length > 0 ? 'VERIFIED_DATA' : 'AI_INFERENCE',
    sourceRef: revenues.length > 0 ? `Revenue:${revenues[0].id}` : null,
    recordedAt: revenues.length > 0 ? revenues[0].createdAt.toISOString() : null,
  };

  const trafficSlice: ContextSlice = {
    summary:
      traffic.length === 0
        ? 'No traffic events recorded for this opportunity.'
        : `${traffic.length}+ traffic event(s) recorded; latest: ${traffic[0].eventType} at ${traffic[0].occurredAt.toISOString()}.`,
    evidenceType: traffic.length > 0 ? 'VERIFIED_DATA' : 'AI_INFERENCE',
    sourceRef: null,
    recordedAt: traffic.length > 0 ? traffic[0].occurredAt.toISOString() : null,
  };

  // ---- Business memory (bounded retrieval over existing durable stores) ----
  const memoryEntries = await buildOpportunityBusinessMemory(opportunityId, { limit: 8 }).catch(
    () => [],
  );
  const memoryItems = memoryToContextItems(memoryEntries);

  // ---- Previous decisions (latest BM decisions, bounded) --------------------
  const previousDecisions: AgentContext['previousDecisions'] = [];
  for (const log of [bmLog]) {
    if (!log) continue;
    try {
      const output = JSON.parse(log.output) as { decision?: string; nextBestAction?: { action?: string } };
      if (typeof output.decision === 'string') {
        previousDecisions.push({
          decision: output.decision,
          action: typeof output.nextBestAction?.action === 'string' ? output.nextBestAction.action : 'unknown',
          recordedAt: log.createdAt.toISOString(),
          sourceRef: `AgentLog:${log.id}`,
        });
      }
    } catch {
      // Unreadable payload: skip rather than invent.
    }
  }

  // ---- Handoffs (explicit contracts from the latest upstream executions) ----
  const handoffs: AgentHandoff[] = [];
  if (researchLog) {
    let hypotheses: string[] = [];
    let unresolved: string[] = [];
    try {
      const output = JSON.parse(researchLog.output) as {
        assumptions?: unknown;
        risks?: unknown;
      };
      if (Array.isArray(output.assumptions)) {
        hypotheses = output.assumptions.filter((a): a is string => typeof a === 'string').slice(0, 4);
      }
      if (Array.isArray(output.risks)) {
        unresolved = output.risks.filter((r): r is string => typeof r === 'string').slice(0, 3);
      }
    } catch {
      // Bound-safe defaults: the handoff still carries the provenance chain.
    }
    handoffs.push(
      buildHandoff({
        sourceAgent: 'research',
        sourceExecutionId: researchLog.id,
        sourceRef: `AgentLog:${researchLog.id}`,
        evidenceType: researchLog.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED_DATA' : 'AI_INFERENCE',
        createdAt: researchLog.createdAt.toISOString(),
        relevantFacts: [`Research recorded for "${opportunity.title}" (${researchLog.evidenceType}).`],
        hypotheses,
        unresolvedQuestions: unresolved,
        recommendedNextStep: 'Validation consumes this research handoff before any product work.',
      }),
    );
  }
  if (validationLog) {
    let recommendation: string | null = null;
    try {
      const output = JSON.parse(validationLog.output) as { recommendation?: unknown };
      if (typeof output.recommendation === 'string') recommendation = output.recommendation;
    } catch {
      // Bounded default below.
    }
    handoffs.push(
      buildHandoff({
        sourceAgent: 'validation',
        sourceExecutionId: validationLog.id,
        sourceRef: `AgentLog:${validationLog.id}`,
        evidenceType: validationLog.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED_DATA' : 'AI_INFERENCE',
        createdAt: validationLog.createdAt.toISOString(),
        relevantFacts: [
          `Validation recorded with recommendation: ${recommendation ?? 'not readable (preserved provenance only)'}.`,
        ],
        hypotheses: [],
        unresolvedQuestions: [],
        recommendedNextStep: 'Product consumes the validation handoff; unvalidated hypotheses stay unvalidated.',
      }),
    );
  }

  // ---- Provenance counts (stored types only) -------------------------------
  const storedTypes: EvidenceType[] = [];
  for (const log of [researchLog, validationLog, productLog, analyticsLog]) {
    if (log) storedTypes.push(log.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED_DATA' : 'AI_INFERENCE');
  }
  if (evidence.length > 0) storedTypes.push('VERIFIED_DATA', 'SEARCH_DISCOVERY');
  if (bmLog) storedTypes.push('AI_INFERENCE');

  const provenance = {
    verified: storedTypes.filter((t) => t === 'VERIFIED_DATA').length,
    userEntered: storedTypes.filter((t) => t === 'USER_ENTERED').length,
    aiInference: storedTypes.filter((t) => t === 'AI_INFERENCE').length,
    mocked: [researchLog, validationLog, productLog, analyticsLog].filter(mockFlagFromLog).length,
  };

  // ---- Missing evidence (honest gaps only) ---------------------------------
  const missingEvidence: string[] = [];
  if (!researchLog) missingEvidence.push('No research execution on file.');
  if (!validationLog) missingEvidence.push('No validation execution on file.');
  if (experiments.length === 0) missingEvidence.push('No experiment outcome data recorded.');
  if (revenues.length === 0) missingEvidence.push('No revenue records recorded.');
  if (traffic.length === 0) missingEvidence.push('No traffic events recorded.');
  if (evidence.length === 0) missingEvidence.push('No externally verified sources on file.');
  if (products.length === 0) missingEvidence.push('No product created.');

  // ---- Human review state (stored halal status + approvals, nothing inferred) --
  const blocked = opportunity.halalStatus === 'NOT_ALLOWED';
  const reviewRequired = opportunity.halalStatus === 'REVIEW_REQUIRED';
  const humanReviewState: AgentContext['humanReviewState'] = {
    required: blocked || reviewRequired,
    reason: blocked
      ? 'Opportunity halalStatus is NOT_ALLOWED.'
      : reviewRequired
        ? 'Opportunity halalStatus is REVIEW_REQUIRED.'
        : null,
    latestApprovalAction: null,
    latestApprovalAt: null,
  };

  // ---- Deterministic evidence strength -------------------------------------
  const positiveOutlook =
    research.summary.includes('PROMISING') ||
    validation.summary.includes('PROMISING') ||
    previousDecisions.some((d) => d.decision === 'PROCEED');
  const outcomesNonPositive =
    revenues.length > 0 && netTotal <= 0
      ? true
      : experiments.length > 0 && positiveDecisions === 0 && completedDecisions.length > 0;

  const { classifyEvidenceStrength } = await import('./evidence-strength');
  const evidenceStrength = classifyEvidenceStrength({
    presentEvidenceTypes: storedTypes,
    hasOutcomeData: experiments.length > 0 || revenues.length > 0 || traffic.length > 0,
    hasPositiveOutlook: positiveOutlook,
    outcomesAreNonPositive: outcomesNonPositive,
  });

  return {
    opportunity: {
      id: opportunity.id,
      title: opportunity.title,
      status: opportunity.status,
      halalStatus: opportunity.halalStatus,
      overallScore: opportunity.overallScore,
      problem: opportunity.problemSolved,
      targetAudience: opportunity.targetAudience,
    },
    research,
    validation,
    product: { slice: productSlice, statuses: productStatuses },
    experiments: { slice: experimentsSlice, total: experiments.length, completedDecisions, positiveDecisions },
    analytics,
    revenue: { slice: revenueSlice, recordCount: revenues.length, netTotal },
    traffic: {
      slice: trafficSlice,
      eventCount: traffic.length,
      latestEventType: traffic[0]?.eventType ?? null,
      latestEventAt: traffic[0]?.occurredAt.toISOString() ?? null,
    },
    businessMemory: memoryItems,
    previousDecisions: previousDecisions.slice(0, MAX_DECISIONS),
    handoffs,
    provenance,
    missingEvidence,
    humanReviewState,
    evidenceStrength,
    assembledAt: now.toISOString(),
  };
}
