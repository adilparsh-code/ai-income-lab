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

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body must be valid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
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

export async function GET() {
  try {
    const runs = await getRecentWorkflowRuns(10);
    return NextResponse.json({ ok: true, workflows: runs });
  } catch {
    return NextResponse.json({ ok: false, error: 'Workflow history is temporarily unavailable.' }, { status: 500 });
  }
}
