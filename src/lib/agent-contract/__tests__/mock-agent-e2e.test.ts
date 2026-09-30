// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — MOCK AGENT E2E (hermetic, real handlers)
// ============================================================================
// Drives the REAL route handlers (actions, capabilities, health, jobs/:id)
// against a temporary SQLite database. Demonstrates the required flow:
//   1. authenticated read            5. duplicate request / idempotency
//   2. authenticated safe write      6. job creation (Job Runner)
//   3. unauthorized capability       7. job status retrieval
//   4. safety rejection              8. audit record
// The mock agent is a TEST DOUBLE (see src/lib/agent-contract/mock-agent.ts);
// it is NOT a real external runtime and nothing here claims otherwise.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-agent-v1-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  // The mock agent's credential binding — exactly as an operator would set it.
  AGENT_MOCK_AGENT_TOKEN: 'mock-agent-token-TEST-ONLY',
  AGENT_MOCK_AGENT_ID: 'mock-agent-runtime',
  AGENT_MOCK_AGENT_CAPABILITIES: 'READ_OPPORTUNITY,WRITE_RESEARCH_EVIDENCE,CREATE_EXPERIMENT,REQUEST_PUBLISH',
  SECURITY_FINGERPRINT_SALT: 'agent-v1-test-salt',
  AI_PROVIDER: 'mock',
});
// NOTE: env mutations in this file are scoped to this test process only; the
// test runner spawns a fresh process per run, so no restoration is required.

before(async () => {
  const { installTestDatabase } = await import('@/test-utils/install-test-database');
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

// ---------------------------------------------------------------------------
// Route handlers under test (the REAL ones)
// ---------------------------------------------------------------------------

type ActionsRoute = typeof import('../../../app/api/agent/v1/actions/route');
type CapsRoute = typeof import('../../../app/api/agent/v1/capabilities/route');
type HealthRoute = typeof import('../../../app/api/agent/v1/health/route');
type JobsRoute = typeof import('../../../app/api/agent/v1/jobs/[id]/route');

let actionsRoute: ActionsRoute;
let capsRoute: CapsRoute;
let healthRoute: HealthRoute;
let jobsRoute: JobsRoute;

const TOKEN = 'mock-agent-token-TEST-ONLY';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/agent/v1/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
}

let seq = 0;
function baseRequest(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    contractVersion: 'v1',
    agentId: 'mock-agent-runtime',
    agentVersion: 'mock-1.0.0',
    requestId: `e2e-req-${String(seq).padStart(4, '0')}`,
    correlationId: `e2e-corr-${String(seq).padStart(4, '0')}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    action: 'WRITE_RESEARCH_EVIDENCE',
    payload: {
      researchObjective: 'Evaluate the demand for a deterministic TypeScript utilities toolkit.',
      marketCategory: 'Developer Tools',
    },
    ...overrides,
  };
}

before(async () => {
  actionsRoute = await import('../../../app/api/agent/v1/actions/route');
  capsRoute = await import('../../../app/api/agent/v1/capabilities/route');
  healthRoute = await import('../../../app/api/agent/v1/health/route');
  jobsRoute = await import('../../../app/api/agent/v1/jobs/[id]/route');
});

describe('v1 actions: authentication', () => {
  it('401s a missing credential', async () => {
    const res = await actionsRoute.POST(post(baseRequest(), { authorization: '' }));
    // Route reads the header itself; empty authorization string → no Bearer → 401.
    assert.equal(res.status, 401);
  });

  it('401s a wrong credential', async () => {
    const res = await actionsRoute.POST(post(baseRequest(), { authorization: 'Bearer wrong-token-value' }));
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.code, 'UNAUTHORIZED');
  });

  it('rejects a body agentId that mismatches the credential binding', async () => {
    const res = await actionsRoute.POST(post(baseRequest({ agentId: 'someone-else' })));
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.code, 'UNAUTHORIZED');
  });
});

describe('v1 actions: schema + payload', () => {
  it('400s a malformed JSON body', async () => {
    const res = await actionsRoute.POST(
      new Request('http://localhost/api/agent/v1/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: '{not json',
      }),
    );
    assert.equal(res.status, 400);
  });

  it('400s a schema-invalid request (unknown field, bad action)', async () => {
    const res = await actionsRoute.POST(post(baseRequest({ jobType: 'PUBLISH_NOW' })));
    assert.equal(res.status, 400);

    const badAction = await actionsRoute.POST(post(baseRequest({ action: 'NUKE Everything' })));
    assert.equal(badAction.status, 400);
  });

  it('413s an oversized payload', async () => {
    const res = await actionsRoute.POST(post(baseRequest({ payload: { blob: 'x'.repeat(30_000) } })));
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.code, 'PAYLOAD_TOO_LARGE');
  });
});

describe('v1 actions: unauthorized capability', () => {
  it('403s a capability outside the grant', async () => {
    const res = await actionsRoute.POST(post(baseRequest({ action: 'CREATE_PRODUCT_PLAN', payload: { objective: 'Plan a bounded product.' } })));
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.code, 'FORBIDDEN_CAPABILITY');
  });
});

describe('v1 actions: safety', () => {
  it('409s prohibited content before any dispatch', async () => {
    const res = await actionsRoute.POST(post(baseRequest({
      payload: { researchObjective: 'Grow a gambling casino betting affiliate scheme.' },
    })));
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, 'SAFETY_BLOCKED');
  });

  it('202s REVIEW_REQUIRED content into a human review (no job)', async () => {
    const res = await actionsRoute.POST(post(baseRequest({
      // "wine" is flagged REVIEW_REQUIRED by the existing deterministic gate.
      payload: { researchObjective: 'Wine tasting club subscription with paid membership tiers.' },
    })));
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.status, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(json.jobId, null);
    assert.ok(json.reviewId);
  });
});

describe('v1 actions: idempotency + job creation', () => {
  it('creates exactly one job across a duplicate replay, then reads it back', async () => {
    const body = baseRequest();
    const first = await actionsRoute.POST(post(body));
    assert.equal(first.status, 201, 'first submission accepted');
    const firstJson = await first.json();
    assert.equal(firstJson.status, 'ACCEPTED');
    assert.ok(firstJson.jobId);
    const jobId = firstJson.jobId as string;

    const replay = await actionsRoute.POST(post(body)); // identical body
    assert.equal(replay.status, 200, 'replay collapses to DUPLICATE');
    const replayJson = await replay.json();
    assert.equal(replayJson.status, 'DUPLICATE');
    assert.equal(replayJson.jobId, jobId, 'replay returns the stored job id');

    // 7. job status retrieval through the ownership-checked route
    const jobRes = await jobsRoute.GET(getRequest(`http://localhost/api/agent/v1/jobs/${jobId}`), { params: Promise.resolve({ id: jobId }) });
    assert.equal(jobRes.status, 200);
    const jobJson = await jobRes.json();
    assert.equal(jobJson.job.id, jobId);
    assert.equal(jobJson.job.correlationId.startsWith('agent:mock-agent-runtime:'), true);

    // A different agent's job id is indistinguishable from nonexistent.
    const foreign = await jobsRoute.GET(getRequest('http://localhost/api/agent/v1/jobs/definitely-not-mine'), { params: Promise.resolve({ id: 'definitely-not-mine' }) });
    assert.equal(foreign.status, 404);
  });

  it('persists an audit record with fingerprint (never the token)', async () => {
    const body = baseRequest();
    await actionsRoute.POST(post(body));
    const { db } = await import('@/lib/db');
    const row = await db.agentActionRecord.findUnique({ where: { requestId: body.requestId } });
    assert.ok(row, 'AgentActionRecord row exists');
    assert.equal(row.agentId, 'mock-agent-runtime');
    assert.equal(row.authorizationResult, 'ALLOWED');
    assert.equal(row.safetyVerdict, 'HALAL');
    assert.ok(row.agentFingerprint.length === 16);
    assert.equal(JSON.stringify(row).includes(TOKEN), false);

    const event = await db.securityEvent.findFirst({
      where: { surface: 'api:agent:v1', kind: 'AGENT_ACTION_ACCEPTED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(event, 'SecurityEvent audit row exists');
    assert.equal(JSON.stringify(event).includes(TOKEN), false);
  });
});

describe('v1 capabilities + health + mock agent flow', () => {
  it('returns only this credential\u2019s capability view', async () => {
    const res = await capsRoute.GET(getRequest('http://localhost/api/agent/v1/capabilities'));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.agentId, 'mock-agent-runtime');
    const granted = json.capabilities.filter((c: { granted: boolean }) => c.granted);
    assert.equal(granted.length, 4);
  });

  it('reports truthful health (READY with real config + DB)', async () => {
    const res = await healthRoute.GET(getRequest('http://localhost/api/agent/v1/health'));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, 'READY');
    assert.equal(json.credentialsConfigured, true);
    assert.equal(json.databaseReachable, true);
  });

  it('health reports NOT_CONNECTED for an unauthenticated caller (no oracle)', async () => {
    const res = await healthRoute.GET(new Request('http://localhost/api/agent/v1/health'));
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.status, 'NOT_CONNECTED');
  });

  it('runs the deterministic mock-agent flow summary', async () => {
    const { runMockAgentFlow } = await import('@/lib/agent-contract/mock-agent');
    const summary = await runMockAgentFlow({
      env: process.env as Record<string, string | undefined>,
      process: async () => null,
    });
    for (const value of Object.values(summary)) {
      assert.equal(value.ok, true);
    }
  });

  it('capability descriptions never leak internals', async () => {
    const res = await capsRoute.GET(getRequest('http://localhost/api/agent/v1/capabilities'));
    const json = await res.json();
    const serialized = JSON.stringify(json).toLowerCase();
    for (const banned of ['password', 'token =', 'secret', 'process.env']) {
      assert.equal(serialized.includes(banned), false, `leaked "${banned}"`);
    }
  });
});
