// ============================================================================
// AGENCY API — AGENT CONTROL CENTER VIEW (admin-only, Phase 10A)
// ============================================================================
// GET /api/agents/control → the full control-center read model: per-agent
// control state, health, current task, last run, budget usage, permissions,
// governance flags, configuration version/drift, last control action, the
// global control row, and the truthful external execution seams (Freebuff is
// always NOT_CONNECTED — no adapter exists in this repository).
//
// Authorization mirrors the existing agency APIs: IP rate limit →
// requireAdminApi → try/catch → 503 with an explicit "nothing was fabricated"
// error. Unauthenticated callers receive 401 before any data is touched.
// ============================================================================

import { NextResponse } from 'next/server';
import { getControlCenterView } from '@/lib/agency/control-center';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agents:control', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agents:control', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  try {
    const view = await getControlCenterView();
    return NextResponse.json({ ok: true, view });
  } catch (error) {
    logger.warn('Agent control center view unavailable', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Agent control view is temporarily unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
