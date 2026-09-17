import { NextResponse } from 'next/server';
import { runPipeline, type PipelineRequest } from '@/lib/ruflo/orchestrator';
import { logger } from '@/lib/server-log';
import { PIPELINE_ORDER, type PipelineStage } from '@/lib/ruflo/pipeline-logic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the stages option: array of known stages; anything else → full loop. */
function parseStages(value: unknown): PipelineStage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter(
    (s): s is PipelineStage => typeof s === 'string' && (PIPELINE_ORDER as string[]).includes(s),
  );
  return valid.length > 0 ? valid : undefined;
}

/**
 * Ruflo orchestration entry point. Thin HTTP surface over the bounded pipeline
 * orchestrator — the orchestrator owns routing and safety gates; this route
 * only validates input shape and maps errors safely.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logger.warn('Ruflo pipeline rejected: malformed JSON body');
    return NextResponse.json(
      { success: false, error: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  if (!isRecord(body)) {
    return NextResponse.json(
      { success: false, error: 'Request body must be a JSON object' },
      { status: 400 }
    );
  }

  const raw = body as Record<string, unknown>;
  const pipelineRequest: PipelineRequest = {
    objective: typeof raw.objective === 'string' ? raw.objective : '',
    ...(typeof raw.opportunityId === 'string' && raw.opportunityId.length > 0
      ? { opportunityId: raw.opportunityId }
      : {}),
    ...(Array.isArray(raw.halalRequirements) &&
    raw.halalRequirements.every((r) => typeof r === 'string')
      ? { halalRequirements: raw.halalRequirements as string[] }
      : {}),
    ...(parseStages(raw.stages) ? { stages: parseStages(raw.stages) } : {}),
  };

  if (pipelineRequest.objective.trim().length === 0 && !pipelineRequest.opportunityId) {
    return NextResponse.json(
      { success: false, opportunityId: null },
      { status: 400 }
    );
  }

  logger.info('Ruflo pipeline started', {
    opportunityId: pipelineRequest.opportunityId ?? null,
    stages: pipelineRequest.stages ?? 'full',
  });

  try {
    const result = await runPipeline(pipelineRequest);
    return NextResponse.json({ success: result.status !== 'FAILED', ...result });
  } catch (error) {
    // Never leak stack traces, secrets, or internal details to the client.
    logger.error('Ruflo pipeline failed unexpectedly', error);
    return NextResponse.json(
      { success: false, error: 'An unexpected error occurred while running the pipeline' },
      { status: 500 }
    );
  }
}
