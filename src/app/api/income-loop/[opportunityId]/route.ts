// Phase 7 — Income loop state API.
// GET /api/income-loop/:opportunityId → honest loop state for one opportunity.
// Safe fields only: stage states, metrics, gates, blockers. No payloads, no
// secrets, no prompt contents. Unknown opportunity → 404, never fabricated.

import { NextResponse } from 'next/server';
import { getIncomeLoopState } from '@/lib/income-engine/engine';
import { guardBrowserOrOperator } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params;
  if (!opportunityId || opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId is required (max 128 chars)' }, { status: 400 });
  }
  // SECURITY (N3): loop state exposes revenue, traffic and gate data — admin
  // session or operator credential required, never anonymous.
  const guard = await guardBrowserOrOperator(request, 'api:income-loop:get', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const state = await getIncomeLoopState(opportunityId);
    if (!state) {
      return NextResponse.json({ ok: false, error: 'Opportunity not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, state });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Loop state is temporarily unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
