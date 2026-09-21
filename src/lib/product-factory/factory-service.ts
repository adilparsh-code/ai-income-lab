// Server-only Product Factory service.
//
// The factory is a thin, halal-gated composition over the EXISTING bounded
// pipeline: it does NOT reimplement research, validation, or product logic. It
// only narrows the run to the three stages the factory consumes
// (RESEARCH → VALIDATION → PRODUCT), forwards user hints to the Product Agent,
// enriches validation with the real evidence chain from the Real Research
// Engine (via the existing AgentLog/EvidenceItemModel store), and attaches a
// deterministic Business Intelligence snapshot for the linked opportunity.
//
// Provenance rules (unchanged from the underlying layers):
// - VERIFIED_DATA only ever describes fetched+validated external sources or
//   records read from the database.
// - Everything the AI produced stays AI_INFERENCE; deterministic fallbacks are
//   MOCKED. Nothing here upgrades either.
// - The BI snapshot is computed by the SHARED profitability layer (the exact
//   function the Business Manager decision engine consumes) from stored
//   revenue records — never invented, never AI-authored.
// - NOT_ALLOWED hard-blocks before any stage (runPipeline handles this); no
//   agent or AI provider is invoked for prohibited work.
//
// Dependency injection: every DB touchpoint goes through the narrow FactoryDb
// interface below (default: the real Prisma client). Tests inject fakes to
// stay hermetic — no DB, no network, no AI.

import { db } from '@/lib/db';
import { runPipeline } from '@/lib/ruflo/orchestrator';
import type { PipelineRequest, PipelineRunResult } from '@/lib/ruflo/orchestrator';
import { buildProfitabilityDecisionFacts } from '@/lib/business/business-manager-profitability';
import { logger } from '@/lib/server-log';

// ---------------------------------------------------------------------------
// Injectable DB surface (narrow, structural — the real client satisfies it)
// ---------------------------------------------------------------------------

export interface FactoryOpportunityRow {
  id: string;
  title: string;
  problemSolved?: string | null;
  estimatedStartupCost?: number;
}

export interface FactoryRevenueRow {
  grossRevenue: number;
  fees: number;
  advertisingCost: number;
  otherCosts: number;
  netRevenue: number;
  /** Scalar column on real Revenue rows; the BI layer filters on it. */
  opportunityId?: string | null;
}

export interface FactoryEvidenceRow {
  url: string;
  domain: string;
  title: string;
  evidenceType: string;
  excerpt: string | null;
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  fetchedAt: Date;
}

export interface FactoryRunRow {
  id: string;
  result: string;
  opportunityId: string | null;
}

export interface FactoryDb {
  opportunity: {
    findUnique(args: { where: { id: string } }): Promise<FactoryOpportunityRow | null>;
  };
  revenue: {
    findMany(args: { where: { opportunityId: string } }): Promise<FactoryRevenueRow[]>;
  };
  pipelineRun: {
    findUnique(args: { where: { id: string } }): Promise<FactoryRunRow | null>;
    update(args: { where: { id: string }; data: { result: string } }): Promise<unknown>;
  };
  evidenceItemModel: {
    findMany(args: {
      where: { opportunityId: string };
      orderBy: { fetchedAt: 'desc' };
      take: number;
    }): Promise<FactoryEvidenceRow[]>;
  };
}

/**
 * The real Prisma client cast to the narrow structural surface. The cast is
 * safe: every delegate/method used by this module exists with compatible
 * input/output shapes.
 */
const defaultDb = db as unknown as FactoryDb;

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/** The factory consumes exactly these stages, in canonical order. */
const FACTORY_STAGES = ['RESEARCH', 'VALIDATION', 'PRODUCT'] as const;

const VALID_PRODUCT_TYPES = [
  'DIGITAL_PRODUCT', 'SAAS', 'WEB_APP', 'MOBILE_APP',
  'TEMPLATE', 'PRINTABLE', 'COURSE', 'TOOL', 'SERVICE_PRODUCT',
] as const;

const VALID_MONETIZATION_MODELS = [
  'ONE_TIME_PURCHASE', 'SUBSCRIPTION', 'FREEMIUM',
  'SERVICE', 'LICENSE', 'AFFILIATE', 'AD_SUPPORTED',
] as const;

export interface ProductFactoryRequest {
  opportunityId?: string;
  objective?: string;
  productType?: string;
  monetizationPreference?: string;
  constraints?: string[];
}

export interface ProductFactoryOutcome {
  ok: boolean;
  /** User-facing, safe error (never leaks internals/secrets). */
  error?: string;
  run?: PipelineRunResult;
  /** Stage whose agent-level validation rejected the request, if any. */
  failedStage?: string;
}

/**
 * Generate a product factory result from an opportunity (or free-form
 * objective). Halal gating, agent execution, provenance, and run persistence
 * are owned by runPipeline; this wrapper adds factory-specific wiring only.
 */
export async function runProductFactory(
  request: ProductFactoryRequest,
  deps: FactoryDb = defaultDb,
): Promise<ProductFactoryOutcome> {
  const productType = request.productType?.trim().toUpperCase();
  const monetization = request.monetizationPreference?.trim().toUpperCase();

  if (productType && !(VALID_PRODUCT_TYPES as readonly string[]).includes(productType)) {
    return { ok: false, error: `Unsupported product type: ${productType}` };
  }
  if (monetization && !(VALID_MONETIZATION_MODELS as readonly string[]).includes(monetization)) {
    return { ok: false, error: `Unsupported monetization model: ${monetization}` };
  }

  let objective = request.objective?.trim() ?? '';
  if (!objective && request.opportunityId) {
    try {
      const opportunity = await deps.opportunity.findUnique({
        where: { id: request.opportunityId },
      });
      if (!opportunity) {
        return { ok: false, error: `Opportunity "${request.opportunityId}" was not found.` };
      }
      objective = opportunity.problemSolved
        ? `Design a product for: ${opportunity.title} — ${opportunity.problemSolved}`
        : `Design a product for: ${opportunity.title}`;
    } catch (error) {
      logger.error('Product Factory could not load opportunity for objective', error, {
        opportunityId: request.opportunityId,
      });
      return { ok: false, error: 'The opportunity could not be loaded from the database. Try again.' };
    }
  }

  if (!objective) {
    return { ok: false, error: 'Select an opportunity or provide an objective to generate a product concept.' };
  }

  const pipelineRequest: PipelineRequest = {
    opportunityId: request.opportunityId,
    objective,
    stages: [...FACTORY_STAGES],
    ...(productType ? { productType } : {}),
    ...(monetization ? { monetizationPreference: monetization } : {}),
  };

  let run: PipelineRunResult;
  try {
    run = await runPipeline(pipelineRequest);
  } catch (error) {
    logger.error('Product Factory pipeline execution failed', error);
    return { ok: false, error: 'Product generation failed due to an unexpected error. Check the server logs or try again.' };
  }

  run = await attachAndPersistBiSnapshot(deps, run);

  // runPipeline resolves stages itself, but a defensive check keeps the
  // contract explicit: a failed RESEARCH stage is a failed factory run.
  const researchStep = run.steps.find((s) => s.stage === 'RESEARCH');
  if (researchStep && !researchStep.success && run.status !== 'BLOCKED' && run.status !== 'HUMAN_REVIEW') {
    return {
      ok: false,
      error: 'Product generation failed during the research stage. No concept was produced.',
      run,
      failedStage: 'RESEARCH',
    };
  }

  return { ok: true, run };
}

// ---------------------------------------------------------------------------
// Business Intelligence snapshot (opportunity-scoped, deterministic)
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic profitability snapshot for the linked opportunity
 * via the SHARED BI layer (`buildProfitabilityDecisionFacts` — the exact
 * function the Business Manager decision engine consumes). All figures come
 * from stored revenue records; nothing is invented. An empty database yields
 * explicit NO_DATA facts — never zeros dressed up as verified results.
 */
async function loadOpportunityBi(deps: FactoryDb, opportunityId: string): Promise<unknown> {
  try {
    const [opportunity, revenues] = await Promise.all([
      deps.opportunity.findUnique({ where: { id: opportunityId } }),
      deps.revenue.findMany({ where: { opportunityId } }),
    ]);
    if (!opportunity) return null;

    const facts = buildProfitabilityDecisionFacts({
      opportunity: {
        id: opportunity.id,
        title: opportunity.title,
        estimatedStartupCost: opportunity.estimatedStartupCost ?? 0,
      },
      revenues,
    });
    return {
      opportunityId: opportunity.id,
      opportunityTitle: opportunity.title,
      facts: { ...facts, recordCount: revenues.length },
    };
  } catch (error) {
    logger.warn('Factory BI snapshot failed; continuing without profitability data', {
      error: String(error).slice(0, 150),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run wrapping (persist findings additions + wrap for the action layer)
// ---------------------------------------------------------------------------

/**
 * Attach the live BI snapshot to the in-memory result AND persist the same
 * snapshot into the stored findings so rehydrated history shows identical
 * verified data. Persistence is best-effort: if it fails, the run record
 * keeps its pipeline-authored payload (honest fallback — the UI just shows no
 * BI section). Runs without an opportunity (free-form objective) get none.
 */
async function attachAndPersistBiSnapshot(
  deps: FactoryDb,
  run: PipelineRunResult,
): Promise<PipelineRunResult> {
  if (!run.opportunityId) return run;

  const snapshot = await loadOpportunityBi(deps, run.opportunityId);
  if (!snapshot) return run;

  const liveRun: PipelineRunResult = {
    ...run,
    findings: { ...run.findings, businessIntelligence: snapshot },
  };

  if (run.runId) {
    try {
      const stored = await deps.pipelineRun.findUnique({ where: { id: run.runId } });
      if (stored) {
        const parsed = JSON.parse(stored.result) as { findings?: unknown };
        if (
          parsed &&
          typeof parsed === 'object' &&
          parsed.findings &&
          typeof parsed.findings === 'object' &&
          !Array.isArray(parsed.findings)
        ) {
          const nextResult = {
            ...parsed,
            findings: {
              ...(parsed.findings as Record<string, unknown>),
              businessIntelligence: snapshot,
            },
          };
          await deps.pipelineRun.update({
            where: { id: run.runId },
            data: { result: JSON.stringify(nextResult) },
          });
        }
      }
    } catch (error) {
      logger.warn('Factory BI snapshot could not be persisted onto the run record', {
        error: String(error).slice(0, 150),
      });
    }
  }

  return liveRun;
}

// ---------------------------------------------------------------------------
// Evidence-chain enrichment (reuses the existing AgentLog + research mapping)
// ---------------------------------------------------------------------------

/**
 * Read EvidenceItemModel rows recorded for this opportunity by earlier
 * research runs. Every row keeps its own stored evidenceType: rows written by
 * the Real Research Engine are VERIFIED_DATA (fetched) or SEARCH_DISCOVERY
 * (search metadata). This function never relabels them.
 */
async function loadStoredEvidenceSources(
  deps: FactoryDb,
  opportunityId: string,
): Promise<{ sources?: unknown } | null> {
  const rows = await deps.evidenceItemModel.findMany({
    where: { opportunityId },
    orderBy: { fetchedAt: 'desc' },
    take: 20,
  });
  if (rows.length === 0) return null;

  const sources = rows
    .filter((row) => row.evidenceType === 'VERIFIED_DATA' || row.evidenceType === 'SEARCH_DISCOVERY')
    .map((row) => ({
      url: row.url,
      domain: row.domain,
      title: row.title,
      evidenceType: row.evidenceType,
      retrievedAt: row.fetchedAt.toISOString(),
      ...(row.evidenceType === 'SEARCH_DISCOVERY' ? {} : {
        excerpt: row.excerpt,
        httpStatus: row.httpStatus ?? undefined,
        contentType: row.contentType ?? undefined,
        contentLength: row.contentLength ?? undefined,
      }),
    }));

  return sources.length > 0 ? { sources } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSources(existing: unknown, stored: unknown): unknown[] {
  const byUrl = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(existing) ? existing : []) {
    if (isRecord(raw) && typeof raw.url === 'string') byUrl.set(raw.url, raw);
  }
  for (const raw of Array.isArray(stored) ? stored : []) {
    if (isRecord(raw) && typeof raw.url === 'string' && !byUrl.has(raw.url)) {
      byUrl.set(raw.url, raw);
    }
  }
  return [...byUrl.values()];
}

/**
 * Load the full external evidence chain recorded by the research step
 * (including cached items the run may not have refetched) and merge it into
 * the run's step outputs so the UI shows the COMPLETE evidence chain, not
 * just the subset re-collected in the last pass.
 */
async function enrichWithStoredEvidence(
  deps: FactoryDb,
  run: PipelineRunResult,
): Promise<PipelineRunResult> {
  if (!run.opportunityId) return run;

  const researchStep = run.steps.find((s) => s.stage === 'RESEARCH');
  // Persisted payloads store PipelineStepResult wrappers (summary.output);
  // tolerate bare summaries defensively so corrupt/partial records fail
  // gracefully instead of breaking rehydration.
  const stepRecord = researchStep as unknown as { summary?: unknown } | undefined;
  const summaryRecord =
    stepRecord && isRecord(stepRecord.summary)
      ? (stepRecord.summary as Record<string, unknown>)
      : isRecord(researchStep)
        ? (researchStep as unknown as Record<string, unknown>)
        : null;
  const output = isRecord(summaryRecord?.output) ? summaryRecord.output : null;
  const existing = output;
  const opportunityId = run.opportunityId;

  let stored: { sources?: unknown } | null = null;
  try {
    stored = await loadStoredEvidenceSources(deps, opportunityId);
  } catch (error) {
    logger.warn('Factory evidence enrichment failed; showing run-only evidence', {
      error: String(error).slice(0, 150),
    });
  }

  if (!stored) return run;

  const merged = {
    ...existing,
    sources: mergeSources(existing?.sources, stored.sources),
  } as Record<string, unknown>;

  const steps = run.steps.map((step) => {
    if (step.stage !== 'RESEARCH') return step;
    const stepRecord = step as unknown as { summary?: unknown };
    if (stepRecord.summary && typeof stepRecord.summary === 'object') {
      return {
        ...step,
        summary: {
          ...(stepRecord.summary as Record<string, unknown>),
          output: merged,
        },
      } as typeof step;
    }
    // Bare-summary shape (defensive): treat the step itself as the summary.
    return { ...step, summary: merged } as unknown as typeof step;
  });
  return { ...run, steps };
}

// ---------------------------------------------------------------------------
// Rehydration (persisted run payload → full result)
// ---------------------------------------------------------------------------

/**
 * Rehydrate a persisted PipelineRun (JSON payload) back into a
 * PipelineRunResult, enriching the evidence chain with stored sources and
 * attaching the deterministic BI snapshot. Corrupt payloads surface as null —
 * callers must handle that honestly.
 */
export async function rehydrateFactoryRun(
  runId: string,
  deps: FactoryDb = defaultDb,
): Promise<{ runId: string; run: PipelineRunResult } | null> {
  let row: FactoryRunRow | null = null;
  try {
    row = await deps.pipelineRun.findUnique({ where: { id: runId } });
  } catch (error) {
    logger.error('Factory run lookup failed', error, { runId });
    return null;
  }
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.result) as PipelineRunResult;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) return null;
    const run = await enrichWithStoredEvidence(deps, {
      ...parsed,
      opportunityId: row.opportunityId ?? undefined,
    });
    return { runId: row.id, run: await attachAndPersistBiSnapshot(deps, { ...run, runId: row.id }) };
  } catch (error) {
    logger.error('Factory run payload could not be parsed', error, { runId });
    return null;
  }
}
