'use server';

import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { runPipeline } from '@/lib/ruflo/orchestrator';
import type { PipelineRequest, PipelineRunResult } from '@/lib/ruflo/orchestrator';
import { logger } from '@/lib/server-log';

/** Lean opportunity list for the pipeline selector. */
export interface PipelineOpportunityOption {
  id: string;
  title: string;
  status: string;
  halalStatus: string;
  overallScore: number;
}

export async function getPipelineOpportunities(): Promise<PipelineOpportunityOption[]> {
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

/** Serializable run history row for dashboards. */
export interface PipelineRunSummary {
  id: string;
  opportunityId: string | null;
  opportunityTitle: string | null;
  objective: string;
  currentStage: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
}

export async function getRecentPipelineRuns(limit = 5): Promise<PipelineRunSummary[]> {
  const runs = await db.pipelineRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { opportunity: { select: { title: true } } },
  });
  return runs.map((run) => ({
    id: run.id,
    opportunityId: run.opportunityId,
    opportunityTitle: run.opportunity?.title ?? null,
    objective: run.objective,
    currentStage: run.currentStage,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    durationMs: run.durationMs,
  }));
}

export type ExecutePipelineResult =
  | { ok: true; run: PipelineRunResult }
  | { ok: false; error: string };

/**
 * Execute one bounded Opportunity → Product pipeline run from the UI.
 * The orchestrator owns routing, halal gates, provenance, and persistence;
 * this action only adapts between client and server and surfaces errors safely.
 */
export async function executePipelineRun(
  input: PipelineRequest,
): Promise<ExecutePipelineResult> {
  if (typeof input?.objective !== 'string' || (typeof input.opportunityId !== 'string' && input.objective.trim().length === 0)) {
    return { ok: false, error: 'Select an opportunity or provide an objective to run the pipeline.' };
  }

  try {
    const run = await runPipeline(input);
    revalidatePath('/pipeline');
    revalidatePath('/');
    return { ok: true, run };
  } catch (error) {
    logger.error('Pipeline action failed', error);
    return {
      ok: false,
      error:
        'The pipeline could not be executed due to an unexpected error. Check the server logs or try again.',
    };
  }
}
