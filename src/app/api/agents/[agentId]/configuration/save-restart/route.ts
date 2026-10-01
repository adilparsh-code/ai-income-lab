// ============================================================================
// AGENCY API — AGENT CONFIGURATION SAVE & RESTART (admin-only, Phase 10A)
// ============================================================================
// POST /api/agents/[agentId]/configuration/save-restart with body { config, reason? }.
//
// SAVE & RESTART = save a new immutable config version, then run the governed
// restart (safe stop/pause semantics → reload + re-validate the configuration
// → RUNNING intent through the existing execution path). A failed save never
// restarts; a failed restart returns a truthful error and the agent is left
// in an honest ERROR/PAUSED state — never silently RUNNING.
// ============================================================================

import { NextResponse } from 'next/server';
import { isKnownAgentId, saveAndRestartAgent } from '@/lib/agency/control-center';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agents:config:save-restart', identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agents:config:save-restart', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const { agentId } = await params;
  if (typeof agentId !== 'string' || !isKnownAgentId(agentId)) {
    return NextResponse.json({ ok: false, error: 'Unknown agent id.' }, { status: 404 });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:agents:config', maxBytes: 16 * 1024, maxChars: 8_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (raw.config === undefined || typeof raw.config !== 'object' || Array.isArray(raw.config)) {
    return NextResponse.json({ ok: false, error: 'config object is required.' }, { status: 400 });
  }
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 300)) {
    return NextResponse.json({ ok: false, error: 'reason must be a string of at most 300 characters.' }, { status: 400 });
  }

  try {
    const result = await saveAndRestartAgent({
      agentId,
      config: raw.config,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
      changedBy: auth.session.email,
    });
    if (!result.ok) {
      const status = result.stage === 'SAVE' ? 400 : 503;
      return NextResponse.json(
        { ok: false, stage: result.stage, errors: result.errors, correlationId: result.correlationId },
        { status },
      );
    }
    return NextResponse.json({
      ok: true,
      agentId,
      version: result.version,
      changedFields: result.changedFields,
      restart: result.restart,
      correlationId: result.correlationId,
    });
  } catch (error) {
    logger.warn('Agent save & restart failed', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Save & restart failed (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
