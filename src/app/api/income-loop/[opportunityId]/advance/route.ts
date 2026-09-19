// Phase 7 — Income loop advance API.
// POST /api/income-loop/:opportunityId/advance → execute exactly ONE bounded
// stage action through the existing job runner. Body (optional):
//   { objective?: string, humanApprovalToken?: string }
// The approval token is accepted ONLY to satisfy the existing human-gated
// publishing boundary; it is never logged or stored in plaintext by the
// engine. NOT_ALLOWED/REVIEW_REQUIRED never reach a job. Responses carry safe
// summaries only.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { advanceIncomeLoop } from '@/lib/income-engine/engine';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params;
  if (!opportunityId || opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId is required (max 128 chars)' }, { status: 400 });
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body must be valid JSON when provided' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: 'Request body must be a JSON object' }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;
  if (raw.objective !== undefined && (typeof raw.objective !== 'string' || raw.objective.length > 4000)) {
    return NextResponse.json({ ok: false, error: 'objective must be a string of at most 4000 characters' }, { status: 400 });
  }
  if (raw.humanApprovalToken !== undefined && (typeof raw.humanApprovalToken !== 'string' || raw.humanApprovalToken.length > 512)) {
    return NextResponse.json({ ok: false, error: 'humanApprovalToken must be a string of at most 512 characters' }, { status: 400 });
  }

  try {
    const outcome = await advanceIncomeLoop(opportunityId, {
      ...(typeof raw.objective === 'string' ? { objective: raw.objective } : {}),
      ...(typeof raw.humanApprovalToken === 'string' ? { humanApprovalToken: raw.humanApprovalToken } : {}),
    });
    const httpStatus =
      outcome.status === 'BLOCKED' ? 403
      : outcome.status === 'HUMAN_REVIEW' ? 409
      : outcome.status === 'FAILED' ? 502
      : 200;
    return NextResponse.json({ ok: outcome.ok, outcome }, { status: httpStatus });
  } catch (error) {
    logger.error('Income loop advance API failed', { error: String(error) });
    return NextResponse.json(
      { ok: false, error: 'Advance failed (storage/runtime error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
