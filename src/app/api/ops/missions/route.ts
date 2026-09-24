// Phase 8A — Mission API.
// GET  /api/ops/missions → recent missions (safe fields).
// POST /api/ops/missions → create a durable mission (idempotent on correlationId).

import { NextResponse } from 'next/server';
import { createMission, listMissions } from '@/lib/ops/missions';
import { clientIpFrom, enforceRateLimit, auditSecurityEvent, guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:ops/missions:get', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:ops/missions:get', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  try {
    const missions = await listMissions(40);
    return NextResponse.json({ ok: true, missions });
  } catch {
    return NextResponse.json({ ok: false, error: 'Missions unavailable (storage error). Nothing was fabricated.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:ops/missions', { max: 30, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  const bodyGuard = await readJsonBody(request, { surface: 'api:ops/missions', maxChars: 8_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (typeof raw.objective !== 'string' || typeof raw.agentType !== 'string' || typeof raw.correlationId !== 'string') {
    return NextResponse.json({ ok: false, error: 'objective, agentType, and correlationId are required strings.' }, { status: 400 });
  }
  try {
    const result = await createMission({
      objective: raw.objective,
      agentType: raw.agentType,
      correlationId: raw.correlationId,
      ...(typeof raw.opportunityId === 'string' ? { opportunityId: raw.opportunityId } : {}),
      ...(typeof raw.budgetUsd === 'number' ? { budgetUsd: raw.budgetUsd } : {}),
      ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
      ...(typeof raw.expectedOutput === 'string' ? { expectedOutput: raw.expectedOutput } : {}),
      ...(typeof raw.successCriteria === 'string' ? { successCriteria: raw.successCriteria } : {}),
      ...(typeof raw.failureCriteria === 'string' ? { failureCriteria: raw.failureCriteria } : {}),
      ...(typeof raw.approvalRequired === 'boolean' ? { approvalRequired: raw.approvalRequired } : {}),
      ...(Array.isArray(raw.constraints) ? { constraints: raw.constraints as string[] } : {}),
      ...(Array.isArray(raw.allowedCapabilities) ? { allowedCapabilities: raw.allowedCapabilities as never } : {}),
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error, errors: result.errors }, { status: 400 });
    }
    return NextResponse.json({ ok: true, mission: result.mission, deduplicated: result.deduplicated }, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    logger.error('Mission create failed', { error: String(error) });
    return NextResponse.json({ ok: false, error: 'Mission create failed (storage error). Nothing was fabricated.' }, { status: 503 });
  }
}
