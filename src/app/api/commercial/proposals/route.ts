// ============================================================================
// PHASE 11.2 — COMMERCIAL API: PROPOSALS (admin-only)
// ============================================================================
// GET  /api/commercial/proposals?prospectId=&state=&limit=
// POST /api/commercial/proposals { prospectId, offerId, title, price, ... }
//       → creates the proposal AND its immutable version 1.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { createProposal, listProposals } from '@/lib/commercial/proposal-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:proposals';

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
  const result = await listProposals({
    prospectId: url.searchParams.get('prospectId') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, proposals: result.proposals });
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

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 24_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  const result = await createProposal({
    prospectId: raw.prospectId,
    offerId: raw.offerId,
    opportunityId: raw.opportunityId,
    title: raw.title,
    summary: raw.summary,
    scopeItems: raw.scopeItems,
    deliverables: raw.deliverables,
    exclusions: raw.exclusions,
    assumptions: raw.assumptions,
    price: raw.price,
    currency: raw.currency,
    estimatedTimeline: raw.estimatedTimeline,
    paymentTerms: raw.paymentTerms,
    revisionAllowance: raw.revisionAllowance,
    validityDays: raw.validityDays,
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { ok: true, proposalId: result.proposalId, versionId: result.versionId, version: result.version, halalStatus: result.halalStatus },
    { status: 201 },
  );
}