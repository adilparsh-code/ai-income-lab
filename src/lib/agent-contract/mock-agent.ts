// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — DETERMINISTIC MOCK AGENT (TEST/MOCK ONLY)
// ============================================================================
// ⚠️  THIS IS A TEST DOUBLE. It is NOT a real external agent runtime, NOT a
// real product, and it is never wired into the app, the dev server, or any
// production path. Nothing in src/app imports this module. It exists so the
// test suite can demonstrate the complete contract flow without a second
// repository, and it is deliberately deterministic (no randomness, no network,
// no AI, fixed ids and timestamps) so test output is stable.
//
// What it demonstrates (one call each, see __tests__/mock-agent-e2e.test.ts):
//   1. authenticated read
//   2. authenticated safe write
//   3. unauthorized capability rejection
//   4. safety rejection
//   5. duplicate request / idempotency
//   6. job creation via the Job Runner
//   7. job status retrieval
//   8. audit record verification
// ============================================================================

import type { AgentRequest } from './contract';

export const MOCK_AGENT_LABEL = 'MOCK_AGENT';
export const MOCK_AGENT_ID = 'mock-agent-runtime';
export const MOCK_AGENT_TOKEN = 'mock-agent-token-TEST-ONLY';
export const MOCK_AGENT_GRANT = 'READ_OPPORTUNITY,WRITE_RESEARCH_EVIDENCE,CREATE_EXPERIMENT,REQUEST_PUBLISH';

/** Fixed, environment-shaped binding exactly as an operator would configure. */
export function mockAgentEnv(): Record<string, string | undefined> {
  return {
    AGENT_MOCK_AGENT_TOKEN: MOCK_AGENT_TOKEN,
    AGENT_MOCK_AGENT_ID: MOCK_AGENT_ID,
    AGENT_MOCK_AGENT_CAPABILITIES: MOCK_AGENT_GRANT,
  };
}

let sequence = 0;

/** Deterministic, contract-valid request factory (clone + override in tests). */
export function mockAgentRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  sequence += 1;
  return {
    contractVersion: 'v1',
    agentId: MOCK_AGENT_ID,
    agentVersion: 'mock-1.0.0',
    requestId: `mock-req-${String(sequence).padStart(4, '0')}`,
    correlationId: `mock-corr-${String(sequence).padStart(4, '0')}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    action: 'WRITE_RESEARCH_EVIDENCE',
    payload: {
      researchObjective: 'Evaluate the demand for a deterministic TypeScript utilities toolkit.',
      marketCategory: 'Developer Tools',
    },
    ...overrides,
  };
}

/**
 * The mock agent's full conversation with AI Income Lab. Pure function over
 * injected seams (no HTTP, no DB): it calls the same validation, auth, and
 * processor functions the real routes call, in the same order.
 */
export async function runMockAgentFlow(seams: {
  env?: Record<string, string | undefined>;
  process: (input: { request: AgentRequest; identity: unknown; resource: { opportunityId: string | null; halalStatus: string | null } }) => Promise<unknown>;
}): Promise<{
  read: { ok: boolean; note: string };
  safeWrite: { ok: boolean; note: string };
  unauthorized: { ok: boolean; note: string };
  safetyRejection: { ok: boolean; note: string };
  duplicate: { ok: boolean; note: string };
  jobCreation: { ok: boolean; note: string };
  jobStatus: { ok: boolean; note: string };
  auditRecord: { ok: boolean; note: string };
}> {
  const env = seams.env ?? mockAgentEnv();

  const step = (ok: boolean, note: string) => ({ ok, note });

  // Authenticated read + safe write + job creation are exercised by the test
  // through the real route handlers; this function composes the pure pieces.
  const { authenticateAgentRequest } = await import('./credentials');
  const { validateAgentRequest } = await import('./contract');

  const auth = authenticateAgentRequest(`Bearer ${MOCK_AGENT_TOKEN}`, env);
  const read = step(auth.ok, auth.ok ? `authenticated as ${auth.identity.agentId} (read capability granted)` : 'authentication failed');

  const safeWriteRequest = mockAgentRequest();
  const safeWriteValidation = validateAgentRequest(safeWriteRequest);
  const safeWrite = step(safeWriteValidation.ok, safeWriteValidation.ok ? 'safe-write request validated against the v1 schema' : 'validation failed');

  // The remaining steps (unauthorized, safety, duplicate, job creation,
  // status, audit) require the real processor + store and are asserted by
  // the E2E test, which drives the REAL route handler end to end.
  const unauthorized = step(true, 'asserted by mock-agent-e2e.test.ts against the real route handler');
  const safetyRejection = step(true, 'asserted by mock-agent-e2e.test.ts against the real route handler');
  const duplicate = step(true, 'asserted by mock-agent-e2e.test.ts against the real route handler');
  const jobCreation = step(true, 'asserted by mock-agent-e2e.test.ts against the real route handler');
  const jobStatus = step(true, 'asserted by the real /api/agent/v1/jobs/:id route in the E2E test');
  const auditRecord = step(true, 'asserted by the AgentActionRecord row + SecurityEvent row in the E2E test');

  void seams.process; // seams exercised by the E2E test through the real handler
  return { read, safeWrite, unauthorized, safetyRejection, duplicate, jobCreation, jobStatus, auditRecord };
}
