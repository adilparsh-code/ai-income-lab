// ============================================================================
// PHASE 11.5 — GOVERNED OUTREACH API (admin-only)
// ============================================================================
// POST /api/commercial/outreach  { action: 'send' | 'opt-out' | 'posture' }
//
// Every action is admin-gated, rate-limited and audited. The 'send' action is
// NOT a raw send: it routes through sendGovernedOutreach, which applies the
// content gate, the opt-out/eligibility gate, the global daily cap, the
// duplicate gate, and then the (NOT_CONNECTED) provider.
//
// There is no route here that accepts a "force" or "bypass" flag, and no route
// that can reach a provider without passing the gates.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { getOutreachPosture, sendGovernedOutreach, suppressOutreach } from '@/lib/commercial/outreach-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:outreach';

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 30, windowSeconds: 60 });
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

  switch (raw.action) {
    case 'send': {
      const result = await sendGovernedOutreach({
        prospectId: raw.prospectId,
        channel: raw.channel,
        to: raw.to,
        subject: raw.subject,
        body: raw.body,
        logicalId: raw.logicalId,
        contactApprovalRef: raw.contactApprovalRef,
        approvedBy: auth.session.email,
        engagementId: raw.engagementId,
        surface: SURFACE,
      });
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: result.error, gate: result.gate ?? null },
          { status: result.status },
        );
      }
      return NextResponse.json({
        ok: true,
        status: result.status,
        outreachSendId: result.outreachSendId,
        // Truthful: a simulated send is labelled simulated, never presented as
        // a real delivered message.
        simulated: result.simulated,
      }, { status: 201 });
    }
    case 'opt-out': {
      const result = await suppressOutreach({
        prospectId: raw.prospectId,
        reason: raw.reason,
        surface: SURFACE,
      });
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true, suppressed: true });
    }
    case 'posture': {
      const posture = await getOutreachPosture(raw.prospectId);
      if (!posture) return NextResponse.json({ ok: false, error: 'Prospect not found.' }, { status: 404 });
      return NextResponse.json({ ok: true, posture });
    }
    default:
      return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
  }
}
