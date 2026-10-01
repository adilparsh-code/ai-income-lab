// ============================================================================
// PHASE 11.1 — CLIENTS API: PROSPECTS (admin-only)
// ============================================================================
// GET  /api/clients/prospects?lifecycleState=&riskState=&limit=
// POST /api/clients/prospects  { displayName, email?, website?, businessInfo?,
//                                source, sourceProvider?, sourceRef?,
//                                evidenceRefs? }
//
// Single-admin surface (requireAdminApi), rate-limited per IP, audited via
// the existing SecurityEvent utility. No external discovery, no outreach —
// Phase 11.1 stores and classifies only.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { createProspect, listProspects } from '@/lib/clients/client-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:clients:prospects';

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
  const result = await listProspects({
    lifecycleState: url.searchParams.get('lifecycleState') ?? undefined,
    riskState: url.searchParams.get('riskState') ?? undefined,
    limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, prospects: result.prospects });
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

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 8_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  const result = await createProspect({
    displayName: raw.displayName,
    email: raw.email,
    website: raw.website,
    businessInfo: raw.businessInfo,
    source: raw.source,
    sourceProvider: raw.sourceProvider,
    sourceRef: raw.sourceRef,
    evidenceRefs: raw.evidenceRefs,
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, prospectId: result.prospectId }, { status: 201 });
}
