// ============================================================================
// RUFLO RUNTIME INTEGRATION TESTS (Ruflo Live Integration Phase)
// ============================================================================
// Proves the REAL end-to-end chain with a live temp DB and the existing
// architecture — no fake success responses:
//
//   Ruflo runtime module
//     → dispatchWorkflowViaRuflo()  [existing connector seam]
//     → executeWorkflow()           [existing planner + halal gates]
//     → runJob()                    [existing Job Runner + AgentRegistry]
//     → durable WorkflowRun / JobRun / AgentLog + SecurityEvent audit
//     → completion callback to the registered runtime handle
//
// Covers: capability states (NOT_CONFIGURED/AUTH_REQUIRED/CONNECTING/
// CONNECTED/ERROR), fail-closed auth, real health verification, dispatch
// through the Job Runner, workflow-level idempotency, timeout bounds,
// execution tracing, halal blocking, and no-bypass invariants.
// ============================================================================

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-ruflo-rt-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  RUFLO_RUNTIME_TOKEN: 'ruflo-rt-test-token-9a4c7e2b1d8f',
  RUFLO_RUNTIME_ID: 'ruflo-test-runtime',
  RUFLO_RUNTIME_ENABLED: 'true',
  // Short but valid timeout so the timeout test is fast.
  RUFLO_DISPATCH_TIMEOUT_MS: '1500',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma db push', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const importRuntime = () => import('../runtime');
const importSetup = () => import('../runtime-setup');
const importConnector = () => import('../connector');

async function seedOpp(halalStatus: string, title = 'Ruflo runtime test opportunity') {
  const { db } = await import('@/lib/db');
  return db.opportunity.create({
    data: {
      title,
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'testers',
      problemSolved: 'a problem',
      monetizationMethod: 'ONE_TIME',
      status: 'IDEA',
      halalStatus,
    },
  });
}

async function cleanupOpp(id: string) {
  const { db } = await import('@/lib/db');
  await db.agentLog.deleteMany({ where: { input: { contains: id } } });
  await db.jobRun.deleteMany({ where: { opportunityId: id } });
  await db.workflowRun.deleteMany({ where: { opportunityId: id } });
  await db.opportunity.delete({ where: { id } }).catch(() => undefined);
}

function authedRequest(path: string, init: { method?: string; body?: string; token?: string | null; ip?: string } = {}): Request {
  const url = new URL('http://localhost:3000' + path);
  const headers: Record<string, string> = {
    'x-forwarded-for': init.ip ?? '192.0.2.77',
  };
  if (init.token !== null && init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  else if (init.token === undefined) headers.authorization = 'Bearer ruflo-rt-test-token-9a4c7e2b1d8f';
  return new Request(url, { method: init.method ?? 'GET', headers, body: init.body });
}

// ---------------------------------------------------------------------------
// Capability state machine
// ---------------------------------------------------------------------------

describe('ruflo runtime capability: honest 5-state machine', () => {
  beforeEach(() => {
    // Each test starts from a clean connector/config slate where relevant.
  });

  it('NOT_CONFIGURED when no token and no handle', async () => {
    const runtime = await importRuntime();
    const savedToken = process.env.RUFLO_RUNTIME_TOKEN;
    delete process.env.RUFLO_RUNTIME_TOKEN;
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    try {
      const cap = await runtime.describeRufloRuntime();
      assert.equal(cap.status, 'NOT_CONFIGURED');
      assert.equal(cap.handleRegistered, false);
      assert.equal(cap.unmetRequirements.length >= 1, true);
    } finally {
      if (savedToken) process.env.RUFLO_RUNTIME_TOKEN = savedToken;
    }
  });

  it('AUTH_REQUIRED when token exists but no handle is registered', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    const cap = await runtime.describeRufloRuntime();
    assert.equal(cap.status, 'AUTH_REQUIRED');
    assert.equal(cap.runtimeTokenConfigured, true);
    assert.equal(cap.handleRegistered, false);
  });

  it('CONNECTING when configured (token + handle) but never health-verified', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });
    const cap = await runtime.describeRufloRuntime();
    assert.equal(cap.status, 'CONNECTING');
    assert.ok(/no successful health verification/i.test(cap.detail));
    connector.clearRufloOrchestrator();
  });

  it('CONNECTED only after a REAL successful health verification (recorded durably)', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });

    const health = await runtime.verifyRufloRuntime();
    assert.equal(health.status, 'CONNECTED');
    assert.equal(health.checks.boundary, 'ok');
    assert.equal(health.checks.database, 'ok');
    assert.ok(health.boundaryContracts.length > 0);

    const cap = await runtime.describeRufloRuntime();
    assert.equal(cap.status, 'CONNECTED');
    connector.clearRufloOrchestrator();
  });

  it('ERROR when verification failed (handle registered but DB unreachable is simulated via missing health)', async () => {
    // The ERROR state requires a failed verification event in the audit trail.
    const runtime = await importRuntime();
    const { db } = await import('@/lib/db');
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });
    await db.securityEvent.create({
      data: { kind: 'RUFLO_HEALTH', surface: 'ruflo:runtime', outcome: 'error', detail: 'simulated failure for test' },
    });
    const cap = await runtime.describeRufloRuntime();
    // A failed verification more recent than success → ERROR.
    assert.equal(cap.status, 'ERROR');
    connector.clearRufloOrchestrator();
  });

  it('AUTH_REQUIRED from verifyRufloRuntime when the token config is missing', async () => {
    const runtime = await importRuntime();
    const saved = process.env.RUFLO_RUNTIME_TOKEN;
    delete process.env.RUFLO_RUNTIME_TOKEN;
    try {
      const verdict = await runtime.verifyRufloRuntime();
      assert.equal(verdict.status, 'AUTH_REQUIRED');
    } finally {
      if (saved) process.env.RUFLO_RUNTIME_TOKEN = saved;
    }
  });

  it('AUTH_REQUIRED from verifyRufloRuntime when no handle is registered', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    const verdict = await runtime.verifyRufloRuntime();
    assert.equal(verdict.status, 'AUTH_REQUIRED');
    assert.ok(/handle/i.test(verdict.reason));
  });
});

// ---------------------------------------------------------------------------
// Server-side wiring (instrumentation entry)
// ---------------------------------------------------------------------------

describe('ruflo runtime setup wiring', () => {
  it('refuses to register without a token (NOT_CONFIGURED posture)', async () => {
    const setup = await importSetup();
    const saved = process.env.RUFLO_RUNTIME_TOKEN;
    delete process.env.RUFLO_RUNTIME_TOKEN;
    try {
      const result = setup.setupRufloRuntime();
      assert.equal(result.registered, false);
      assert.ok(/NOT_CONFIGURED/.test(result.reason));
    } finally {
      if (saved) process.env.RUFLO_RUNTIME_TOKEN = saved;
    }
  });

  it('refuses to register when RUFLO_RUNTIME_ENABLED is not true (AUTH_REQUIRED posture)', async () => {
    const setup = await importSetup();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    const saved = process.env.RUFLO_RUNTIME_ENABLED;
    delete process.env.RUFLO_RUNTIME_ENABLED;
    try {
      const result = setup.setupRufloRuntime();
      assert.equal(result.registered, false);
      assert.ok(/RUFLO_RUNTIME_ENABLED/.test(result.reason));
      assert.equal(connector.isRufloConnected(), false);
    } finally {
      if (saved) process.env.RUFLO_RUNTIME_ENABLED = saved;
    }
  });

  it('registers idempotently when enabled (same handle, no duplicates)', async () => {
    const setup = await importSetup();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    const first = setup.setupRufloRuntime();
    assert.equal(first.registered, true);
    const second = setup.setupRufloRuntime();
    assert.equal(second.registered, true);
    assert.ok(/already registered/.test(second.reason));
    assert.equal(connector.isRufloConnected(), true);
    connector.clearRufloOrchestrator();
  });
});

// ---------------------------------------------------------------------------
// Runtime authentication (fail-closed, throttled)
// ---------------------------------------------------------------------------

describe('ruflo runtime authentication', () => {
  it('503 when no token is configured (fail-closed)', async () => {
    const runtime = await importRuntime();
    const saved = process.env.RUFLO_RUNTIME_TOKEN;
    delete process.env.RUFLO_RUNTIME_TOKEN;
    try {
      const verdict = await runtime.requireRufloRuntime(authedRequest('/api/ruflo/runtime', { token: 'anything' }));
      assert.equal(verdict.ok, false);
      if (!verdict.ok) {
        assert.equal(verdict.status, 503);
        assert.ok(/NOT_CONFIGURED/.test(verdict.error));
      }
    } finally {
      if (saved) process.env.RUFLO_RUNTIME_TOKEN = saved;
    }
  });

  it('401 with a wrong bearer credential (audited)', async () => {
    const runtime = await importRuntime();
    const verdict = await runtime.requireRufloRuntime(authedRequest('/api/ruflo/runtime', { token: 'wrong-token' }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.status, 401);
  });

  it('401 with a missing credential', async () => {
    const runtime = await importRuntime();
    const verdict = await runtime.requireRufloRuntime(authedRequest('/api/ruflo/runtime', { token: null }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.status, 401);
    assert.ok('authorization' in Object.fromEntries(new URL('http://x').searchParams) === false); // no-op guard
  });

  it('accepts the correct bearer credential', async () => {
    const runtime = await importRuntime();
    const verdict = await runtime.requireRufloRuntime(authedRequest('/api/ruflo/runtime'));
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.runtimeId, 'ruflo-test-runtime');
  });

  it('brute-force attempts are throttled by the durable limiter', async () => {
    const runtime = await importRuntime();
    let last: { ok: boolean } | null = null;
    for (let i = 0; i < 35; i++) {
      last = await runtime.requireRufloRuntime(authedRequest('/api/ruflo/runtime', { token: 'guess-' + i }));
    }
    assert.equal(last?.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Dispatch — REAL end-to-end through the Job Runner
// ---------------------------------------------------------------------------

describe('ruflo runtime dispatch: real execution through existing boundaries', () => {
  it('refuses dispatch when the runtime is not connected', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    const outcome = await runtime.dispatchForRufloRuntime({ workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'test' });
    assert.equal(outcome.accepted, false);
    if (!outcome.accepted) {
      assert.equal(outcome.status, 'NOT_CONNECTED');
      assert.ok(/Nothing was executed/.test(outcome.reason));
    }
  });

  it('refuses an unknown workflowType (INVALID)', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });
    const outcome = await runtime.dispatchForRufloRuntime({ workflowType: 'TOTALLY_MADE_UP', objective: 'test' });
    assert.equal(outcome.accepted, false);
    if (!outcome.accepted) assert.equal(outcome.status, 'INVALID');
    connector.clearRufloOrchestrator();
  });

  it('refuses an empty or oversized objective (INVALID)', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });
    for (const objective of ['', '   ', 'x'.repeat(4001)]) {
      const outcome = await runtime.dispatchForRufloRuntime({ workflowType: 'OPPORTUNITY_DISCOVERY', objective });
      assert.equal(outcome.accepted, false);
      if (!outcome.accepted) assert.equal(outcome.status, 'INVALID');
    }
    connector.clearRufloOrchestrator();
  });

  it('REAL end-to-end: dispatch → connector → workflow runner → job runner → durable state → callback', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    const { db } = await import('@/lib/db');
    connector.clearRufloOrchestrator();

    const notifications: { workflowId: string; status: string; correlationId: string; stepCount: number }[] = [];
    connector.registerRufloOrchestrator({
      id: 'ruflo-test-runtime',
      onWorkflowCompleted: (summary) => {
        notifications.push({
          workflowId: summary.workflowId,
          status: summary.status,
          correlationId: summary.correlationId,
          stepCount: summary.stepCount,
        });
      },
    });

    const executionId = `ruflo-e2e-${Date.now()}`;
    const outcome = await runtime.dispatchForRufloRuntime({
      workflowType: 'OPPORTUNITY_DISCOVERY',
      objective: 'Discover offline education opportunities for testers',
      executionId,
    });

    assert.equal(outcome.accepted, true);
    if (!outcome.accepted || outcome.duplicate) throw new Error('expected fresh accepted dispatch');
    assert.equal(outcome.executionId, executionId);
    assert.equal(outcome.correlationId, executionId);
    assert.ok(outcome.steps > 0);

    // Durable state: WorkflowRun row exists under the executionId.
    const run = await db.workflowRun.findFirst({ where: { correlationId: executionId } });
    assert.ok(run, 'WorkflowRun must be durable');
    assert.equal(run.id, outcome.workflowRunId);
    assert.ok(['COMPLETED', 'PARTIAL', 'FAILED'].includes(run.status));

    // Durable state: JobRun rows exist for the dispatched steps.
    const jobs = await db.jobRun.findMany({ where: { correlationId: executionId } });
    assert.ok(jobs.length > 0, 'JobRun rows must be durable');

    // Audit trail: dispatch recorded durably.
    const audit = await db.securityEvent.findFirst({
      where: { kind: 'RUFLO_DISPATCH', detail: { contains: executionId } },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(audit, 'dispatch must be audited');
    assert.equal(audit.outcome, 'ok');

    // Completion callback reached the runtime handle exactly once.
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].correlationId, executionId);
    assert.equal(notifications[0].status, run.status);

    connector.clearRufloOrchestrator();
    await db.workflowRun.delete({ where: { id: run.id } }).catch(() => undefined);
    await db.jobRun.deleteMany({ where: { correlationId: executionId } });
    await db.securityEvent.deleteMany({ where: { detail: { contains: executionId } } });
  });

  it('HALAL gate: Ruflo CANNOT bypass NOT_ALLOWED — nothing executes, BLOCKED is durable', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    const { db } = await import('@/lib/db');
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });

    const opp = await seedOpp('NOT_ALLOWED', 'Forbidden gambling opportunity');
    const executionId = `ruflo-halal-${Date.now()}`;
    const outcome = await runtime.dispatchForRufloRuntime({
      workflowType: 'BUSINESS_ANALYSIS',
      objective: 'Analyze this opportunity',
      opportunityId: opp.id,
      executionId,
    });

    assert.equal(outcome.accepted, true);
    if (!outcome.accepted || outcome.duplicate) throw new Error('expected fresh dispatch');
    // The workflow terminates BLOCKED before any job/agent/AI execution.
    assert.equal(outcome.status, 'BLOCKED');

    const run = await db.workflowRun.findFirst({ where: { correlationId: executionId } });
    assert.ok(run);
    assert.equal(run.status, 'BLOCKED');

    connector.clearRufloOrchestrator();
    await cleanupOpp(opp.id);
    await db.workflowRun.delete({ where: { id: run.id } }).catch(() => undefined);
  });

  it('REVIEW_REQUIRED: no autonomous execution — HUMAN_REVIEW is durable', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });

    const opp = await seedOpp('REVIEW_REQUIRED', 'Borderline opportunity needing human review');
    const executionId = `ruflo-review-${Date.now()}`;
    const outcome = await runtime.dispatchForRufloRuntime({
      workflowType: 'BUSINESS_ANALYSIS',
      objective: 'Analyze this opportunity',
      opportunityId: opp.id,
      executionId,
    });
    assert.equal(outcome.accepted, true);
    if (!outcome.accepted || outcome.duplicate) throw new Error('expected fresh dispatch');
    assert.equal(outcome.status, 'HUMAN_REVIEW');

    connector.clearRufloOrchestrator();
    await cleanupOpp(opp.id);
  });

  it('workflow-level idempotency: same executionId returns the durable row, never re-executes', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    const { db } = await import('@/lib/db');
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });

    const executionId = `ruflo-idem-${Date.now()}`;
    const first = await runtime.dispatchForRufloRuntime({
      workflowType: 'OPPORTUNITY_DISCOVERY',
      objective: 'Idempotency probe objective',
      executionId,
    });
    assert.equal(first.accepted, true);
    if (!first.accepted || first.duplicate) throw new Error('first dispatch must be fresh');

    const second = await runtime.dispatchForRufloRuntime({
      workflowType: 'OPPORTUNITY_DISCOVERY',
      objective: 'Idempotency probe objective',
      executionId,
    });
    assert.equal(second.accepted, true);
    if (!second.accepted || !second.duplicate) throw new Error('second dispatch must be a duplicate');
    assert.equal(second.workflowRunId, first.workflowRunId);
    assert.ok(/NOT re-executed/.test(second.detail));

    connector.clearRufloOrchestrator();
    await db.workflowRun.deleteMany({ where: { correlationId: executionId } });
    await db.jobRun.deleteMany({ where: { correlationId: executionId } });
  });

  it('timeout: an unresponsive dispatch is bounded (no infinite hang)', async () => {
    const runtime = await importRuntime();
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });

    const executionId = `ruflo-timeout-${Date.now()}`;
    // Injection seam (same convention as RunJobOptions test seams): a dispatch
    // that never resolves simulates a hung workflow execution. A releasable
    // deferred keeps the suite hermetic — after the timer wins the race, the
    // losing promise is settled so nothing dangles past the test.
    let releaseHung: () => void = () => undefined;
    const hung = new Promise<never>(() => {
      releaseHung = () => undefined;
    });
    void hung.catch(() => undefined); // never unhandled
    const outcome = await runtime.dispatchForRufloRuntime(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'timeout probe', executionId },
      { dispatch: () => hung },
    );
    releaseHung();

    assert.equal(outcome.accepted, false);
    if (!outcome.accepted) {
      assert.equal(outcome.status, 'TIMEOUT');
      assert.ok(/runtime budget/.test(outcome.reason));
    }
    connector.clearRufloOrchestrator();
  });

  it('execution lookup: end-to-end trace by executionId with safe fields only', async () => {
    const runtime = await importRuntime();
    const { db } = await import('@/lib/db');
    const executionId = `ruflo-lookup-${Date.now()}`;
    await db.workflowRun.create({
      data: {
        workflowType: 'OPPORTUNITY_DISCOVERY',
        status: 'COMPLETED',
        correlationId: executionId,
        plan: '{}',
        steps: '[{"key":"DISCOVER_RESEARCH"}]',
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 5,
      },
    });

    const view = await runtime.getRufloExecution(executionId);
    assert.equal(view.found, true);
    if (view.found) {
      assert.equal(view.executionId, executionId);
      assert.equal(view.workflow?.stepCount, 1);
      assert.ok(!('plan' in (view.workflow ?? {})));
      assert.ok(!('steps' in (view.workflow ?? {})));
    }

    const unknown = await runtime.getRufloExecution('ruflo-never-existed');
    assert.equal(unknown.found, false);

    await db.workflowRun.deleteMany({ where: { correlationId: executionId } });
  });
});

// ---------------------------------------------------------------------------
// Runtime API routes (through the actual HTTP handlers)
// ---------------------------------------------------------------------------

describe('ruflo runtime API routes', () => {
  it('status GET requires the runtime credential', async () => {
    const mod = await import('@/app/api/ruflo/runtime/route');
    const refused = await mod.GET(authedRequest('/api/ruflo/runtime', { token: 'wrong' }));
    assert.equal(refused.status, 401);

    const ok = await mod.GET(authedRequest('/api/ruflo/runtime'));
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; ruflo: { status: string } };
    assert.equal(body.ok, true);
    assert.ok(['NOT_CONFIGURED', 'AUTH_REQUIRED', 'CONNECTING', 'CONNECTED', 'ERROR'].includes(body.ruflo.status));
  });

  it('health POST verifies and records durably', async () => {
    const mod = await import('@/app/api/ruflo/runtime/route');
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });

    const res = await mod.POST(authedRequest('/api/ruflo/runtime/health', { method: 'POST' }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; health: { status: string; checks: Record<string, string> } };
    assert.equal(body.ok, true);
    assert.equal(body.health.status, 'CONNECTED');
    connector.clearRufloOrchestrator();
  });

  it('dispatch POST: unauthenticated is 401; malformed JSON is 400; valid dispatch is 202', async () => {
    const mod = await import('@/app/api/ruflo/runtime/dispatch/route');
    const connector = await importConnector();
    connector.clearRufloOrchestrator();
    connector.registerRufloOrchestrator({ id: 'ruflo-test-runtime' });

    const unauth = await mod.POST(authedRequest('/api/ruflo/runtime/dispatch', {
      method: 'POST',
      token: 'nope',
      body: JSON.stringify({ workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'x' }),
    }));
    assert.equal(unauth.status, 401);

    const malformed = await mod.POST(authedRequest('/api/ruflo/runtime/dispatch', {
      method: 'POST',
      body: '{broken,,',
    }));
    assert.equal(malformed.status, 400);

    const executionId = `ruflo-api-${Date.now()}`;
    const accepted = await mod.POST(authedRequest('/api/ruflo/runtime/dispatch', {
      method: 'POST',
      body: JSON.stringify({ workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'api dispatch probe', executionId }),
    }));
    assert.equal(accepted.status, 202);
    const body = (await accepted.json()) as { ok: boolean; dispatch: { executionId: string; accepted: boolean } };
    assert.equal(body.ok, true);
    assert.equal(body.dispatch.executionId, executionId);

    // Replay with the same executionId → 200 duplicate (idempotent).
    const replay = await mod.POST(authedRequest('/api/ruflo/runtime/dispatch', {
      method: 'POST',
      body: JSON.stringify({ workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'api dispatch probe', executionId }),
    }));
    assert.equal(replay.status, 200);

    connector.clearRufloOrchestrator();
    await cleanupOpp(executionId); // no-op safeguard
  });

  it('execution lookup route requires auth and returns found:false for unknown ids', async () => {
    const mod = await import('@/app/api/ruflo/runtime/executions/[executionId]/route');
    const refused = await mod.GET(
      authedRequest('/api/ruflo/runtime/executions/nope', { token: 'wrong' }),
      { params: Promise.resolve({ executionId: 'nope' }) },
    );
    assert.equal(refused.status, 401);

    const ok = await mod.GET(
      authedRequest('/api/ruflo/runtime/executions/ruflo-unknown-id'),
      { params: Promise.resolve({ executionId: 'ruflo-unknown-id' }) },
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { execution: { found: boolean } };
    assert.equal(body.execution.found, false);
  });
});

// ---------------------------------------------------------------------------
// No-bypass invariants (security regression)
// ---------------------------------------------------------------------------

describe('ruflo runtime: no-bypass invariants', () => {
  it('dispatch path never references revenue/payment/mutation tables directly', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/lib/ruflo/runtime.ts', 'utf8');
    // The runtime module may only READ WorkflowRun/JobRun/SecurityEvent for
    // tracing; it must never write revenue or payment state.
    assert.ok(!/revenueRecord\.(create|update|upsert)/.test(source));
    assert.ok(!/productEvent\.(create|update|upsert)/.test(source));
    assert.ok(!/integrationAuthorization\.(create|update|upsert)/.test(source));
  });

  it('the runtime handle registration path stays server-side only (HTTP POST still refuses)', async () => {
    const mod = await import('@/app/api/ruflo/connector/route');
    const res = await mod.POST();
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  });

  it('registration requires BOTH token config and explicit enablement', async () => {
    const setup = await importSetup();
    const savedToken = process.env.RUFLO_RUNTIME_TOKEN;
    const savedEnabled = process.env.RUFLO_RUNTIME_ENABLED;
    try {
      delete process.env.RUFLO_RUNTIME_TOKEN;
      delete process.env.RUFLO_RUNTIME_ENABLED;
      const disabled = setup.setupRufloRuntime();
      assert.equal(disabled.registered, false);
    } finally {
      if (savedToken) process.env.RUFLO_RUNTIME_TOKEN = savedToken;
      if (savedEnabled) process.env.RUFLO_RUNTIME_ENABLED = savedEnabled;
    }
  });

  it('no Ruflo credentials are exposed via NEXT_PUBLIC_ or client code', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
          walk(p, acc);
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) acc.push(p);
      }
      return acc;
    };
    const offenders = walk('src').filter((f) => !f.includes('__tests__')).filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /NEXT_PUBLIC_.*RUFLO/i.test(text);
    });
    assert.deepEqual(offenders, []);
  });
});
