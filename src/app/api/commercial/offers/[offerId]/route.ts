// ============================================================================
// PHASE 11.2 — COMMERCIAL API: OFFER DETAIL / STATUS / PAYMENT (admin-only)
// ============================================================================
// GET  /api/commercial/offers/[offerId]
// POST /api/commercial/offers/[offerId] { action: 'status' | 'payment', ... }
//
// The payment branch enforces the hard gate: PAYMENT_VERIFIED requires a
// paymentVerificationSource and a reference. A body field claiming "paid" is
// never sufficient, and there is no body field that can set it directly.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import {
  getOfferById,
  setOfferPaymentState,
  transitionOfferStatus,
} from '@/lib/commercial/offer-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:offer';

export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const { offerId } = await params;
  const offer = await getOfferById(offerId);
  if (!offer) return NextResponse.json({ ok: false, error: 'Offer not found.' }, { status: 404 });
  return NextResponse.json({ ok: true, offer });
}

export async function POST(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 30, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 4_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const { offerId } = await params;
  const raw = bodyGuard.value;

  // Explicit action discriminator: no default branch mutates anything.
  if (raw.action === 'status') {
    const result = await transitionOfferStatus({
      offerId,
      to: raw.to,
      actor: auth.session.email,
      surface: SURFACE,
    });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, status: result.status });
  }

  if (raw.action === 'payment') {
    const result = await setOfferPaymentState({
      offerId,
      to: raw.to,
      paymentVerificationSource: raw.paymentVerificationSource,
      paymentVerificationRef: raw.paymentVerificationRef,
      actor: auth.session.email,
      surface: SURFACE,
    });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, paymentState: result.paymentState });
  }

  return NextResponse.json({ ok: false, error: 'action must be status or payment.' }, { status: 400 });
}