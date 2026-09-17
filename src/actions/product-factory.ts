'use server';

import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/server-log';
import {
  runProductFactory,
  rehydrateFactoryRun,
  type ProductFactoryRequest,
} from '@/lib/product-factory/factory-service';
import {
  buildFactoryRunView,
  looksLikeFactoryRun,
  type FactoryRunView,
} from '@/lib/product-factory/factory-logic';
import type { PipelineRunResult } from '@/lib/ruflo/orchestrator';

/** Lean opportunity list for the factory selector. */
export interface FactoryOpportunityOption {
  id: string;
  title: string;
  status: string;
  halalStatus: string;
  overallScore: number;
}

export async function getFactoryOpportunities(): Promise<FactoryOpportunityOption[]> {
  const opportunities = await db.opportunity.findMany({
    select: {
      id: true,
      title: true,
      status: true,
      halalStatus: true,
      overallScore: true,
    },
    orderBy: { overallScore: 'desc' },
  });
  return opportunities;
}

/** Serializable run history row for the factory workspace. */
export interface FactoryRunSummary {
  id: string;
  opportunityId: string | null;
  opportunityTitle: string | null;
  objective: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
}

export async function getRecentFactoryRuns(limit = 5): Promise<FactoryRunSummary[]> {
  try {
    const runs = await db.pipelineRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 40,
      include: { opportunity: { select: { title: true } } },
    });
    return runs
      .filter((run) => {
        try {
          return looksLikeFactoryRun(JSON.parse(run.result));
        } catch {
          return false;
        }
      })
      .slice(0, limit)
      .map((run) => ({
        id: run.id,
        opportunityId: run.opportunityId,
        opportunityTitle: run.opportunity?.title ?? null,
        objective: run.objective,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        durationMs: run.durationMs,
      }));
  } catch (error) {
    logger.error('Factory run history could not be loaded', error);
    return [];
  }
}

/**
 * Generate a product concept from a selected opportunity. The orchestrator
 * owns halal gates, agent execution, provenance, and persistence; this action
 * adapts between client and server and surfaces errors safely.
 */
export type GenerateProductResult =
  | { ok: true; runId: string; run: PipelineRunResult; view: FactoryRunView }
  | { ok: false; error: string };

export async function generateProductConcept(input: {
  opportunityId?: string;
  objective?: string;
  productType?: string;
  monetizationPreference?: string;
  constraints?: string[];
}): Promise<GenerateProductResult> {
  if (
    (typeof input?.objective !== 'string' || input.objective.trim().length === 0) &&
    (typeof input?.opportunityId !== 'string' || input.opportunityId.trim().length === 0)
  ) {
    return { ok: false, error: 'Select an opportunity or provide an objective to generate a product concept.' };
  }

  let outcome;
  try {
    outcome = await runProductFactory(input as ProductFactoryRequest);
  } catch (error) {
    logger.error('Factory generate action failed', error);
    return { ok: false, error: 'Product generation failed due to an unexpected error. Try again.' };
  }

  if (!outcome.ok || !outcome.run) {
    return { ok: false, error: outcome.error ?? 'Product generation failed. Try again.' };
  }

  revalidatePath('/product-factory');
  revalidatePath('/');

  return {
    ok: true,
    runId: outcome.run.runId ?? '',
    run: outcome.run,
    view: buildFactoryRunView({ ...outcome.run, steps: outcome.run.steps.map((s) => s.summary) }),
  };
}

/** Rehydrate a persisted run into the workspace view (history browsing). */
export type RehydratedRunResult =
  | { ok: true; view: FactoryRunView; status: string; objective: string }
  | { ok: false; error: string };

export async function getFactoryRunDetail(runId: string): Promise<RehydratedRunResult> {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return { ok: false, error: 'A run id is required.' };
  }

  try {
    const rehydrated = await rehydrateFactoryRun(runId);
    if (!rehydrated) {
      return { ok: false, error: 'The requested run could not be found or its payload is unreadable.' };
    }
    return {
      ok: true,
      view: buildFactoryRunView({ ...rehydrated.run, steps: rehydrated.run.steps.map((s) => s.summary) }),
      status: rehydrated.run.status,
      objective: rehydrated.run.objective,
    };
  } catch (error) {
    logger.error('Factory run detail action failed', error, { runId });
    return { ok: false, error: 'The run detail could not be loaded. Try again.' };
  }
}
