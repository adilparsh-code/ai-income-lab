// Phase 6 — Shared agent context integration tests (real temp DB, no network,
// no AI). Verifies: assembly from real records, provenance preservation,
// bounded memory, handoff extraction, human-review state, missing-evidence
// honesty, and no fabrication.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-ctx-'));
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

const importCtx = () => import('../agent-context');
const importDb = () => import('@/lib/db');

async function seedOpp(title: string, halalStatus = 'HALAL', status = 'IDEA') {
  const { db } = await importDb();
  return db.opportunity.create({
    data: {
      title,
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'developers',
      problemSolved: 'a real problem',
      monetizationMethod: 'ONE_TIME',
      status,
      halalStatus,
    },
  });
}

async function seedResearchLog(opportunityId: string, evidenceType = 'AI_INFERENCE', recommendation?: string) {
  const { db } = await importDb();
  return db.agentLog.create({
    data: {
      agentType: 'research',
      action: 'test_research',
      input: JSON.stringify({ opportunityId, researchObjective: 'test objective' }),
      output: JSON.stringify({
        ...(recommendation ? { recommendation } : {}),
        assumptions: ['assumption one', 'assumption two'],
        risks: ['risk one'],
      }),
      reasoning: 'Research reasoning text for ' + opportunityId,
      evidenceType,
      success: true,
    },
  });
}

describe('shared agent context (buildAgentContext)', () => {
  it('assembles context from real records with provenance preserved', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Context assembly opportunity');
    await seedResearchLog(opp.id);

    const ctx = await buildAgentContext(opp.id);

    assert.ok(ctx.opportunity);
    assert.equal(ctx.opportunity.id, opp.id);
    assert.equal(ctx.opportunity.title, 'Context assembly opportunity');
    assert.equal(ctx.opportunity.halalStatus, 'HALAL');
    assert.ok(ctx.research.sourceRef?.startsWith('AgentLog:'));
    assert.equal(ctx.research.evidenceType, 'AI_INFERENCE');
    assert.match(ctx.research.summary, /Research recorded/);
    assert.equal(ctx.validation.sourceRef, null);
    assert.match(ctx.validation.summary, /No validation execution on file/);
    assert.equal(ctx.revenue.recordCount, 0);
    assert.equal(ctx.traffic.eventCount, 0);
    // Missing evidence is honest about what is absent.
    assert.ok(ctx.missingEvidence.some((m) => /No validation execution/.test(m)));
    assert.ok(ctx.missingEvidence.some((m) => /No revenue records/.test(m)));
    await db.opportunity.delete({ where: { id: opp.id } });
  });

  it('keeps AI output as AI_INFERENCE and never promotes it to VERIFIED_DATA', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Provenance check opportunity');
    await seedResearchLog(opp.id, 'AI_INFERENCE', 'PROMISING');

    const ctx = await buildAgentContext(opp.id);
    assert.equal(ctx.research.evidenceType, 'AI_INFERENCE');
    // Handoff carries the same provenance as its source log.
    const researchHandoff = ctx.handoffs.find((h) => h.sourceAgent === 'research');
    assert.ok(researchHandoff);
    assert.equal(researchHandoff.evidenceType, 'AI_INFERENCE');
    await db.opportunity.delete({ where: { id: opp.id } });
  });

  it('marks DB-stored VERIFIED_DATA research as VERIFIED_DATA in the slice and handoff', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Verified research opportunity');
    await seedResearchLog(opp.id, 'VERIFIED_DATA');

    const ctx = await buildAgentContext(opp.id);
    assert.equal(ctx.research.evidenceType, 'VERIFIED_DATA');
    const researchHandoff = ctx.handoffs.find((h) => h.sourceAgent === 'research');
    assert.equal(researchHandoff?.evidenceType, 'VERIFIED_DATA');
    await db.opportunity.delete({ where: { id: opp.id } });
  });

  it('extracts bounded handoffs with hypotheses and unresolved questions from research output', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Handoff extraction opportunity');
    await seedResearchLog(opp.id);

    const ctx = await buildAgentContext(opp.id);
    const researchHandoff = ctx.handoffs.find((h) => h.sourceAgent === 'research');
    assert.ok(researchHandoff);
    assert.deepEqual(researchHandoff.hypotheses, ['assumption one', 'assumption two']);
    assert.deepEqual(researchHandoff.unresolvedQuestions, ['risk one']);
    assert.ok(researchHandoff.recommendedNextStep);
    await db.opportunity.delete({ where: { id: opp.id } });
  });

  it('reports REVIEW_REQUIRED in humanReviewState and never relaxes it', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Review-required opportunity', 'REVIEW_REQUIRED');

    const ctx = await buildAgentContext(opp.id);
    assert.equal(ctx.humanReviewState.required, true);
    assert.match(ctx.humanReviewState.reason ?? '', /REVIEW_REQUIRED/);
    await db.opportunity.delete({ where: { id: opp.id } });
  });

  it('reports NOT_ALLOWED in humanReviewState', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Blocked opportunity', 'NOT_ALLOWED');

    const ctx = await buildAgentContext(opp.id);
    assert.equal(ctx.humanReviewState.required, true);
    assert.match(ctx.humanReviewState.reason ?? '', /NOT_ALLOWED/);
    await db.opportunity.delete({ where: { id: opp.id } });
  });

  it('captures experiments, revenue, and traffic as VERIFIED_DATA slices when present', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Outcome data opportunity');
    await db.experiment.create({
      data: {
        opportunityId: opp.id,
        hypothesis: 'Landing page converts',
        budget: 5,
        visitors: 10,
      },
    });
    await db.revenue.create({
      data: {
        opportunityId: opp.id,
        date: new Date(),
        revenueSource: 'test',
        grossRevenue: 100,
        fees: 3,
        advertisingCost: 0,
        otherCosts: 0,
        netRevenue: 97,
      },
    });

    const ctx = await buildAgentContext(opp.id);
    assert.equal(ctx.experiments.total, 1);
    assert.equal(ctx.experiments.slice.evidenceType, 'VERIFIED_DATA');
    assert.equal(ctx.revenue.recordCount, 1);
    assert.equal(ctx.revenue.netTotal, 97);
    assert.equal(ctx.revenue.slice.evidenceType, 'VERIFIED_DATA');
    await db.opportunity.delete({ where: { id: opp.id } });
  });

  it('fails closed for an unknown opportunity (never fabricates a context)', async () => {
    const { buildAgentContext } = await importCtx();
    await assert.rejects(() => buildAgentContext('does-not-exist'), /not found/);
  });

  it('bounds business memory retrieval', async () => {
    const { db } = await importDb();
    const { buildAgentContext } = await importCtx();
    const opp = await seedOpp('Memory bound opportunity');
    for (let i = 0; i < 4; i++) {
      await seedResearchLog(opp.id, 'AI_INFERENCE', i === 0 ? 'PROMISING' : undefined);
    }
    const ctx = await buildAgentContext(opp.id);
    assert.ok(ctx.businessMemory.length > 0);
    assert.ok(ctx.businessMemory.length <= 8);
    // Every memory item carries an evidence label — no undifferentiated blob.
    for (const item of ctx.businessMemory) {
      assert.equal(typeof item.evidenceType, 'string');
      assert.ok(item.evidenceType.length > 0);
    }
    await db.opportunity.delete({ where: { id: opp.id } });
  });
});
