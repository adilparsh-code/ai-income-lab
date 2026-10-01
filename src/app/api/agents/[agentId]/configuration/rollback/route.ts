// ============================================================================
// AGENCY API — AGENT CONFIGURATION ROLLBACK (admin-only, Phase 10A)
// ============================================================================
// POST /api/agents/[agentId]/configuration/rollback with body { toVersion }.
//
// Rollback NEVER mutates or deletes history: it validates the target version
// against the CURRENT safety contract and creates a NEW version (v4 = restored
// copy of v1). If the historical version no longer satisfies the contract
// (e.g. a deploy tightened bounds), the rollback is refused with a truthful
// error instead of restoring something unsafe. The action is audited and the
// agent is flagged pendingRestart so the dashboard shows the config is staged
// but not yet applied through a governed restart.
// ============================================================================

import { NextResponse } from 'next/server';
import { isKnownAgentId, rollbackAgentConfig } from '@/lib/agency/control-center';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agents:config:rollback', identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agents:config:rollback', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const { agentId } = await params;
  if (typeof agentId !== 'string' || !isKnownAgentId(agentId)) {
    return NextResponse.json({ ok: false, error: 'Unknown agent id.' }, { status: 404 });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:agents:config', maxBytes: 2 * 1024, maxChars: 1_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (typeof raw.toVersion !== 'number' || !Number.isInteger(raw.toVersion) || raw.toVersion < 1) {
    return NextResponse.json({ ok: false, error: 'toVersion must be a positive integer.' }, { status: 400 });
  }

  try {
    const result = await rollbackAgentConfig({
      agentId,
      toVersion: raw.toVersion,
      changedBy: auth.session.email,
    });
    if (!result.ok) {
      // Unknown version → 404; contract-drift refusal → 409 (governance block).
      const status = result.error.includes('does not exist') ? 404 : 409;
      return NextResponse.json({ ok: false, error: result.error, correlationId: result.correlationId }, { status });
    }
    return NextResponse.json({
      ok: true,
      agentId,
      restoredFromVersion: result.restoredFromVersion,
      newVersion: result.newVersion,
      correlationId: result.correlationId,
    });
  } catch (error) {
    logger.warn('Agent configuration rollback failed', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Rollback failed (storage error). History is intact; nothing was mutated.' },
      { status: 503 },
    );
  }
}
