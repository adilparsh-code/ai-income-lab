// ============================================================================
// PHASE 11.1 — CLIENTS API: PROSPECT RISK STATE (admin-only, hard gate)
// ============================================================================
// POST /api/clients/prospects/[prospectId]/risk-state
//   { to, paymentVerificationSource?, paymentVerificationRef? }
//
// HARD INVARIANT (Phase 11.0 §5): to === PAYMENT_VERIFIED requires an
// explicit paymentVerificationSource (PROVIDER_WEBHOOK | PROVIDER_API |
// MANUAL_ADMIN_APPROVED) plus a reference. No client message, screenshot,
// receipt, or AI output can set it — messages never reach this endpoint.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { setRiskState } from '@/lib/clients/client-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:clients:prospect:risk-state';

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

  const result = await setRiskState({
    prospectId,
    to: raw.to,
    paymentVerificationSource: raw.paymentVerificationSource,
    paymentVerificationRef: raw.paymentVerificationRef,
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, riskState: result.riskState });
}
