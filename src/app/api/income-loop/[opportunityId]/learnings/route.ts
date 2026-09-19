// Phase 7 — Income loop learnings API.
// GET /api/income-loop/:opportunityId/learnings → deterministic learnings
// derived from REAL outcome data (validation verdicts, revenue health,
// traffic reality). No AI, no fabrication.

import { NextResponse } from 'next/server';
import { deriveLoopLearnings } from '@/lib/income-engine/engine';
import { guardOperatorEndpoint } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params;
  if (!opportunityId || opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId is required (max 128 chars)' }, { status: 400 });
  }
  // SECURITY: derived business learnings are operator-only.
  const guard = await guardOperatorEndpoint(request, 'api:income-loop/learnings', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const learnings = await deriveLoopLearnings(opportunityId);
    return NextResponse.json({ ok: true, learnings });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Learnings are temporarily unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
