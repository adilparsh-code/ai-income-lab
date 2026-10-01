// ============================================================================
// PHASE 11.3 — COMMERCIAL API: ENGAGEMENTS (admin-only)
// ============================================================================
// GET  /api/commercial/engagements?state=&engagementType=&limit=
// POST /api/commercial/engagements { engagementType, title, totalPrice, ... }
//
// An engagement starts at NO_COMMITMENT. Nothing here can authorize work —
// that requires a verified payment through the state route.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { createEngagement, listEngagements } from '@/lib/commercial/engagement-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:engagements';

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
  const result = await listEngagements({
    state: url.searchParams.get('state') ?? undefined,
    engagementType: url.searchParams.get('engagementType') ?? undefined,
    limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, engagements: result.engagements });
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

  const result = await createEngagement({
    engagementType: raw.engagementType,
    title: raw.title,
    scopeSummary: raw.scopeSummary,
    offerId: raw.offerId,
    proposalId: raw.proposalId,
    proposalVersionId: raw.proposalVersionId,
    opportunityId: raw.opportunityId,
    prospectId: raw.prospectId,
    microServiceKind: raw.microServiceKind,
    totalPrice: raw.totalPrice,
    currency: raw.currency,
    lowRiskException: raw.lowRiskException,
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, engagementId: result.engagementId, state: result.state }, { status: 201 });
}