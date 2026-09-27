// ============================================================================
// AGENCY API — ROSTER (admin-only)
// ============================================================================
// GET /api/agency/roster → the 13-agent roster with REAL runtime state:
// contracts, health snapshots, success/failure counts, last runs, statuses.
// Status is derived from recorded runs and the agency control row — never a
// fabricated LIVE badge.
// ============================================================================

import { NextResponse } from 'next/server';
import { agentRosterStatus, contractViews, agencySeeded, seedAgencyContracts } from '@/lib/agency/runtime';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { clientIpFrom, enforceRateLimit, auditSecurityEvent } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:roster', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:roster', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  try {
    // Idempotently seed durable contract evidence on first read.
    if (!(await agencySeeded())) {
      await seedAgencyContracts();
    }
    const roster = await agentRosterStatus();
    const contracts = contractViews();
    return NextResponse.json({ ok: true, roster, contracts });
  } catch (error) {
    logger.warn('Agency roster unavailable', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Roster is temporarily unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
