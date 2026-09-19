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
import { guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params;
  if (!opportunityId || opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId is required (max 128 chars)' }, { status: 400 });
  }

  // SECURITY: the income engine drives real business execution — same-origin
  // browser calls from the workspace UI are allowed; anything else must
  // present the operator credential. Rate-limited per IP either way.
  const guard = await guardBrowserOrOperator(request, 'api:income-loop/advance', { max: 30, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:income-loop/advance', maxChars: 8_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
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
