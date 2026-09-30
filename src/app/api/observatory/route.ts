// GET /api/observatory — Phase 10 AI Operations & Income Observatory view.
//
// Read-only aggregates over existing records. Admin-session gated (same
// single-admin layer as every console API), rate limited, and audited on
// refusal. No secrets, tokens, or raw payloads are included in the response.

import { NextResponse } from 'next/server';
import { getObservatoryView } from '@/lib/observatory';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:observatory', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:observatory', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  try {
    const view = await getObservatoryView();
    return NextResponse.json({ ok: true, view });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Observatory view unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
