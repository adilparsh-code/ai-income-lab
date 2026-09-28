// ============================================================================
// AGENCY API — SUPERVISED GROWTH AGENT (admin-only)
// ============================================================================
// POST /api/agency/growth → run ONE bounded supervised growth cycle for an
// opportunity. This is the manual trigger; a future scheduler would call
// runSupervisedGrowthCycle() from the same path — there is exactly ONE
// execution path into the growth engine, and it goes through the agency
// pause gate, contract stage check, halal gates, no-data safety, the Job
// Runner (inside tickGrowthLoop), AgentRun persistence, and the supervisor.
//
// GET /api/agency/growth?opportunityId=... → read-only: the deterministic
// growth brief for the Business Manager (portfolio health, engine decision,
// verified learnings, recent decisions). No execution ever happens on GET.
//
// SECURITY: requireAdminApi (same as every agency endpoint) + rate limiting
// + bounded bodies + audit. No client-side secrets; errors are generic.
// ============================================================================

import { NextResponse } from 'next/server';
import { runSupervisedGrowthCycle } from '@/lib/agency/growth-agent';
import { getBusinessManagerGrowthBrief } from '@/lib/growth/business-manager';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:growth:get', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:growth', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const opportunityId = (url.searchParams.get('opportunityId') ?? '').trim();
  if (opportunityId.length === 0 || opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId query parameter is required (max 128 characters).' }, { status: 400 });
  }

  try {
    const brief = await getBusinessManagerGrowthBrief(opportunityId);
    if (!brief) {
      return NextResponse.json({ ok: false, error: 'Opportunity not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, brief });
  } catch (error) {
    logger.warn('Growth brief read failed', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Growth brief is temporarily unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:growth', identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:growth', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: 'api:agency:growth', maxChars: 2_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (typeof raw.opportunityId !== 'string' || raw.opportunityId.trim().length === 0 || raw.opportunityId.length > 128) {
    return NextResponse.json({ ok: false, error: 'opportunityId is required (max 128 characters).' }, { status: 400 });
  }
  if (raw.stage !== undefined && (typeof raw.stage !== 'string' || raw.stage.length > 20)) {
    return NextResponse.json({ ok: false, error: 'stage must be a short string if provided.' }, { status: 400 });
  }
  if (raw.correlationId !== undefined && (typeof raw.correlationId !== 'string' || raw.correlationId.length > 200)) {
    return NextResponse.json({ ok: false, error: 'correlationId must be a string of at most 200 characters.' }, { status: 400 });
  }

  try {
    const result = await runSupervisedGrowthCycle({
      opportunityId: raw.opportunityId,
      stage: typeof raw.stage === 'string' ? raw.stage : undefined,
      correlationId: typeof raw.correlationId === 'string' ? raw.correlationId : undefined,
    });

    if (!result.ok) {
      // Honest refusal: PAUSED → 423, REFUSED → 409.
      const status = result.outcome === 'PAUSED' ? 423 : 409;
      return NextResponse.json({ ok: false, outcome: result.outcome, reason: result.reason, correlationId: result.correlationId }, { status });
    }

    return NextResponse.json({ ...result, ok: true }, { status: 200 });
  } catch (error) {
    logger.error('Supervised growth cycle failed', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Growth cycle failed (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
