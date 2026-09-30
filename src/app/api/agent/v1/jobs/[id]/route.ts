// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — GET /api/agent/v1/jobs/:id
// ============================================================================
// Minimum read interface for an agent to poll the status of a job IT created
// through /api/agent/v1/actions. Ownership is enforced by construction: the
// Job Runner correlation was namespaced with the credential's agentId, so an
// agent can only ever see its own work (no IDOR, no cross-agent enumeration).
//
// Returns the compact safe summary only — never the raw job input payload,
// never other agents' jobs, never operator data.
// ============================================================================

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateAgentRequest } from '@/lib/agent-contract/credentials';
import { auditAgentEvent } from '@/lib/agent-contract/audit';

export const dynamic = 'force-dynamic';

const AGENT_CORRELATION_PREFIX = 'agent:';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = authenticateAgentRequest(request.headers.get('authorization'));
  if (!auth.ok) {
    await auditAgentEvent('AGENT_AUTH_FAILURE', 'refused', auth.configured ? 'bad-credential' : 'not-configured', 'api:agent:v1:jobs');
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

  const { id } = await params;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return NextResponse.json(
      { contractVersion: 'v1', code: 'INVALID_REQUEST', message: 'Invalid job id.', timestamp: new Date().toISOString() },
      { status: 400 },
    );
  }

  try {
    const row = await db.jobRun.findUnique({
      where: { id },
      select: {
        id: true,
        jobType: true,
        status: true,
        correlationId: true,
        opportunityId: true,
        agentType: true,
        executionMode: true,
        retryCount: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        error: true,
        output: true,
      },
    });

    if (!row) {
      await auditAgentEvent('AGENT_JOB_LOOKUP_MISS', 'refused', `agent=${auth.identity.agentId.slice(0, 40)}`, 'api:agent:v1:jobs');
      // Indistinguishable from "not yours" on purpose: no existence oracle.
      return NextResponse.json(
        { contractVersion: 'v1', code: 'NOT_FOUND', message: 'Job not found for this agent.', timestamp: new Date().toISOString() },
        { status: 404 },
      );
    }

    // Ownership: the agent namespace is embedded in the correlation id at
    // dispatch time. A job dispatched by anyone else (operator, Ruflo,
    // handoff, another agent) is invisible here.
    const prefix = `${AGENT_CORRELATION_PREFIX}${auth.identity.agentId}:`;
    if (!row.correlationId.startsWith(prefix)) {
      await auditAgentEvent('AGENT_JOB_LOOKUP_FOREIGN', 'refused', `agent=${auth.identity.agentId.slice(0, 40)}`, 'api:agent:v1:jobs');
      return NextResponse.json(
        { contractVersion: 'v1', code: 'NOT_FOUND', message: 'Job not found for this agent.', timestamp: new Date().toISOString() },
        { status: 404 },
      );
    }

    let output: unknown = null;
    try {
      output = row.output ? JSON.parse(row.output) : null;
    } catch {
      output = null;
    }

    return NextResponse.json({
      contractVersion: 'v1',
      job: {
        id: row.id,
        jobType: row.jobType,
        status: row.status,
        correlationId: row.correlationId,
        opportunityId: row.opportunityId,
        executionMode: row.executionMode,
        retryCount: row.retryCount,
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        error: row.error,
        output,
      },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      { contractVersion: 'v1', code: 'INTERNAL_ERROR', message: 'Job lookup failed. Check the server logs.', timestamp: new Date().toISOString() },
      { status: 500 },
    );
  }
}
