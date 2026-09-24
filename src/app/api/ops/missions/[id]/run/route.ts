// POST /api/ops/missions/:id/run — execute a prepared mission through Job Runner.

import { NextResponse } from 'next/server';
import { runMission } from '@/lib/ops/missions';
import { guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || id.length > 128) {
    return NextResponse.json({ ok: false, error: 'id is required (max 128 chars)' }, { status: 400 });
  }
  const guard = await guardBrowserOrOperator(request, 'api:ops/missions/run', { max: 20, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  const bodyGuard = await readJsonBody(request, { surface: 'api:ops/missions/run', maxChars: 4_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (raw.humanApprovalToken !== undefined && (typeof raw.humanApprovalToken !== 'string' || raw.humanApprovalToken.length > 512)) {
    return NextResponse.json({ ok: false, error: 'humanApprovalToken must be a string of at most 512 characters' }, { status: 400 });
  }
  try {
    const result = await runMission(id, {
      ...(typeof raw.humanApprovalToken === 'string' ? { humanApprovalToken: raw.humanApprovalToken } : {}),
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: 'Mission not found.' }, { status: 404 });
    }
    const http =
      result.mission.status === 'BLOCKED' ? 403
      : result.mission.status === 'HUMAN_REVIEW' ? 409
      : result.mission.status === 'FAILED' ? 502
      : 200;
    return NextResponse.json({ ok: result.mission.status === 'COMPLETED' || result.mission.status === 'WAITING', result }, { status: http });
  } catch (error) {
    logger.error('Mission run failed', { error: String(error) });
    return NextResponse.json({ ok: false, error: 'Mission run failed. Nothing was fabricated.' }, { status: 503 });
  }
}
