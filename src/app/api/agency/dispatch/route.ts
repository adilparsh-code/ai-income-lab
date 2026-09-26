// ============================================================================
// AGENCY API — SUPERVISED DISPATCH (admin-only)
// ============================================================================
// POST /api/agency/dispatch → one supervised job for a roster agent.
//
// The ONLY execution path here is the EXISTING Job Runner (runJob): halal
// gates, idempotency, and bounded retries remain authoritative there. This
// endpoint adds contract checks, the global pause gate, the AgentRun
// governance record, and the deterministic supervisor verdict. It never
// executes agents directly and never touches AI providers itself.
// ============================================================================

import { NextResponse } from 'next/server';
import { dispatchSupervised } from '@/lib/agency/supervised-dispatch';
import { isAgencyAgentId } from '@/lib/agency/types';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:dispatch', identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:dispatch', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: 'api:agency:dispatch', maxChars: 8_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  if (typeof raw.agentId !== 'string' || !isAgencyAgentId(raw.agentId)) {
    return NextResponse.json({ ok: false, error: 'agentId must be a roster agent id.' }, { status: 400 });
  }
  if (typeof raw.objective !== 'string' || raw.objective.trim().length === 0 || raw.objective.length > 400) {
    return NextResponse.json({ ok: false, error: 'objective is required (at most 400 characters).' }, { status: 400 });
  }
  if (raw.opportunityId !== undefined && (typeof raw.opportunityId !== 'string' || raw.opportunityId.length > 128)) {
    return NextResponse.json({ ok: false, error: 'opportunityId must be a string of at most 128 characters.' }, { status: 400 });
  }
  if (raw.budgetUsd !== undefined && (typeof raw.budgetUsd !== 'number' || !Number.isFinite(raw.budgetUsd) || raw.budgetUsd < 0 || raw.budgetUsd > 1000)) {
    return NextResponse.json({ ok: false, error: 'budgetUsd must be a non-negative number (max 1000).' }, { status: 400 });
  }
  if (raw.correlationId !== undefined && (typeof raw.correlationId !== 'string' || raw.correlationId.length > 200)) {
    return NextResponse.json({ ok: false, error: 'correlationId must be a string of at most 200 characters.' }, { status: 400 });
  }

  try {
    const result = await dispatchSupervised({
      agentId: raw.agentId,
      objective: raw.objective,
      stage: typeof raw.stage === 'string' ? raw.stage : '',
      opportunityId: typeof raw.opportunityId === 'string' ? raw.opportunityId : undefined,
      budgetUsd: typeof raw.budgetUsd === 'number' ? raw.budgetUsd : undefined,
      correlationId: typeof raw.correlationId === 'string' ? raw.correlationId : undefined,
    });

    if (!result.ok) {
      // Honest refusal: no execution happened.
      const status = result.reason === 'PAUSED' ? 423 : result.reason === 'REFUSED' ? 409 : 400;
      return NextResponse.json({ ok: false, reason: result.reason, error: result.detail ?? 'Dispatch refused.' }, { status });
    }

    return NextResponse.json({
      ok: true,
      agentRunId: result.agentRunId,
      jobId: result.jobId,
      jobStatus: result.jobStatus,
      verdict: result.verdict,
      verdictReasons: result.verdictReasons,
      deduplicated: result.deduplicated,
      executionMode: result.executionMode,
      correlationId: result.correlationId,
    }, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    logger.error('Agency dispatch failed', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Dispatch failed (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
