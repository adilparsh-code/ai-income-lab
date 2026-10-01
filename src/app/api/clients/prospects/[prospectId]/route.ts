// ============================================================================
// PHASE 11.1 — CLIENTS API: PROSPECT DETAIL (admin-only, object-level authz)
// ============================================================================
// GET /api/clients/prospects/[prospectId] → the prospect record (404 when
// absent or the id is malformed). Route params follow the repo convention:
// { params: Promise<{ prospectId: string }> } + await params.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit } from '@/lib/security/guard';
import { getProspectById } from '@/lib/clients/client-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:clients:prospect';

export async function GET(request: Request, { params }: { params: Promise<{ prospectId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const { prospectId } = await params;
  const prospect = await getProspectById(prospectId);
  if (!prospect) {
    return NextResponse.json({ ok: false, error: 'Prospect not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, prospect });
}
