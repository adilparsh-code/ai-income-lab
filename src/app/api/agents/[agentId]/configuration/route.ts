// ============================================================================
// AGENCY API — AGENT CONFIGURATION (admin-only, Phase 10A)
// ============================================================================
// GET   /api/agents/[agentId]/configuration → active config + version history.
// PATCH /api/agents/[agentId]/configuration → SAVE a new immutable version.
//
// SAVE semantics: validate server-side → persist a NEW append-only version →
// move the active-version pointer → audit. Never starts or stops work, never
// mutates or deletes historical versions, never stores or returns secrets.
// The editor surface is limited to the safe fields supported by the existing
// contract schema; every field is re-validated against the static contract
// so the client can never widen its own permissions (tools/stages/budget/
// timeout/retries are capped at the base contract; approval-locked agents
// keep requiresApproval=true forever).
// ============================================================================

import { NextResponse } from 'next/server';
import {
  getAgentConfigHistory,
  isKnownAgentId,
  saveAgentConfig,
} from '@/lib/agency/control-center';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agents:config', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agents:config', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const { agentId } = await params;
  if (typeof agentId !== 'string' || !isKnownAgentId(agentId)) {
    return NextResponse.json({ ok: false, error: 'Unknown agent id.' }, { status: 404 });
  }

  try {
    const history = await getAgentConfigHistory(agentId, 50);
    return NextResponse.json({ ok: true, agentId, ...history });
  } catch (error) {
    logger.warn('Agent configuration history unavailable', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Configuration history is temporarily unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agents:config:patch', identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agents:config:patch', outcome: 'refused' });
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
  if (raw.correlationId !== undefined && (typeof raw.correlationId !== 'string' || raw.correlationId.length === 0 || raw.correlationId.length > 200)) {
    return NextResponse.json({ ok: false, error: 'correlationId must be a non-empty string of at most 200 characters.' }, { status: 400 });
  }

  try {
    const result = await saveAgentConfig({
      agentId,
      config: raw.config,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
      changedBy: auth.session.email,
      correlationId: typeof raw.correlationId === 'string' ? raw.correlationId : undefined,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, errors: result.errors, correlationId: result.correlationId }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      agentId,
      version: result.version,
      changedFields: result.changedFields,
      correlationId: result.correlationId,
    });
  } catch (error) {
    logger.warn('Agent configuration save failed', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Configuration save failed (storage error). Nothing was applied.' },
      { status: 503 },
    );
  }
}
