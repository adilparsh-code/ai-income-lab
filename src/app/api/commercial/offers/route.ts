// ============================================================================
// PHASE 11.2 — COMMERCIAL API: OFFERS (admin-only)
// ============================================================================
// GET  /api/commercial/offers?type=&status=&limit=
// POST /api/commercial/offers { type, title, price, ... }
//
// Single-admin surface (requireAdminApi), rate limited per IP, audited through
// the existing SecurityEvent utility. No external provider, no outreach.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { createOffer, listOffers } from '@/lib/commercial/offer-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:offers';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const result = await listOffers({
    type: url.searchParams.get('type') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, offers: result.offers });
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 12_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  const result = await createOffer({
    type: raw.type,
    title: raw.title,
    description: raw.description,
    scopeSummary: raw.scopeSummary,
    price: raw.price,
    currency: raw.currency,
    estimatedEffortHours: raw.estimatedEffortHours,
    estimatedCost: raw.estimatedCost,
    opportunityId: raw.opportunityId,
    productId: raw.productId,
    halalStatus: raw.halalStatus,
    riskState: raw.riskState,
    status: raw.status,
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, offerId: result.offerId }, { status: 201 });
}