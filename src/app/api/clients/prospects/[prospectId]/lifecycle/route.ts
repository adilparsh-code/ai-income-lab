// ============================================================================
// PHASE 11.1 — CLIENTS API: PROSPECT LIFECYCLE TRANSITION (admin-only)
// ============================================================================
// POST /api/clients/prospects/[prospectId]/lifecycle
//   { to, contactApprovalRef? }
//
// Enforces the Phase 11.1 lifecycle state machine (deny-by-default) and the
// CONTACTED approval gate: CONTACTED requires contactApprovalRef and is only
// reachable from QUALIFIED. Client messages can never call this — it is an
// admin-session endpoint.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { transitionLifecycle } from '@/lib/clients/client-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:clients:prospect:lifecycle';

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

  const result = await transitionLifecycle({
    prospectId,
    to: raw.to,
    contactApprovalRef: raw.contactApprovalRef,
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, lifecycleState: result.lifecycleState });
}
