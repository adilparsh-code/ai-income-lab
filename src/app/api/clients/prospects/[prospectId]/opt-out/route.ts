// ============================================================================
// PHASE 11.1 — CLIENTS API: PROSPECT OPT-OUT / SUPPRESSION (admin-only)
// ============================================================================
// POST /api/clients/prospects/[prospectId]/opt-out  { optedOut, reason? }
//
// Foundation for future outreach protection (Phase 11.1 sends nothing):
// records suppression state + reason, audited.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { setProspectOptOut } from '@/lib/clients/client-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:clients:prospect:opt-out';

export async function POST(request: Request, { params }: { params: Promise<{ prospectId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 30, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 2_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const { prospectId } = await params;
  const raw = bodyGuard.value;

  const result = await setProspectOptOut({
    prospectId,
    optedOut: raw.optedOut,
    reason: raw.reason,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, optedOut: result.optedOut });
}
