// GET /api/ops/dashboard — Phase 8 operations view (safe aggregates only).

import { NextResponse } from 'next/server';
import { getPhase8OperationsView } from '@/lib/ops/dashboard';
import { clientIpFrom, enforceRateLimit, auditSecurityEvent } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:ops/dashboard', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:ops/dashboard', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  try {
    const view = await getPhase8OperationsView();
    return NextResponse.json({ ok: true, view });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Operations view unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
