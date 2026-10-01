// ============================================================================
// AGENCY API — CONTROL ACTIONS (admin-only, Phase 10A)
// ============================================================================
// POST /api/agents/control with body { action, agentId?, reason?, correlationId? }.
//
//   action: PAUSE | RESUME | STOP | RESTART (requires agentId)
//           STOP_ALL | RESUME_ALL            (no agentId)
//
// The smallest coherent surface: ONE control endpoint instead of a route per
// verb — every action is validated server-side, idempotent (correlationId
// replay returns the recorded outcome), audited (AgentControlAction +
// SecurityEvent), and routed through the governed state machine in
// src/lib/agency/control-center.ts. Execution still happens only through the
// existing Job Runner path; this endpoint never terminates processes and
// never deletes JobRun/AgentRun records.
// ============================================================================

import { NextResponse } from 'next/server';
import {
  applyControlAction,
  isKnownAgentId,
  resumeAllAgents,
  stopAllAgents,
  type AgentControlActionKind,
  type AgentControlActionResult,
} from '@/lib/agency/control-center';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

const SINGLE_AGENT_ACTIONS = new Set<AgentControlActionKind>(['PAUSE', 'RESUME', 'STOP', 'RESTART']);
const GLOBAL_ACTIONS = new Set<AgentControlActionKind>(['STOP_ALL', 'RESUME_ALL']);

function actionResponse(result: AgentControlActionResult): NextResponse {
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      action: result.action,
      agentId: result.agentId,
      previousState: result.previousState,
      newState: result.newState,
      configVersion: result.configVersion,
      correlationId: result.correlationId,
      detail: result.detail,
    });
  }
  // REFUSED = governance/policy block (409); FAILED = storage/execution error (503).
  const status = result.code === 'REFUSED' ? 409 : 503;
  return NextResponse.json(
    { ok: false, action: result.action, agentId: result.agentId, code: result.code, error: result.error, correlationId: result.correlationId },
    { status },
  );
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agents:control:post', identity: ip, max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agents:control:post', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: 'api:agents:control', maxBytes: 4 * 1024, maxChars: 2_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  const action = raw.action;
  if (typeof action !== 'string' || !(SINGLE_AGENT_ACTIONS.has(action as AgentControlActionKind) || GLOBAL_ACTIONS.has(action as AgentControlActionKind))) {
    return NextResponse.json(
      { ok: false, error: 'action must be one of PAUSE | RESUME | STOP | RESTART | STOP_ALL | RESUME_ALL.' },
      { status: 400 },
    );
  }
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 300)) {
    return NextResponse.json({ ok: false, error: 'reason must be a string of at most 300 characters.' }, { status: 400 });
  }
  if (raw.correlationId !== undefined && (typeof raw.correlationId !== 'string' || raw.correlationId.length === 0 || raw.correlationId.length > 200)) {
    return NextResponse.json({ ok: false, error: 'correlationId must be a non-empty string of at most 200 characters.' }, { status: 400 });
  }

  const reason = typeof raw.reason === 'string' ? raw.reason : null;
  const correlationId = typeof raw.correlationId === 'string' ? raw.correlationId : undefined;
  const changedBy = auth.session.email;

  try {
    if (GLOBAL_ACTIONS.has(action as AgentControlActionKind)) {
      if (raw.agentId !== undefined) {
        return NextResponse.json({ ok: false, error: `agentId must not be provided for ${action}.` }, { status: 400 });
      }
      const result = action === 'STOP_ALL'
        ? await stopAllAgents({ changedBy, reason, correlationId })
        : await resumeAllAgents({ changedBy, correlationId });
      return NextResponse.json({ ...result, ok: true });
    }

    // Single-agent action: agentId is required and must be a roster agent.
    if (typeof raw.agentId !== 'string' || !isKnownAgentId(raw.agentId)) {
      return NextResponse.json({ ok: false, error: 'agentId must be a roster agent id.' }, { status: 400 });
    }
    const result = await applyControlAction({
      agentId: raw.agentId,
      action: action as Exclude<AgentControlActionKind, 'SAVE_CONFIG' | 'SAVE_RESTART' | 'ROLLBACK' | 'STOP_ALL' | 'RESUME_ALL'>,
      reason,
      changedBy,
      correlationId,
    });
    return actionResponse(result);
  } catch (error) {
    logger.warn('Agent control action failed', { error: String(error).slice(0, 150) });
    return NextResponse.json(
      { ok: false, error: 'Control action failed (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
