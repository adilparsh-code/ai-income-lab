// Phase 7 — Income Execution Engine tests (real temp DB, no network, no AI).
// Verifies: loop-state derivation from real records, stage gating (halal,
// negative-validation), advance behavior through the job runner, deterministic
// learnings, idempotent correlation IDs, and no fabricated evidence.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-loop-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma db push --schema prisma/schema.test.prisma', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const importEngine = () => import('../engine');
const importDb = () => import('@/lib/db');

async function seedOpp(overrides: Partial<{ title: string; halalStatus: string; status: string }> = {}) {
  const { db } = await importDb();
  return db.opportunity.create({
    data: {
      title: overrides.title ?? 'Loop test opportunity',
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

async function cleanupOpp(id: string) {
  const { db } = await importDb();
  await db.agentLog.deleteMany({ where: { input: { contains: id } } });
  await db.jobRun.deleteMany({ where: { opportunityId: id } });
  await db.experiment.deleteMany({ where: { opportunityId: id } });
  await db.revenue.deleteMany({ where: { opportunityId: id } });
  await db.productEvent.deleteMany({ where: { opportunityId: id } });
  await db.product.deleteMany({ where: { opportunityId: id } });
  await db.opportunity.delete({ where: { id } });
}

describe('income loop state derivation', () => {
  it('returns null for an unknown opportunity (never fabricates)', async () => {
    const { getIncomeLoopState } = await importEngine();
    assert.equal(await getIncomeLoopState('does-not-exist'), null);
  });

  it('derives a fresh opportunity at RESEARCH with all stages incomplete and NO_DATA', async () => {
    const { getIncomeLoopState } = await importEngine();
    const opp = await seedOpp({ title: 'Fresh loop opportunity' });
    const state = await getIncomeLoopState(opp.id);
    assert.ok(state);
    assert.equal(state.currentStage, 'RESEARCH');
    assert.equal(state.stageIndex, 1);
    assert.equal(state.dataMode, 'NO_DATA');
    const research = state.stages.find((s) => s.stage === 'RESEARCH');
    assert.equal(research?.complete, false);
    assert.match(research?.evidence ?? '', /No research execution recorded/);
    await cleanupOpp(opp.id);
  });

  it('hard-blocks NOT_ALLOWED opportunities with a deterministic blocker', async () => {
    const { getIncomeLoopState } = await importEngine();
    const opp = await seedOpp({ title: 'Blocked loop', halalStatus: 'NOT_ALLOWED' });
    const state = await getIncomeLoopState(opp.id);
    assert.ok(state);
    assert.equal(state.halalGate.blocked, true);
    assert.match(state.advanceBlocker ?? '', /NOT_ALLOWED/);
    await cleanupOpp(opp.id);
  });

  it('blocks BUILD after validation completed without a positive decision', async () => {
    const { db } = await importDb();
    const { getIncomeLoopState } = await importEngine();
    const opp = await seedOpp({ title: 'Negative validation loop', status: 'VALIDATED' });
    await db.agentLog.create({
      data: {
        agentType: 'validation',
        action: 'test',
        input: JSON.stringify({ opportunityId: opp.id }),
        output: JSON.stringify({ recommendation: 'WEAK_SIGNAL' }),
        reasoning: 'test',
        success: true,
      },
    });
    await db.experiment.create({
      data: { opportunityId: opp.id, hypothesis: 'h', decision: 'KILL' },
    });
    const state = await getIncomeLoopState(opp.id);
    assert.ok(state);
    assert.equal(state.metrics.completedDecisions, 1);
    assert.equal(state.metrics.positiveDecisions, 0);
    assert.match(state.advanceBlocker ?? '', /losing signal/);
    await cleanupOpp(opp.id);
  });

  it('marks stages complete from real records including traffic and revenue', async () => {
    const { db } = await importDb();
    const { getIncomeLoopState } = await importEngine();
    const opp = await seedOpp({ title: 'Full funnel loop', status: 'VALIDATED' });
    await db.agentLog.create({
      data: {
        agentType: 'research',
        action: 'test',
        input: JSON.stringify({ opportunityId: opp.id }),
        output: '{}',
        reasoning: 'test',
        success: true,
      },
    });
    await db.experiment.create({
      data: { opportunityId: opp.id, hypothesis: 'h', decision: 'SCALE', visitors: 50, sales: 3 },
    });
    const product = await db.product.create({
      data: {
        opportunityId: opp.id,
        name: 'Loop product',
        type: 'DIGITAL_PRODUCT',
        status: 'PUBLISHED',
        price: 19,
        cost: 2,
      },
    });
    await db.productEvent.create({
      data: {
        productId: product.id,
        opportunityId: opp.id,
        eventType: 'VISITOR',
        occurredAt: new Date(),
        source: 'test',
        idempotencyKey: `p7-test-${opp.id}-1`,
      },
    });
    await db.revenue.create({
      data: {
        opportunityId: opp.id,
        productId: product.id,
        date: new Date(),
        revenueSource: 'test',
        grossRevenue: 57,
        fees: 2,
        netRevenue: 55,
      },
    });

    const state = await getIncomeLoopState(opp.id);
    assert.ok(state);
    assert.equal(state.dataMode, 'LIVE_DATA');
    const byStage = Object.fromEntries(state.stages.map((s) => [s.stage, s]));
    assert.equal(byStage.RESEARCH.complete, true);
    assert.equal(byStage.DECIDE.complete, true);
    assert.equal(byStage.BUILD.complete, true);
    assert.equal(byStage.PUBLISH.complete, true);
    assert.equal(byStage.TRAFFIC.complete, true);
    assert.equal(byStage.CONVERT.complete, true);
    assert.equal(byStage.REVENUE.complete, true);
    assert.equal(state.metrics.netRevenue, 55);
    await cleanupOpp(opp.id);
  });
});

describe('income loop advance', () => {
  it('refuses to advance blocked and review-required opportunities before any job', async () => {
    const { advanceIncomeLoop } = await importEngine();
    const blockedOpp = await seedOpp({ title: 'Advance blocked', halalStatus: 'NOT_ALLOWED' });
    const blocked = await advanceIncomeLoop(blockedOpp.id);
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.jobId, null);
    await cleanupOpp(blockedOpp.id);

    const reviewOpp = await seedOpp({ title: 'Advance review', halalStatus: 'REVIEW_REQUIRED' });
    const review = await advanceIncomeLoop(reviewOpp.id);
    assert.equal(review.status, 'HUMAN_REVIEW');
    assert.equal(review.jobId, null);
    await cleanupOpp(reviewOpp.id);
  });

  it('reports AWAITING_HUMAN_INPUT for data stages instead of fabricating traffic or revenue', async () => {
    const { db } = await importDb();
    const { advanceIncomeLoop } = await importEngine();
    const opp = await seedOpp({ title: 'Data stage loop', status: 'SCALING' });
    // Force revenue stage: revenue row exists → lifecycle IMPROVE → LEARN; use TRAFFIC instead:
    // published product with no traffic events → MARKET → TRAFFIC stage.
    await db.experiment.create({ data: { opportunityId: opp.id, hypothesis: 'h', decision: 'SCALE' } });
    await db.product.create({
      data: { opportunityId: opp.id, name: 'P', type: 'DIGITAL_PRODUCT', status: 'PUBLISHED', price: 10, cost: 1 },
    });
    const outcome = await advanceIncomeLoop(opp.id);
    assert.equal(outcome.stage, 'TRAFFIC');
    assert.equal(outcome.status, 'AWAITING_HUMAN_INPUT');
    assert.equal(outcome.jobId, null);
    assert.match(outcome.message, /cannot fabricate/);
    await cleanupOpp(opp.id);
  });

  it('advances RESEARCH through the real job runner, progresses to VALIDATE, and dedupes a static position', async () => {
    const { db } = await importDb();
    const { advanceIncomeLoop } = await importEngine();
    const opp = await seedOpp({ title: 'Research advance loop' });
    const first = await advanceIncomeLoop(opp.id);
    assert.equal(first.stage, 'RESEARCH');
    assert.ok(first.jobId);
    assert.equal(first.deduplicated, false);

    const job = await db.jobRun.findFirst({ where: { id: first.jobId ?? '' } });
    assert.ok(job);
    assert.equal(job.correlationId, `income-loop:${opp.id}:RESEARCH`);

    // With research evidence on file the frontier moves to VALIDATE — the
    // loop must progress, not re-run a completed stage.
    const second = await advanceIncomeLoop(opp.id);
    assert.equal(second.stage, 'VALIDATE');
    assert.ok(second.jobId);

    // The validation agent designs experiments but records no real outcome
    // rows, so the loop position stays VALIDATE: a third advance re-dispatches
    // the SAME correlation id and must dedupe (idempotency).
    const third = await advanceIncomeLoop(opp.id);
    assert.equal(third.stage, 'VALIDATE');
    assert.equal(third.deduplicated, true);

    await cleanupOpp(opp.id);
  });

  it('PUBLISH without a product fails honestly', async () => {
    const { db } = await importDb();
    const { advanceIncomeLoop } = await importEngine();
    const opp = await seedOpp({ title: 'Publish-no-product loop', status: 'VALIDATED' });
    await db.experiment.create({ data: { opportunityId: opp.id, hypothesis: 'h', decision: 'SCALE' } });
    // No product created yet, but lifecycle says BUILD... create a product row
    // in a non-published status to reach PUBLISH without a publishable target.
    const product = await db.product.create({
      data: { opportunityId: opp.id, name: 'Unfinished', type: 'DIGITAL_PRODUCT', status: 'DRAFT', price: 10, cost: 1 },
    });
    void product;
    const outcome = await advanceIncomeLoop(opp.id, { humanApprovalToken: 'token' });
    // Stage is PUBLISH (product exists, not published). Product exists so the
    // job dispatches; the factory layer reports the honest failure/hold for a
    // draft product without approved build state.
    assert.equal(outcome.stage, 'PUBLISH');
    assert.ok(['FAILED', 'HUMAN_REVIEW', 'BLOCKED', 'DEGRADED'].includes(outcome.status));
    await cleanupOpp(opp.id);
  });
});

describe('loop learnings', () => {
  it('derives no learnings for an unknown opportunity', async () => {
    const { deriveLoopLearnings } = await importEngine();
    assert.deepEqual(await deriveLoopLearnings('missing'), []);
  });

  it('derives a conversion-bottleneck learning when traffic exists without revenue', async () => {
    const { db } = await importDb();
    const { deriveLoopLearnings } = await importEngine();
    const opp = await seedOpp({ title: 'Learning traffic loop' });
    const product = await db.product.create({
      data: { opportunityId: opp.id, name: 'LP', type: 'DIGITAL_PRODUCT', status: 'PUBLISHED', price: 10, cost: 1 },
    });
    await db.productEvent.create({
      data: {
        productId: product.id,
        opportunityId: opp.id,
        eventType: 'VISITOR',
        occurredAt: new Date(),
        source: 'test',
        idempotencyKey: `p7-learn-${opp.id}-1`,
      },
    });
    const learnings = await deriveLoopLearnings(opp.id);
    assert.ok(learnings.length > 0);
    assert.ok(learnings.some((l) => /conversion/i.test(l.learning)));
    assert.equal(learnings[0].evidenceType, 'VERIFIED_DATA');
    await cleanupOpp(opp.id);
  });

  it('derives an iterate-or-kill learning when validation ended negative', async () => {
    const { db } = await importDb();
    const { deriveLoopLearnings } = await importEngine();
    const opp = await seedOpp({ title: 'Learning kill loop' });
    await db.experiment.create({ data: { opportunityId: opp.id, hypothesis: 'h', decision: 'KILL' } });
    const learnings = await deriveLoopLearnings(opp.id);
    assert.ok(learnings.some((l) => /kill|iterate/i.test(l.learning)));
    await cleanupOpp(opp.id);
  });

  it('derives a scale learning on positive net revenue', async () => {
    const { db } = await importDb();
    const { deriveLoopLearnings } = await importEngine();
    const opp = await seedOpp({ title: 'Learning revenue loop' });
    await db.revenue.create({
      data: { opportunityId: opp.id, date: new Date(), revenueSource: 't', grossRevenue: 100, fees: 5, netRevenue: 95 },
    });
    const learnings = await deriveLoopLearnings(opp.id);
    assert.ok(learnings.some((l) => /double down|reinvest/i.test(l.learning)));
    await cleanupOpp(opp.id);
  });
});

describe('loop candidates', () => {
  it('excludes rejected/paused/blocked opportunities', async () => {
    const { getLoopCandidates } = await importEngine();
    const good = await seedOpp({ title: 'Candidate good' });
    const rejected = await seedOpp({ title: 'Candidate rejected', status: 'REJECTED' });
    const blocked = await seedOpp({ title: 'Candidate blocked', halalStatus: 'NOT_ALLOWED' });
    const candidates = await getLoopCandidates(50);
    const ids = candidates.map((c) => c.id);
    assert.ok(ids.includes(good.id));
    assert.ok(!ids.includes(rejected.id));
    assert.ok(!ids.includes(blocked.id));
    await cleanupOpp(good.id);
    await cleanupOpp(rejected.id);
    await cleanupOpp(blocked.id);
  });
});
