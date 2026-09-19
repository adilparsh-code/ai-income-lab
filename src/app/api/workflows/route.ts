// Phase 5.2 — Workflow API (Ruflo-ready boundary).
//
// POST /api/workflows → execute a state-aware workflow through the existing
//                       job runner (idempotency, halal gates, bounded retries).
// GET  /api/workflows → recent workflow runs (safe, compact fields only).
//
// Safety: workflowType must be a registered workflow; the pure planner decides
// which steps run; NOT_ALLOWED terminates with zero executions; REVIEW_REQUIRED
// stops at HUMAN_REVIEW. Responses contain no payloads, secrets, or prompts.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { executeWorkflow, getRecentWorkflowRuns } from '@/lib/ruflo/workflow-runner';
import { isWorkflowType } from '@/lib/ruflo/workflows';
import { guardOperatorEndpoint, readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // SECURITY: operator-only control endpoint (rate-limited, fail-closed).
  const guard = await guardOperatorEndpoint(request, 'api:workflows', { max: 20, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:workflows', maxChars: 10_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  const { workflowType, objective, opportunityId, correlationId } = raw;

  if (!isWorkflowType(workflowType)) {
    return NextResponse.json(
      { ok: false, error: `Unknown workflowType. Registered workflows: OPPORTUNITY_DISCOVERY, OPPORTUNITY_TO_PRODUCT, BUSINESS_ANALYSIS, FULL_INCOME_PIPELINE.` },
      { status: 400 },
    );
  }
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    return NextResponse.json({ ok: false, error: 'objective is required and must be a non-empty string' }, { status: 400 });
  }
  if (objective.length > 4000) {
    return NextResponse.json({ ok: false, error: 'objective must be at most 4000 characters' }, { status: 400 });
  }
  if (opportunityId !== undefined && opportunityId !== null && (typeof opportunityId !== 'string' || opportunityId.length > 128)) {
    return NextResponse.json({ ok: false, error: 'opportunityId must be a string of at most 128 characters' }, { status: 400 });
  }
  if (correlationId !== undefined && (typeof correlationId !== 'string' || correlationId.trim().length === 0 || correlationId.length > 200)) {
    return NextResponse.json({ ok: false, error: 'correlationId must be a non-empty string of at most 200 characters' }, { status: 400 });
  }

  logger.info('Workflow API dispatch', { workflowType: String(workflowType) });

  try {
    const result = await executeWorkflow({
      workflowType,
      objective,
      opportunityId: typeof opportunityId === 'string' ? opportunityId : undefined,
      correlationId: typeof correlationId === 'string' ? correlationId : undefined,
    });
    const httpStatus = result.status === 'BLOCKED' ? 200 : result.status === 'HUMAN_REVIEW' ? 200 : 201;
    return NextResponse.json({ ok: true, workflow: result }, { status: httpStatus });
  } catch {
    logger.error('Workflow execution failed', new Error('workflow dispatch failed'), { workflowType: String(workflowType) });
    return NextResponse.json({ ok: false, error: 'Workflow execution failed unexpectedly. Check the server logs.' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const guard = await guardOperatorEndpoint(request, 'api:workflows:get', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const runs = await getRecentWorkflowRuns(10);
    return NextResponse.json({ ok: true, workflows: runs });
  } catch {
    return NextResponse.json({ ok: false, error: 'Workflow history is temporarily unavailable.' }, { status: 500 });
  }
}
