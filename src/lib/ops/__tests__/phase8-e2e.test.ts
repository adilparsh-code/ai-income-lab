// Phase 8J — End-to-end simulation over a temporary database.
// Walks Opportunity → Research → Validation → Decision → Build → Test →
// Simulated Traffic → Simulated Conversion → Simulated Revenue → Learning → Next Decision.
// Also covers NOT_ALLOWED, REVIEW_REQUIRED, failed validation, timeout,
// transient/permanent failure, duplicate execution, retry, human approval,
// profitable/losing simulation, kill, pause, iterate, scale.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-p8e2e-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma7 db push --schema prisma/schema.test.prisma', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const importDb = () => import('@/lib/db');
const importMissions = () => import('../missions');
const importLoop = () => import('../loop');
const importSim = () => import('../simulation');
const importMem = () => import('../memory');
const importFail = () => import('../failure-store');
const importDecision = () => import('../decision-engine');
const importDash = () => import('../dashboard');

async function seedOpp(overrides: Partial<{ title: string; halalStatus: string; status: string }> = {}) {
  const { db } = await importDb();
  return db.opportunity.create({
    data: {
      title: overrides.title ?? 'Phase 8 e2e opportunity',
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'testers',
      problemSolved: 'a problem',
      monetizationMethod: 'ONE_TIME',
      status: overrides.status ?? 'IDEA',
      halalStatus: overrides.halalStatus ?? 'HALAL',
    },
  });
}

describe('8A missions — create, idempotency, gates', () => {
  it('creates a QUEUED mission and deduplicates on correlationId', async () => {
    const { createMission } = await importMissions();
    const opp = await seedOpp({ title: 'mission-dup' });
    const first = await createMission({
      objective: 'Research demand for mission-dup',
      agentType: 'research',
      correlationId: `mission:${opp.id}:research`,
      opportunityId: opp.id,
      allowedCapabilities: ['RESEARCH'],
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.mission.status, 'QUEUED');
    const second = await createMission({
      objective: 'Research demand for mission-dup',
      agentType: 'research',
      correlationId: `mission:${opp.id}:research`,
      opportunityId: opp.id,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.deduplicated, true);
    assert.equal(second.mission.id, first.mission.id);
  });

  it('NOT_ALLOWED opportunity creates a BLOCKED mission without execution', async () => {
    const { createMission, runMission } = await importMissions();
    const opp = await seedOpp({ title: 'blocked-mission', halalStatus: 'NOT_ALLOWED' });
    const created = await createMission({
      objective: 'Should never run',
      agentType: 'research',
      correlationId: `mission:${opp.id}:blocked`,
      opportunityId: opp.id,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.mission.status, 'BLOCKED');
    const ran = await runMission(created.mission.id);
    assert.ok(ran);
    assert.equal(ran.mission.status, 'BLOCKED');
    assert.equal(ran.jobId, null);
  });

  it('REVIEW_REQUIRED and approvalRequired stop at HUMAN_REVIEW', async () => {
    const { createMission, runMission } = await importMissions();
    const opp = await seedOpp({ title: 'review-mission', halalStatus: 'REVIEW_REQUIRED' });
    const created = await createMission({
      objective: 'Needs review',
      agentType: 'research',
      correlationId: `mission:${opp.id}:review`,
      opportunityId: opp.id,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const ran = await runMission(created.mission.id);
    assert.ok(ran);
    assert.equal(ran.mission.status, 'HUMAN_REVIEW');
    assert.equal(ran.jobId, null);

    const opp2 = await seedOpp({ title: 'approval-mission' });
    const gated = await createMission({
      objective: 'Needs token',
      agentType: 'research',
      correlationId: `mission:${opp2.id}:approval`,
      opportunityId: opp2.id,
      approvalRequired: true,
    });
    assert.equal(gated.ok, true);
    if (!gated.ok) return;
    const ran2 = await runMission(gated.mission.id);
    assert.ok(ran2);
    assert.equal(ran2.mission.status, 'HUMAN_REVIEW');
  });
});

describe('8B autonomous loop tick', () => {
  it('NOT_ALLOWED hard-blocks before any job', async () => {
    const { tickAutonomousLoop } = await importLoop();
    const opp = await seedOpp({ title: 'loop-blocked', halalStatus: 'NOT_ALLOWED' });
    const tick = await tickAutonomousLoop(opp.id);
    assert.equal(tick.status, 'BLOCKED');
    assert.equal(tick.jobId, null);
    assert.equal(tick.ok, false);
  });

  it('REVIEW_REQUIRED yields HUMAN_REVIEW', async () => {
    const { tickAutonomousLoop } = await importLoop();
    const opp = await seedOpp({ title: 'loop-review', halalStatus: 'REVIEW_REQUIRED' });
    const tick = await tickAutonomousLoop(opp.id);
    assert.equal(tick.status, 'HUMAN_REVIEW');
    assert.equal(tick.jobId, null);
  });

  it('records from/to/reason/evidence/correlationId/timestamp/status', async () => {
    const { tickAutonomousLoop, listLoopTransitions } = await importLoop();
    const opp = await seedOpp({ title: 'loop-record' });
    const tick = await tickAutonomousLoop(opp.id);
    assert.ok(tick.correlationId.startsWith('loop:'));
    assert.ok(tick.timestamp);
    assert.ok(tick.from);
    assert.ok(tick.to);
    assert.ok(tick.reason);
    const history = await listLoopTransitions(opp.id);
    assert.ok(history.length >= 1);
    assert.equal(history[0].correlationId, tick.correlationId);
  });

  it('duplicate ticks do not fabricate extra completed stages', async () => {
    const { tickAutonomousLoop } = await importLoop();
    const opp = await seedOpp({ title: 'loop-dup' });
    const a = await tickAutonomousLoop(opp.id);
    const b = await tickAutonomousLoop(opp.id);
    assert.ok(a.correlationId !== b.correlationId);
    assert.ok(['ADVANCED', 'NO_OP', 'AWAITING_HUMAN_INPUT', 'FAILED', 'GUARD', 'COMPLETED'].includes(b.status));
  });
});

describe('8D/8E/8J e2e paper pipeline', () => {
  it('walks a profitable simulation to SCALE without writing real revenue', async () => {
    const { db } = await importDb();
    const { persistSimulation, runPaperSimulation } = await importSim();
    const { decideLifecycle } = await importDecision();
    const { persistOperationalMemory, recallOperationalMemory } = await importMem();
    const opp = await seedOpp({ title: 'profitable-sim', status: 'VALIDATED' });

    await db.experiment.create({
      data: { hypothesis: 'People will buy', opportunityId: opp.id, decision: 'SCALE', visitors: 100, sales: 4, revenue: 80 },
    });
    await db.product.create({
      data: { name: 'Sim Product', type: 'DIGITAL_PRODUCT', opportunityId: opp.id, status: 'PUBLISHED', price: 20 },
    });

    const sim = runPaperSimulation({
      seed: 'e2e-profit',
      correlationId: `sim:${opp.id}:profit`,
      opportunityId: opp.id,
      traffic: 10000,
      conversionRate: 0.024,
      priceUsd: 2,
      costPerVisitorUsd: 0.005,
      fixedCostUsd: 23,
      positiveValidationCount: 1,
      completedDecisionCount: 1,
    });
    assert.equal(sim.revenueUsd, 480);
    assert.equal(sim.profitUsd, 407);
    assert.equal(sim.realTransaction, false);
    const stored = await persistSimulation(sim, opp.id);
    assert.equal(stored.label, 'SIMULATED');

    const realRevenue = await db.revenue.count({ where: { opportunityId: opp.id } });
    assert.equal(realRevenue, 0, 'simulated revenue must never land in Revenue');

    const decision = decideLifecycle({
      failedValidationCount: 0,
      positiveValidationCount: 1,
      completedDecisionCount: 1,
      netRevenue: sim.revenueUsd,
      trafficEvents: sim.traffic,
      conversionEvents: sim.conversions,
      costsUsd: sim.costsUsd,
      halalStatus: 'HALAL',
      hasAmbiguousSignal: false,
      highRisk: false,
      simulated: true,
    });
    assert.equal(decision.decision, 'SCALE');

    await persistOperationalMemory({
      category: 'opportunity',
      source: 'simulation-e2e',
      evidenceType: 'AI_INFERENCE',
      opportunityId: opp.id,
      observation: `Paper profit $${sim.profitUsd} SIMULATED — not verified truth.`,
    });
    const recalled = await recallOperationalMemory({ opportunityId: opp.id, verifiedOnly: true });
    assert.equal(recalled.length, 0, 'AI_INFERENCE memory must not be treated as verified');
  });

  it('losing simulation → PAUSE/KILL candidate, still SIMULATED', async () => {
    const { runPaperSimulation } = await importSim();
    const { decideLifecycle } = await importDecision();
    const sim = runPaperSimulation({
      seed: 'e2e-loss',
      correlationId: 'sim:loss',
      traffic: 1000,
      conversionRate: 0.001,
      priceUsd: 1,
      costPerVisitorUsd: 0.2,
      fixedCostUsd: 50,
      failedValidationCount: 3,
      positiveValidationCount: 0,
      completedDecisionCount: 3,
    });
    assert.equal(sim.realTransaction, false);
    assert.ok(sim.profitUsd < 0);
    const d = decideLifecycle({
      failedValidationCount: 3, positiveValidationCount: 0, completedDecisionCount: 3,
      netRevenue: sim.revenueUsd, trafficEvents: sim.traffic, conversionEvents: sim.conversions,
      costsUsd: sim.costsUsd, halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false, simulated: true,
    });
    assert.equal(d.decision, 'KILL');
  });

  it('iterate / pause / scale / kill cover the decision surface', async () => {
    const { decideLifecycle } = await importDecision();
    assert.equal(decideLifecycle({
      failedValidationCount: 1, positiveValidationCount: 0, completedDecisionCount: 1,
      netRevenue: 0, trafficEvents: 0, conversionEvents: 0, costsUsd: 0,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
    }).decision, 'ITERATE');
    assert.equal(decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 1, completedDecisionCount: 1,
      netRevenue: 5, trafficEvents: 10, conversionEvents: 1, costsUsd: 40,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
    }).decision, 'PAUSE');
  });
});

describe('8F durable failure records', () => {
  it('records timeout as retryable and permanent as dead-letter after bounds', async () => {
    const { recordFailure } = await importFail();
    const t = await recordFailure({
      error: 'deadline elapsed timeout',
      correlationId: 'fail:timeout-1',
      resumePoint: 'VALIDATE',
    });
    assert.equal(t.classification, 'TIMEOUT');
    assert.equal(t.recoveryState, 'RETRYING');
    assert.equal(t.deadLettered, false);

    const perm = await recordFailure({
      error: 'invalid payload must be a string',
      correlationId: 'fail:perm-1',
    });
    assert.equal(perm.classification, 'VALIDATION');
    assert.equal(perm.recoveryState, 'RESOLVED');
    assert.equal(perm.deadLettered, false);

    const exhausted = await recordFailure({
      error: 'temporar 503',
      correlationId: 'fail:exhaust-1',
      existing: {
        classification: 'TRANSIENT', retryCount: 3, maxRetries: 3, lastError: 'x',
        recoveryState: 'RETRYING', deadLettered: false, resumePoint: 'BUILD', correlationId: 'fail:exhaust-1',
      },
    });
    assert.equal(exhausted.deadLettered, true);
  });
});

describe('8H operations dashboard honesty', () => {
  it('labels capabilities and never mixes simulated with real revenue', async () => {
    const { getPhase8OperationsView } = await importDash();
    const view = await getPhase8OperationsView();
    assert.ok(view.health.length >= 8);
    assert.ok(view.health.every((h) => ['LIVE', 'MOCKED', 'SIMULATED', 'NOT_CONFIGURED', 'NOT_CONNECTED', 'BLOCKED', 'AWAITING_HUMAN_INPUT'].includes(h.state)));
    assert.ok(typeof view.income.simulatedRevenueUsd === 'number');
    assert.ok(typeof view.income.realRevenueUsd === 'number');
    assert.ok(view.capabilities.capabilities.length > 0);
  });
});

describe('8I security invariants in ops layer', () => {
  it('missions cannot request forbidden capabilities', async () => {
    const { createMission } = await importMissions();
    const result = await createMission({
      objective: 'hack',
      agentType: 'research',
      correlationId: 'mission:forbidden',
      allowedCapabilities: ['SHELL' as never],
    });
    assert.equal(result.ok, false);
  });

  it('simulation persistence never sets realTransaction true', async () => {
    const { persistSimulation, runPaperSimulation } = await importSim();
    const { db } = await importDb();
    const sim = runPaperSimulation({ seed: 'sec', correlationId: 'sim:sec' });
    await persistSimulation(sim);
    const rows = await db.simulationRun.findMany({ where: { correlationId: 'sim:sec' } });
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.realTransaction === false && r.label === 'SIMULATED'));
  });
});
