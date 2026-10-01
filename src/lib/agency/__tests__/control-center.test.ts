// ============================================================================
// PHASE 10A — AGENT CONTROL CENTER: focused tests
// ============================================================================
// Covers the 25 spec cases: authorization (unauthenticated 401 / admin OK),
// pause/resume/stop/restart, invalid + escalation configs, budget caps,
// immutable versioning + rollback-creates-new-version, save & restart,
// truthful restart failure, stop-all/resume-all, governance-blocked resumes,
// human-review non-bypass, safety/halal non-disablement, idempotent replays,
// audit rows, secret-free responses, no fabricated Freebuff/Ruflo connection,
// and Observatory control reflection. Exercises the REAL lib and REAL route
// handlers against a temporary SQLite database (hermetic, like the other
// agency suites). No mocking of the control path.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-control-center-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

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

const importDb = () => import('@/lib/db');
type TestDb = Awaited<ReturnType<typeof importDb>>['db'];
let db: TestDb;
let cc: typeof import('@/lib/agency/control-center');
let controlRoute: typeof import('@/app/api/agents/control/route');
let actionRoute: typeof import('@/app/api/agents/control/action/route');
let configRoute: typeof import('@/app/api/agents/[agentId]/configuration/route');
let rollbackRoute: typeof import('@/app/api/agents/[agentId]/configuration/rollback/route');
let saveRestartRoute: typeof import('@/app/api/agents/[agentId]/configuration/save-restart/route');
let obs: typeof import('@/lib/observatory');

before(async () => {
  const mod = await importDb();
  db = (mod as unknown as { db: TestDb }).db;
  cc = await import('@/lib/agency/control-center');
  controlRoute = await import('@/app/api/agents/control/route');
  actionRoute = await import('@/app/api/agents/control/action/route');
  configRoute = await import('@/app/api/agents/[agentId]/configuration/route');
  rollbackRoute = await import('@/app/api/agents/[agentId]/configuration/rollback/route');
  saveRestartRoute = await import('@/app/api/agents/[agentId]/configuration/save-restart/route');
  obs = await import('@/lib/observatory');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = 'admin@aiincome.lab';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const SAVED: Record<string, string | undefined> = {};

function setAdminEnv() {
  SAVED.ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  SAVED.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  SAVED.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD_HASH;
}

function restoreAdminEnv() {
  for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH']) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
}

async function loginAndGetCookie(): Promise<string> {
  const sessionRoute = await import('@/app/api/admin/session/route');
  const res = await sessionRoute.POST(new Request('http://localhost/api/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }));
  assert.equal(res.status, 200, 'admin login must succeed for control tests');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/aill_admin_session=([^;]+)/)?.[1] ?? '';
  assert.ok(cookie.length > 0, 'expected a session cookie');
  return cookie;
}

let adminCookie = '';

function authedRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie: `aill_admin_session=${adminCookie}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Valid runtime config for 'research' derived from its base contract. */
function validResearchConfig(): Record<string, unknown> {
  const base = cc.baseConfigFor('research');
  return { ...base, mission: 'Discovers opportunities and gathers evidence with provenance under a tightened budget.' };
}

/** Valid runtime config for 'growth' that lowers the budget cap (allowed narrowing). */
function narrowedGrowthConfig(budgetUsd: number): Record<string, unknown> {
  const base = cc.baseConfigFor('growth');
  return { ...base, budgetLimitUsd: budgetUsd };
}

// ---------------------------------------------------------------------------
// 1–3. Authorization
// ---------------------------------------------------------------------------

describe('agent control authorization', () => {
  before(async () => {
    setAdminEnv();
    adminCookie = await loginAndGetCookie();
  });
  after(() => restoreAdminEnv());

  it('rejects unauthenticated control requests with 401 and leaks nothing (case 1)', async () => {
    const requests: Promise<Response>[] = [
      controlRoute.GET(new Request('http://localhost/api/agents/control')),
      actionRoute.POST(new Request('http://localhost/api/agents/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'STOP_ALL' }) })),
      configRoute.GET(new Request('http://localhost/api/agents/research/configuration'), { params: Promise.resolve({ agentId: 'research' }) }),
      configRoute.PATCH(new Request('http://localhost/api/agents/research/configuration', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: validResearchConfig() }) }), { params: Promise.resolve({ agentId: 'research' }) }),
      rollbackRoute.POST(new Request('http://localhost/api/agents/research/configuration/rollback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toVersion: 1 }) }), { params: Promise.resolve({ agentId: 'research' }) }),
    ];
    for (const promise of requests) {
      const res = await promise;
      assert.equal(res.status, 401);
      const json = (await res.json()) as { ok: boolean; view?: unknown; versions?: unknown };
      assert.equal(json.ok, false);
      assert.equal(json.view, undefined);
      assert.equal(json.versions, undefined);
    }
  });

  it('accepts a valid admin control request and returns the real view (case 3)', async () => {
    const res = await controlRoute.GET(authedRequest('http://localhost/api/agents/control', 'GET'));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; view: { agents: { agentId: string }[]; externalExecution: { freebuff: { status: string } } } };
    assert.equal(json.ok, true);
    assert.ok(json.view.agents.length >= 13, 'all 13 roster agents are controllable');
    assert.equal(json.view.externalExecution.freebuff.status, 'NOT_CONNECTED');
  });

  it('rejects unknown agents and malformed actions with 400/404', async () => {
    const badAgent = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'PAUSE', agentId: 'not-an-agent' }));
    assert.equal(badAgent.status, 400);
    const badAction = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'NUKE' }));
    assert.equal(badAction.status, 400);
    const badGlobal = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'STOP_ALL', agentId: 'research' }));
    assert.equal(badGlobal.status, 400);
    const unknownConfig = await configRoute.GET(authedRequest('http://localhost/api/agents/nobody/configuration', 'GET'), { params: Promise.resolve({ agentId: 'nobody' }) });
    assert.equal(unknownConfig.status, 404);
  });
});

// ---------------------------------------------------------------------------
// 4–7, 16–18, 19. Control actions + governance blocks
// ---------------------------------------------------------------------------

describe('control actions (pause/resume/stop/restart, stop-all, resume-all)', () => {
  before(() => setAdminEnv());
  after(() => restoreAdminEnv());

  it('pauses an agent: new work held, running semantics untouched (case 4)', async () => {
    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'PAUSE', agentId: 'research', reason: 'test pause' }));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; newState: string; detail: string };
    assert.equal(json.ok, true);
    assert.equal(json.newState, 'PAUSED');
    const gate = await cc.isAgentControlBlocked('research');
    assert.equal(gate.blocked, true);
    // The audit trail recorded the action.
    const action = await db.agentControlAction.findFirst({ where: { agentId: 'research', action: 'PAUSE', result: 'OK' }, orderBy: { createdAt: 'desc' } });
    assert.ok(action, 'PAUSE must be audited in AgentControlAction');
  });

  it('resumes the paused agent through the governed path (case 5)', async () => {
    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'RESUME', agentId: 'research' }));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; newState: string };
    assert.equal(json.ok, true);
    assert.equal(json.newState, 'RUNNING');
    const gate = await cc.isAgentControlBlocked('research');
    assert.equal(gate.blocked, false);
  });

  it('stops an agent and preserves run records (case 6)', async () => {
    // Seed a real AgentRun so we can prove STOP never touches records.
    await db.agentRun.create({
      data: { agentId: 'validation', jobType: 'VALIDATION', stage: 'VALIDATE', status: 'SUCCEEDED', correlationId: 'cc-stop-corr' },
    });
    const before = await db.agentRun.findMany({ where: { agentId: 'validation' } });
    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'STOP', agentId: 'validation' }));
    assert.equal(res.status, 200);
    const gate = await cc.isAgentControlBlocked('validation');
    assert.equal(gate.blocked, true);
    assert.match(gate.reason ?? '', /STOPPED/);
    const after = await db.agentRun.findMany({ where: { agentId: 'validation' } });
    assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort());
    assert.equal(after.length, before.length);
  });

  it('restarts an agent and reloads validated configuration (case 7)', async () => {
    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'RESTART', agentId: 'product' }));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; newState: string; configVersion: number | null };
    assert.equal(json.ok, true);
    assert.equal(json.newState, 'RUNNING');
    assert.ok(json.configVersion, 'restart bootstraps a configuration version');
    const gate = await cc.isAgentControlBlocked('product');
    assert.equal(gate.blocked, false);
  });

  it('stop-all uses the global pause and pauses every eligible agent (case 16)', async () => {
    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'STOP_ALL', reason: 'emergency drill' }));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; globalPaused: boolean; changedAgents: string[] };
    assert.equal(json.ok, true);
    assert.equal(json.globalPaused, true);
    const control = await db.agencyControl.findUnique({ where: { key: 'autonomy' } });
    assert.equal(control?.paused, true, 'global AgencyControl pause must be applied');
    const researchState = await db.agentControlState.findUnique({ where: { agentId: 'research' } });
    assert.equal(researchState?.desiredState, 'PAUSED');
    // Global pause is authoritative for supervised dispatch.
    const { getAgencyControl } = await import('@/lib/agency/runtime');
    const global = await getAgencyControl();
    assert.equal(global.paused, true);
  });

  it('resume-all skips blocked/failed/human-review/safety agents (cases 17, 18, 19)', async () => {
    // Reset the global pause, then make several agents ineligible.
    await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'STOP_ALL' }));
    await db.humanReview.create({
      data: { category: 'PUBLICATION', title: 'pending review blocks resume-all', requestedBy: 'publishing', status: 'PENDING' },
    });
    await db.agentHealth.upsert({
      where: { agentId: 'analytics' },
      create: { agentId: 'analytics', state: 'BLOCKED', reasons: JSON.stringify(['test governance block']) },
      update: { state: 'BLOCKED', reasons: JSON.stringify(['test governance block']) },
    });
    await db.agentRun.create({
      data: { agentId: 'memory', jobType: 'MEMORY', stage: 'LEARN', status: 'FAILED', correlationId: 'cc-resume-all-safety', safetyVerdict: 'NOT_ALLOWED' },
    });
    // growth stays explicitly STOPPED: resume-all must never auto-resume it.
    await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'STOP', agentId: 'growth' }));

    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'RESUME_ALL' }));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; resumedAgents: string[]; skippedAgents: { agentId: string; reason: string }[] };
    assert.equal(json.ok, true);

    const skipped = new Map(json.skippedAgents.map((s) => [s.agentId, s.reason]));
    assert.ok(skipped.has('publishing'), 'agent awaiting HumanReview must be skipped');
    assert.match(skipped.get('publishing') ?? '', /HumanReview/i);
    assert.ok(skipped.has('analytics'), 'BLOCKED agent must be skipped');
    assert.ok(skipped.has('memory'), 'safety-blocked agent must be skipped');
    assert.match(skipped.get('memory') ?? '', /safety/i);
    assert.ok(skipped.has('growth'), 'explicitly STOPPED agent must be skipped');
    // research was merely PAUSED and has no governance block → resumed.
    assert.ok(json.resumedAgents.includes('research'));
    const control = await db.agencyControl.findUnique({ where: { key: 'autonomy' } });
    assert.equal(control?.paused, false, 'global pause cleared');
  });

  it('a human-review state cannot be bypassed by a direct RESUME (case 19)', async () => {
    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'RESUME', agentId: 'publishing' }));
    assert.equal(res.status, 409);
    const json = (await res.json()) as { ok: boolean; code: string; error: string };
    assert.equal(json.ok, false);
    assert.equal(json.code, 'REFUSED');
    assert.match(json.error, /HumanReview/i);
    const state = await db.agentControlState.findUnique({ where: { agentId: 'publishing' } });
    assert.notEqual(state?.desiredState, 'RUNNING');
  });
});

// ---------------------------------------------------------------------------
// 8–15. Configuration validation, versioning, rollback, save & restart
// ---------------------------------------------------------------------------

describe('runtime configuration (validation, versioning, rollback)', () => {
  before(() => setAdminEnv());
  after(() => restoreAdminEnv());

  it('rejects an invalid configuration (schema/bounds) with 400 (case 8)', async () => {
    const res = await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/research/configuration', 'PATCH', { config: { mission: 'x' } }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    assert.equal(res.status, 400);
    const json = (await res.json()) as { ok: boolean; errors: string[] };
    assert.equal(json.ok, false);
    assert.ok(json.errors.length > 0);
    const versions = await db.agentConfigVersion.count({ where: { agentId: 'research' } });
    assert.equal(versions, 0, 'invalid config must not create a version');
  });

  it('rejects forbidden capability escalation (tools/stages outside the base contract) (case 9)', async () => {
    const escalation = { ...validResearchConfig(), allowedTools: ['shell.exec', 'db.raw-sql'] };
    const res = await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/research/configuration', 'PATCH', { config: escalation }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    assert.equal(res.status, 400);
    const json = (await res.json()) as { ok: boolean; errors: string[] };
    assert.match(json.errors.join(' '), /outside the base contract/);
    // A tool forbidden everywhere can never be granted, even if listed in a contract.
    const forbiddingTool = { ...cc.baseConfigFor('business-manager'), allowedTools: ['jobs.dispatch', 'shell.exec'] };
    const pure = await cc.validateConfigAgainstContract(forbiddingTool, 'business-manager');
    assert.equal(pure.valid, false);
  });

  it('enforces budget limits: cannot exceed the base contract cap (case 10)', async () => {
    const overBudget = { ...narrowedGrowthConfig(500) };
    const res = await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/growth/configuration', 'PATCH', { config: overBudget }),
      { params: Promise.resolve({ agentId: 'growth' }) },
    );
    assert.equal(res.status, 400);
    const json = (await res.json()) as { ok: boolean; errors: string[] };
    assert.match(json.errors.join(' '), /budget/);
    // Narrowing below the cap is allowed.
    const narrowed = await cc.validateConfigAgainstContract(narrowedGrowthConfig(5), 'growth');
    assert.equal(narrowed.valid, true);
  });

  it('creates a configuration version on save with provenance (case 11)', async () => {
    const res = await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/research/configuration', 'PATCH', { config: validResearchConfig(), reason: 'tighten research budget' }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; version: number; changedFields: string[] };
    assert.equal(json.ok, true);
    assert.equal(json.version, 1);
    const row = await db.agentConfigVersion.findUnique({ where: { agentId_version: { agentId: 'research', version: 1 } } });
    assert.ok(row);
    assert.equal(row.changedBy, ADMIN_EMAIL);
    assert.equal(row.action, 'SAVE');
    assert.ok(row.configJson.includes('budgetLimitUsd'));
    // The audit trail recorded the save.
    const action = await db.agentControlAction.findFirst({ where: { agentId: 'research', action: 'SAVE_CONFIG', result: 'OK' } });
    assert.ok(action, 'SAVE must be audited');
  });

  it('historical configuration versions are immutable (case 12)', async () => {
    // Save v2 with a different budget.
    const second = { ...validResearchConfig(), budgetLimitUsd: 0.5 };
    const saveRes = await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/research/configuration', 'PATCH', { config: second }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    assert.equal(saveRes.status, 200);
    const saveJson = (await saveRes.json()) as { ok: boolean; version: number };
    assert.equal(saveJson.version, 2);

    const v1Before = await db.agentConfigVersion.findUnique({ where: { agentId_version: { agentId: 'research', version: 1 } } });
    assert.ok(v1Before);
    // Perform further mutations (another save + restarts) then re-read v1.
    await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/research/configuration', 'PATCH', { config: { ...validResearchConfig(), budgetLimitUsd: 0.25 } }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    const v1After = await db.agentConfigVersion.findUnique({ where: { agentId_version: { agentId: 'research', version: 1 } } });
    assert.equal(v1After?.configJson, v1Before.configJson, 'v1 configJson must never change');
    assert.equal(v1After?.createdAt.getTime(), v1Before.createdAt.getTime());
    // There is no update/delete path at all: the lib exposes only create + read.
    assert.equal(typeof (cc as unknown as Record<string, unknown>).updateAgentConfig, 'undefined');
    assert.equal(typeof (cc as unknown as Record<string, unknown>).deleteAgentConfig, 'undefined');
  });

  it('rollback creates a NEW version equal to the target, never mutates history (case 13)', async () => {
    // Current active version is v3. Roll back to v1.
    const res = await rollbackRoute.POST(
      authedRequest('http://localhost/api/agents/research/configuration/rollback', 'POST', { toVersion: 1 }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; restoredFromVersion: number; newVersion: number };
    assert.equal(json.ok, true);
    assert.equal(json.restoredFromVersion, 1);
    assert.equal(json.newVersion, 4, 'v4 = restored copy of v1');

    const v1 = await db.agentConfigVersion.findUnique({ where: { agentId_version: { agentId: 'research', version: 1 } } });
    const v4 = await db.agentConfigVersion.findUnique({ where: { agentId_version: { agentId: 'research', version: 4 } } });
    assert.ok(v1 && v4);
    assert.equal(v4.configJson, v1.configJson, 'rollback copies the target configuration');
    assert.equal(v4.action, 'ROLLBACK');
    // v2 and v3 still exist untouched.
    const v2 = await db.agentConfigVersion.findUnique({ where: { agentId_version: { agentId: 'research', version: 2 } } });
    const v3 = await db.agentConfigVersion.findUnique({ where: { agentId_version: { agentId: 'research', version: 3 } } });
    assert.ok(v2 && v3);
    // Rollback to a nonexistent version is an honest 404.
    const missing = await rollbackRoute.POST(
      authedRequest('http://localhost/api/agents/research/configuration/rollback', 'POST', { toVersion: 99 }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    assert.equal(missing.status, 404);
  });

  it('save & restart persists a version and restarts through the governed path (case 14)', async () => {
    const res = await saveRestartRoute.POST(
      authedRequest('http://localhost/api/agents/analytics/configuration/save-restart', 'POST', { config: { ...cc.baseConfigFor('analytics'), mission: 'Analyzes traffic, conversion and revenue; generates findings for the Business Manager layer.' } }),
      { params: Promise.resolve({ agentId: 'analytics' }) },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; version: number; restart: { newState: string } };
    assert.equal(json.ok, true);
    assert.ok(json.version >= 1);
    assert.equal(json.restart.newState, 'RUNNING');
    const action = await db.agentControlAction.findFirst({ where: { agentId: 'analytics', action: 'RESTART', result: 'OK' }, orderBy: { createdAt: 'desc' } });
    assert.ok(action, 'restart lifecycle audited');
  });

  it('restart failure produces a truthful ERROR state, never fake RUNNING (case 15)', async () => {
    // Simulate persistence failure mid-restart: drop the control tables' data
    // access by corrupting the stored config version so re-validation fails
    // (this is the realistic drift path — a deploy tightened the contract).
    const base = cc.baseConfigFor('memory');
    const driftConfig = { ...base, allowedStages: ['NONEXISTENT_STAGE_X'] }; // invalid vs current contract
    await db.agentConfigVersion.create({
      data: {
        agentId: 'memory',
        version: 99,
        configJson: JSON.stringify(driftConfig),
        changedFields: '[]',
        changedBy: ADMIN_EMAIL,
        action: 'SAVE',
      },
    });
    // make v99 the "latest" so the restart re-reads it
    const latest = await db.agentConfigVersion.findFirst({ where: { agentId: 'memory' }, orderBy: { version: 'desc' } });
    assert.equal(latest?.version, 99);

    const res = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'RESTART', agentId: 'memory' }));
    assert.equal(res.status, 503);
    const json = (await res.json()) as { ok: boolean; code: string; error: string };
    assert.equal(json.ok, false);
    assert.match(json.error, /Restart failed/);
    const state = await db.agentControlState.findUnique({ where: { agentId: 'memory' } });
    assert.equal(state?.derivedState, 'ERROR');
    assert.equal(state?.desiredState, 'PAUSED');
    assert.match(state?.stopReason ?? '', /restart failed/);
    const failedAction = await db.agentControlAction.findFirst({ where: { agentId: 'memory', action: 'RESTART', result: 'FAILED' }, orderBy: { createdAt: 'desc' } });
    assert.ok(failedAction, 'failed restart audited');
  });
});

// ---------------------------------------------------------------------------
// 20–25. Safety, idempotency, audit, secrets, seams, observatory
// ---------------------------------------------------------------------------

describe('safety, idempotency, audit, secrets and seams', () => {
  before(() => setAdminEnv());
  after(() => restoreAdminEnv());

  it('safety/halal controls cannot be disabled via configuration (case 20)', async () => {
    // requiresApproval=false for the halal screener → refused.
    const noApproval = { ...cc.baseConfigFor('safety-halal'), requiresApproval: false };
    const r1 = await cc.validateConfigAgainstContract(noApproval, 'safety-halal');
    assert.equal(r1.valid, false);
    assert.match(r1.valid ? '' : r1.errors.join(' '), /requiresApproval/);
    // Non-zero budget or retries for the screener → refused.
    const spendy = await cc.validateConfigAgainstContract({ ...cc.baseConfigFor('safety-halal'), budgetLimitUsd: 5 }, 'safety-halal');
    assert.equal(spendy.valid, false);
    // Evidence requirement is immovable for every agent.
    const tampered = await cc.validateConfigAgainstContract({ ...cc.baseConfigFor('research'), evidenceRequirement: 'AI_INFERENCE' }, 'research');
    void tampered; // research's base IS AI_INFERENCE; use a different agent
    const tampered2 = await cc.validateConfigAgainstContract({ ...cc.baseConfigFor('growth'), evidenceRequirement: 'AI_INFERENCE' }, 'growth');
    assert.equal(tampered2.valid, false);
    assert.match(tampered2.valid ? '' : tampered2.errors.join(' '), /evidenceRequirement/);
    // The screener's halal mission cannot be stripped.
    const stripped = await cc.validateConfigAgainstContract({ ...cc.baseConfigFor('safety-halal'), mission: 'General purpose agent for any task whatsoever.' }, 'safety-halal');
    assert.equal(stripped.valid, false);
    // Route-level: the same invalid config is refused with 400.
    const res = await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/safety-halal/configuration', 'PATCH', { config: noApproval }),
      { params: Promise.resolve({ agentId: 'safety-halal' }) },
    );
    assert.equal(res.status, 400);
  });

  it('a duplicate control request (same correlationId) is idempotent (case 21)', async () => {
    const correlationId = 'control:PAUSE:product:dup-test-1';
    const first = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'PAUSE', agentId: 'product', correlationId }));
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as { ok: boolean; detail: string; newState: string };
    assert.equal(firstJson.ok, true);
    const second = await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'PAUSE', agentId: 'product', correlationId }));
    assert.equal(second.status, 200);
    const secondJson = (await second.json()) as { ok: boolean; detail: string };
    assert.equal(secondJson.ok, true);
    assert.match(secondJson.detail, /idempotent replay/);
    // Only ONE audited OK PAUSE row exists for that correlation.
    const rows = await db.agentControlAction.findMany({ where: { correlationId, action: 'PAUSE', result: 'OK' } });
    assert.equal(rows.length, 1);
    // Concurrent double-RESTART with the same correlation must also collapse.
    const restartCorr = 'control:RESTART:product:dup-restart-1';
    const [r1, r2] = await Promise.all([
      actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'RESTART', agentId: 'product', correlationId: restartCorr })),
      actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'RESTART', agentId: 'product', correlationId: restartCorr })),
    ]);
    const r1Json = (await r1.json()) as { ok: boolean };
    const r2Json = (await r2.json()) as { ok: boolean };
    assert.equal(r1Json.ok, true);
    assert.equal(r2Json.ok, true);
    const restartRows = await db.agentControlAction.findMany({ where: { correlationId: restartCorr, action: 'RESTART', result: 'OK' } });
    assert.equal(restartRows.length, 1, 'two simultaneous RESTARTs must not create two independent executions');
  });

  it('every control action is audited with full context (case 22)', async () => {
    await actionRoute.POST(authedRequest('http://localhost/api/agents/control', 'POST', { action: 'PAUSE', agentId: 'revenue', reason: 'audit probe' }));
    const row = await db.agentControlAction.findFirst({ where: { agentId: 'revenue', action: 'PAUSE' }, orderBy: { createdAt: 'desc' } });
    assert.ok(row);
    assert.equal(row.changedBy, ADMIN_EMAIL);
    assert.equal(row.result, 'OK');
    assert.ok(row.correlationId.startsWith('control:PAUSE:revenue:'));
    assert.equal(row.previousState !== null, true);
    assert.equal(row.newState, 'PAUSED');
    // SecurityEvent also captured the control surface.
    const securityEvents = await db.securityEvent.findMany({ where: { surface: 'agency:control-center' }, orderBy: { createdAt: 'desc' }, take: 10 });
    assert.ok(securityEvents.length >= 1, 'SecurityEvent rows recorded for control surface');
  });

  it('secrets are never stored or returned by control APIs (case 23)', async () => {
    const sneaky = { ...validResearchConfig(), apiKey: 'sk-super-secret', webhookSecret: 'whsec_abc', password: 'hunter2' };
    const res = await configRoute.PATCH(
      authedRequest('http://localhost/api/agents/research/configuration', 'PATCH', { config: sneaky }),
      { params: Promise.resolve({ agentId: 'research' }) },
    );
    assert.equal(res.status, 400, 'unknown fields must be rejected by the strict schema');
    // Even if a secret-looking value slips into a bounded string field, the
    // view endpoints return only the safe config fields.
    const viewRes = await controlRoute.GET(authedRequest('http://localhost/api/agents/control', 'GET'));
    const raw = JSON.stringify(await viewRes.json());
    assert.equal(raw.includes('sk-super-secret'), false);
    assert.equal(raw.includes('aill_admin_session'), false);
    assert.equal(raw.toLowerCase().includes('password'), false);
    const historyRes = await configRoute.GET(authedRequest('http://localhost/api/agents/research/configuration', 'GET'), { params: Promise.resolve({ agentId: 'research' }) });
    const historyRaw = JSON.stringify(await historyRes.json());
    assert.equal(historyRaw.toLowerCase().includes('secret'), false);
  });

  it('no fabricated Freebuff/Ruflo connection is ever claimed (case 24)', async () => {
    const res = await controlRoute.GET(authedRequest('http://localhost/api/agents/control', 'GET'));
    const json = (await res.json()) as { ok: boolean; view: { externalExecution: { freebuff: { status: string; detail: string }; ruflo: { status: string } } } };
    assert.equal(json.view.externalExecution.freebuff.status, 'NOT_CONNECTED');
    assert.match(json.view.externalExecution.freebuff.detail, /No Freebuff adapter exists/);
    assert.ok(['RUFLO_READY', 'NOT_CONNECTED'].includes(json.view.externalExecution.ruflo.status), 'ruflo stays honest');
    // The view must never contain a CONNECTED claim for Freebuff.
    const raw = JSON.stringify(json);
    assert.equal(raw.includes('FREEBUFF_CONNECTED'), false);
  });

  it('Observatory control reflection matches the control state without becoming a controller (case 25)', async () => {
    // research is ACTIVE (v4 rollback) and RUNNING; growth is STOPPED; memory ERROR from earlier.
    const reflection = await obs.getControlReflection();
    assert.equal(reflection.globalPaused, false);
    const research = reflection.agents.find((a) => a.agentId === 'research');
    assert.ok(research);
    assert.equal(research.configuration.quality, 'VERSIONED');
    assert.ok(research.configuration.activeVersion, 'research has versioned config');
    assert.equal(research.desiredState, 'RUNNING');
    const growth = reflection.agents.find((a) => a.agentId === 'growth');
    assert.ok(growth);
    assert.equal(growth.stopped, true);
    assert.equal(growth.derivedState, 'STOPPED');
    const memory = reflection.agents.find((a) => a.agentId === 'memory');
    assert.ok(memory);
    assert.equal(memory.derivedState, 'ERROR', 'truthful ERROR reflected');
    // Summary math is consistent.
    assert.equal(reflection.summary.totalAgents, 13);
    assert.equal(reflection.summary.stoppedAgents, reflection.agents.filter((a) => a.stopped).length);
    // The full observatory view composes the reflection (read-only).
    const view = await obs.getObservatoryView();
    assert.equal(view.control.globalPaused, false);
    assert.equal(view.control.agents.length, 13);
    // Read-only: the reflection wrote no rows.
    const before = await db.agentControlAction.count();
    await obs.getControlReflection();
    const after = await db.agentControlAction.count();
    assert.equal(after, before, 'observatory reflection must never write');
  });

  it('the dispatch gate refuses blocked agents and passes eligible ones', async () => {
    // Lib-level (route-level refusals are covered in the governance describe;
    // this avoids tripping the route's 20/60s rate limit inside the suite).
    // 'memory' has a NOT_ALLOWED run from the resume-all test; 'revenue' is clean.
    const paused = await cc.applyControlAction({ agentId: 'revenue', action: 'PAUSE', changedBy: ADMIN_EMAIL, reason: 'gate probe' });
    assert.equal(paused.ok, true);
    const blocked = await cc.isAgentControlBlocked('revenue');
    assert.equal(blocked.blocked, true);
    const refusedResume = await cc.applyControlAction({ agentId: 'memory', action: 'RESUME', changedBy: ADMIN_EMAIL });
    assert.equal(refusedResume.ok, false, 'safety-blocked agents cannot be resumed, only RESTARTed');
    assert.equal(refusedResume.ok ? '' : refusedResume.code, 'REFUSED');
    const resumed = await cc.applyControlAction({ agentId: 'revenue', action: 'RESUME', changedBy: ADMIN_EMAIL });
    assert.equal(resumed.ok, true);
    const eligible = await cc.isAgentControlBlocked('revenue');
    assert.equal(eligible.blocked, false);
    const stillBlocked = await cc.isAgentControlBlocked('memory');
    assert.equal(stillBlocked.blocked, true, 'memory stays paused after the refused resume');
  });
});
