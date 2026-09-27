// POST /api/ops/loop/:opportunityId/tick — exactly one autonomous-loop transition.

import { NextResponse } from 'next/server';
import { tickAutonomousLoop } from '@/lib/ops/loop';
import { guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params;
  if (!opportunityId || opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId is required (max 128 chars)' }, { status: 400 });
  }
  const guard = await guardBrowserOrOperator(request, 'api:ops/loop/tick', { max: 30, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  const bodyGuard = await readJsonBody(request, { surface: 'api:ops/loop/tick', maxChars: 4_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (raw.humanApprovalToken !== undefined && (typeof raw.humanApprovalToken !== 'string' || raw.humanApprovalToken.length > 512)) {
    return NextResponse.json({ ok: false, error: 'humanApprovalToken must be a string of at most 512 characters' }, { status: 400 });
  }
  try {
    const tick = await tickAutonomousLoop(opportunityId, {
      ...(typeof raw.humanApprovalToken === 'string' ? { humanApprovalToken: raw.humanApprovalToken } : {}),
    });
    const http =
      tick.status === 'BLOCKED' ? 403
      : tick.status === 'HUMAN_REVIEW' ? 409
      : tick.status === 'FAILED' ? 502
      : 200;
    return NextResponse.json({ ok: tick.ok, tick }, { status: http });
  } catch (error) {
    logger.error('Loop tick failed', { error: String(error) });
    return NextResponse.json({ ok: false, error: 'Loop tick failed. Nothing was fabricated.' }, { status: 503 });
  }
}
