// Phase 7 — Income loop state API.
// GET /api/income-loop/:opportunityId → honest loop state for one opportunity.
// Safe fields only: stage states, metrics, gates, blockers. No payloads, no
// secrets, no prompt contents. Unknown opportunity → 404, never fabricated.

import { NextResponse } from 'next/server';
import { getIncomeLoopState } from '@/lib/income-engine/engine';
import { clientIpFrom, enforceRateLimit, auditSecurityEvent } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params;
  if (!opportunityId || opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId is required (max 128 chars)' }, { status: 400 });
  }
  // SECURITY: business state is operator/same-origin data — public scanners
  // and bots (already refused at the edge) that still hit this path are
  // rate-limited here.
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:income-loop:get', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:income-loop:get', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
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
