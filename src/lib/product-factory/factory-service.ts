// Server-only Product Factory service.
//
// The factory is a thin, halal-gated composition over the EXISTING bounded
// pipeline: it does NOT reimplement research, validation, or product logic. It
// only narrows the run to the three stages the factory consumes
// (RESEARCH → VALIDATION → PRODUCT), forwards user hints to the Product Agent,
// and enriches validation with the real evidence chain from the Real Research
// Engine via the existing AgentLog store.
//
// Provenance rules (unchanged from the underlying layers):
// - VERIFIED_DATA only ever describes fetched+validated external sources or
//   records read from the database.
// - Everything the AI produced stays AI_INFERENCE; deterministic fallbacks are
//   MOCKED. Nothing here upgrades either.
// - NOT_ALLOWED hard-blocks before any stage (runPipeline handles this); no
//   agent or AI provider is invoked for prohibited work.

import { db } from '@/lib/db';
import { runPipeline } from '@/lib/ruflo/orchestrator';
import type { PipelineRequest, PipelineRunResult } from '@/lib/ruflo/orchestrator';
import { logger } from '@/lib/server-log';

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
      const opportunity = await db.opportunity.findUnique({
        where: { id: request.opportunityId },
        select: { title: true, problemSolved: true },
      });
      if (!opportunity) {
        return { ok: false, error: `Opportunity \"${request.opportunityId}\" was not found.` };
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
// Evidence-chain enrichment (reuses the existing AgentLog + research mapping)
// ---------------------------------------------------------------------------

interface StoredResearchStepOutput {
  sources?: unknown;
}

/**
 * Load the full external evidence chain recorded by the research step
 * (including cached items the run may not have refetched) and merge it into
 * the run's step outputs so the UI shows the COMPLETE evidence chain, not
 * just the subset re-collected in the last pass.
 */
async function enrichWithStoredEvidence(
  run: PipelineRunResult,
): Promise<PipelineRunResult> {
  if (!run.opportunityId) return run;

  const researchStep = run.steps.find((s) => s.stage === 'RESEARCH');
  const output = researchStep?.summary.output;
  const existing = isRecord(output) ? output : null;
  const opportunityId = run.opportunityId;

  let stored: StoredResearchStepOutput | null = null;
  try {
    stored = await loadStoredEvidenceSources(opportunityId);
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

  const steps = run.steps.map((step) =>
    step.stage === 'RESEARCH'
      ? {
          ...step,
          summary: { ...step.summary, output: merged },
        }
      : step,
  );
  return { ...run, steps };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read EvidenceItemModel rows recorded for this opportunity by earlier
 * research runs. Every row keeps its own stored evidenceType: rows written by
 * the Real Research Engine are VERIFIED_DATA (fetched) or SEARCH_DISCOVERY
 * (search metadata). This function never relabels them.
 */
async function loadStoredEvidenceSources(opportunityId: string): Promise<StoredResearchStepOutput | null> {
  const rows = await db.evidenceItemModel.findMany({
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
 * Rehydrate a persisted PipelineRun (JSON payload) back into a
 * PipelineRunResult, enriching the evidence chain with stored sources.
 * Corrupt payloads surface as null — callers must handle that honestly.
 */
export async function rehydrateFactoryRun(
  runId: string,
): Promise<{ runId: string; run: PipelineRunResult } | null> {
  let row: { id: string; result: string; opportunityId: string | null } | null = null;
  try {
    row = await db.pipelineRun.findUnique({
      where: { id: runId },
      select: { id: true, result: true, opportunityId: true },
    });
  } catch (error) {
    logger.error('Factory run lookup failed', error, { runId });
    return null;
  }
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.result) as PipelineRunResult;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) return null;
    const run = await enrichWithStoredEvidence({
      ...parsed,
      opportunityId: row.opportunityId ?? undefined,
    });
    return { runId: row.id, run };
  } catch (error) {
    logger.error('Factory run payload could not be parsed', error, { runId });
    return null;
  }
}
