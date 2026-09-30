// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — GET /api/agent/v1/capabilities
// ============================================================================
// Returns the authenticated agent's server-derived capability view: which
// capabilities exist, which are granted to THIS credential, and each one's
// write authority. No secrets, no operator data, no other agents' grants.
// ============================================================================

import { NextResponse } from 'next/server';
import { authenticateAgentRequest } from '@/lib/agent-contract/credentials';
import { AGENT_CAPABILITIES } from '@/lib/agent-contract/capabilities';
import { auditAgentEvent } from '@/lib/agent-contract/audit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = authenticateAgentRequest(request.headers.get('authorization'));
  if (!auth.ok) {
    await auditAgentEvent('AGENT_AUTH_FAILURE', 'refused', auth.configured ? 'bad-credential' : 'not-configured', 'api:agent:v1:capabilities');
    return NextResponse.json(
      {
        contractVersion: 'v1',
        code: auth.status === 503 ? 'NOT_CONFIGURED' : 'UNAUTHORIZED',
        message: auth.error,
        timestamp: new Date().toISOString(),
      },
      { status: auth.status },
    );
  }

  return NextResponse.json({
    contractVersion: 'v1',
    agentId: auth.identity.agentId,
    capabilities: AGENT_CAPABILITIES.map((c) => ({
      id: c.id,
      authority: c.authority,
      granted: auth.identity.grantedCapabilities.includes(c.id),
      jobType: c.jobType,
      requiresHalalScreening: c.halalScreened,
      description: c.description,
    })),
    timestamp: new Date().toISOString(),
  });
}
