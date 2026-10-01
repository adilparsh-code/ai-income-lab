// ============================================================================
// PHASE 11.2 + 11.3 — COMMERCIAL SUMMARY API (admin-only, read-only)
// ============================================================================
// GET /api/commercial/summary
//
// A truthful aggregate of the governed commercial pipeline: real row counts,
// NOT_CONNECTED provider states, UNKNOWN rather than a fabricated figure.
// Also available inside the Observatory view at `view.commercial`.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit } from '@/lib/security/guard';
import { getCommercialSummary } from '@/lib/commercial/commercial-summary';
import { deriveCommercialSignals } from '@/lib/commercial/commercial-learning';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:summary';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 30, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  try {
    const [summary, learning] = await Promise.all([
      getCommercialSummary(),
      deriveCommercialSignals(),
    ]);
    return NextResponse.json({ ok: true, summary, learning: { signals: learning.signals, evidence: learning.evidence } });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Commercial summary unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}