// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — POST /api/agent/v1/actions
// ============================================================================
// The single mutating endpoint for external AI agents. Full chain:
//
//   authenticate (AGENT_*_TOKEN, server-side, constant-time)
//     → rate limit (per credential, durable)
//     → strict body guard (size caps, JSON object, pollution-safe)
//     → validate schema (Zod v1 contract)
//     → authorize capability (server-derived grant)
//     → validate resource + safety/halal gate (locally re-derived)
//     → budget/rate limit
//     → idempotency (unique requestId)
//     → dispatch through the EXISTING Job Runner
//     → persist audit (AgentActionRecord + SecurityEvent)
//     → return structured AgentResponse / AgentError
//
// The caller NEVER supplies userId, role, admin, permissions, or job types.
// Payload content is DATA; it is never executed, interpolated into SQL or
// prompts, or allowed to name the work performed.
// ============================================================================

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { readJsonBody } from '@/lib/security/guard';
import { authenticateAgentRequest } from '@/lib/agent-contract/credentials';
import { validateAgentRequest } from '@/lib/agent-contract/contract';
import { processAgentAction } from '@/lib/agent-contract/processor';
import { auditAgentEvent, refusalDetail } from '@/lib/agent-contract/audit';
import { enforceRateLimit, clientIpFrom, type RateLimitVerdict } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // ---- 1. AUTHENTICATE (server-derived identity; no client-asserted trust) --
  const auth = authenticateAgentRequest(request.headers.get('authorization'));
  if (!auth.ok) {
    await auditAgentEvent('AGENT_AUTH_FAILURE', 'refused', auth.configured ? 'bad-credential' : 'not-configured');
    logger.warn('Agent action refused at auth', { status: auth.status });
    return NextResponse.json(
      {
        contractVersion: 'v1',
        requestId: null,
        correlationId: null,
        code: auth.status === 503 ? 'NOT_CONFIGURED' : 'UNAUTHORIZED',
        message: auth.error,
        details: [],
        timestamp: new Date().toISOString(),
      },
      { status: auth.status },
    );
  }

  // ---- 2. PER-CREDENTIAL RATE LIMIT (durable, shared across instances) ------
  const limit: RateLimitVerdict = await enforceRateLimit({
    surface: 'agent:v1:auth',
    identity: auth.identity.fingerprint,
    max: 120,
    windowSeconds: 60,
  });
  if (!limit.allowed) {
    await auditAgentEvent('AGENT_AUTH_FLOOD', 'refused', 'per-credential');
    return NextResponse.json(
      {
        contractVersion: 'v1',
        requestId: null,
        correlationId: null,
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded. Retry later.',
        details: [],
        timestamp: new Date().toISOString(),
      },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  // ---- 3. STRICT BODY GUARD (size caps before schema work) ------------------
  const bodyGuard = await readJsonBody(request, { surface: 'agent:v1:actions', maxBytes: 24 * 1024, maxChars: 12_000 });
  if (!bodyGuard.ok) {
    await auditAgentEvent('AGENT_BODY_REJECTED', 'refused', bodyGuard.status === 413 ? 'too-large' : 'malformed');
    return NextResponse.json(
      {
        contractVersion: 'v1',
        requestId: null,
        correlationId: null,
        code: bodyGuard.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
        message: bodyGuard.error,
        details: [],
        timestamp: new Date().toISOString(),
      },
      { status: bodyGuard.status },
    );
  }

  // ---- 4. SCHEMA VALIDATION (Zod v1 contract, unknown fields rejected) ------
  const validation = validateAgentRequest(bodyGuard.value);
  if (!validation.ok) {
    await auditAgentEvent('AGENT_SCHEMA_REJECTED', 'refused', refusalDetail(validation.code, null));
    return NextResponse.json(
      {
        contractVersion: 'v1',
        requestId: null,
        correlationId: null,
        code: validation.code,
        message: 'Request failed Agent Integration Contract v1 validation.',
        details: validation.errors,
        timestamp: new Date().toISOString(),
      },
      { status: validation.httpStatus },
    );
  }

  const parsedRequest = validation.request;

  // The identity the CLIENT asserts for agentId is advisory; the server binds
  // the request to the CREDENTIAL's agentId and refuses a mismatch instead of
  // trusting the body. This keeps audit rows unambiguous without giving the
  // body any authority.
  if (parsedRequest.agentId !== auth.identity.agentId) {
    await auditAgentEvent('AGENT_IDENTITY_MISMATCH', 'refused', refusalDetail('UNAUTHORIZED', parsedRequest.correlationId));
    return NextResponse.json(
      {
        contractVersion: 'v1',
        requestId: parsedRequest.requestId,
        correlationId: parsedRequest.correlationId,
        code: 'UNAUTHORIZED',
        message: 'The request agentId does not match the authenticated credential binding.',
        details: [],
        timestamp: new Date().toISOString(),
      },
      { status: 401 },
    );
  }

  // ---- 5. RESOURCE LOOKUP (only the halal status the gates need) ------------
  const opportunityId = typeof parsedRequest.payload.opportunityId === 'string' ? parsedRequest.payload.opportunityId.slice(0, 128) : null;
  const resource = { opportunityId, halalStatus: null as string | null };
  if (opportunityId) {
    try {
      // Narrow projection: one column, parameterized — no raw SQL anywhere.
      const { db } = await import('@/lib/db');
      const row = await db.opportunity.findUnique({ where: { id: opportunityId }, select: { halalStatus: true } });
      resource.halalStatus = row?.halalStatus ?? null;
    } catch {
      resource.halalStatus = null; // unknown → gates treat as not-on-file
    }
  }

  // ---- 6..10. PROCESSOR (authorize → safety → budget → idempotency → dispatch → audit)
  const result = await processAgentAction(
    { request: parsedRequest, identity: auth.identity, resource },
    { rate: (opts) => enforceRateLimit({ ...opts, identity: `${auth.identity.credentialLabel}:${clientIpFrom(request)}` }) },
  );

  if (!result.ok) {
    logger.warn('Agent action refused', { code: result.response.code, status: result.httpStatus });
  }
  return NextResponse.json(result.response, { status: result.httpStatus });
}
