// ============================================================================
// AGENCY API — CONTROL (admin-only)
// ============================================================================
// GET  /api/agency/control → the global autonomy switch state (real, stored).
// POST /api/agency/control → { paused: boolean, reason?: string } pause/resume.
//
// Pausing is fail-closed: every supervised dispatch checks this row before
// any Job Runner handoff. Pause/resume is audited via SecurityEvent.
// ============================================================================

import { NextResponse } from 'next/server';
import { getAgencyControl, setAgencyPaused } from '@/lib/agency/runtime';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:control', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:control', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  try {
    const control = await getAgencyControl();
    return NextResponse.json({ ok: true, control });
  } catch (error) {
    logger.warn('Agency control state unavailable', { error: String(error).slice(0, 150) });
    return NextResponse.json({ ok: false, error: 'Control state is temporarily unavailable.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:control:post', identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:control:post', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: 'api:agency:control', maxBytes: 2 * 1024, maxChars: 1_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (typeof raw.paused !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'paused must be a boolean.' }, { status: 400 });
  }
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 300)) {
    return NextResponse.json({ ok: false, error: 'reason must be a string of at most 300 characters.' }, { status: 400 });
  }

  try {
    const control = await setAgencyPaused(raw.paused, auth.session.email, typeof raw.reason === 'string' ? raw.reason : undefined);
    return NextResponse.json({ ok: true, control });
  } catch (error) {
    logger.warn('Agency control update failed', { error: String(error).slice(0, 150) });
    return NextResponse.json({ ok: false, error: 'Control update failed (storage error).' }, { status: 503 });
  }
}
