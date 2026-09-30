// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — GET /api/agent/v1/health
// ============================================================================
// Truthful health for external agents, derived from REAL facts only:
// credential configuration, database reachability, and the caller's grant.
// States: READY | DEGRADED | BLOCKED | NOT_CONFIGURED | NOT_CONNECTED.
// No state is ever manually flipped and no runtime is claimed LIVE without
// real verification. BLOCKED is reserved for the operator pause switch, which
// composes the existing AgencyControl pause (no new control plane).
// ============================================================================

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateAgentRequest } from '@/lib/agent-contract/credentials';
import { AGENT_CAPABILITIES } from '@/lib/agent-contract/capabilities';
import { deriveAgentHealth } from '@/lib/agent-contract/reads';
import { auditAgentEvent } from '@/lib/agent-contract/audit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = authenticateAgentRequest(request.headers.get('authorization'));

  // Health is useful to an authenticated agent; unauthenticated callers get
  // the honest refusal (never a free capability/status oracle).
  if (!auth.ok) {
    await auditAgentEvent('AGENT_AUTH_FAILURE', 'refused', auth.configured ? 'bad-credential' : 'not-configured', 'api:agent:v1:health');
    return NextResponse.json(
      {
        contractVersion: 'v1',
        status: auth.status === 503 ? 'NOT_CONFIGURED' : 'NOT_CONNECTED',
        message: auth.error,
        timestamp: new Date().toISOString(),
      },
      { status: auth.status },
    );
  }

  const health = await deriveAgentHealth(auth.identity.grantedCapabilities);

  // BLOCKED: the operator's global agency pause is active — real fact, real
  // source (AgencyControl), not a made-up state. Absence of a control row or
  // any DB error keeps the derived status (fail-open for a READ here is safe:
  // it only downgrades to the pre-computed READY/DEGRADED verdict).
  let status = health.status;
  if (status === 'READY' || status === 'DEGRADED') {
    try {
      const control = await db.agencyControl.findUnique({ where: { key: 'autonomy' } });
      if (control?.paused) {
        status = 'BLOCKED';
        health.reasons.push('The operator has paused autonomous agency activity (AgencyControl.paused).');
      }
    } catch {
      // control row unavailable → keep the derived status
    }
  }

  await auditAgentEvent('AGENT_HEALTH_CHECK', 'ok', `status=${status}`, 'api:agent:v1:health');

  return NextResponse.json({
    contractVersion: 'v1',
    agentId: auth.identity.agentId,
    status,
    credentialsConfigured: health.credentialsConfigured,
    databaseReachable: health.databaseReachable,
    capabilities: AGENT_CAPABILITIES.map((c) => ({
      id: c.id,
      authority: c.authority,
      granted: auth.identity.grantedCapabilities.includes(c.id),
    })),
    reasons: health.reasons,
    timestamp: new Date().toISOString(),
  });
}
