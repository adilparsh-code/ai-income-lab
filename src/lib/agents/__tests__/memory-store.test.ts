// Phase 5 — Durable agent memory store tests.
//
// The store derives bounded, provenance-aware memory entries from REAL DB
// records (AgentLog, Experiment). Tests run against a temporary libSQL file
// database (schema pushed via prisma) — no mock data is presented as real.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-mem-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma7 db push --schema prisma/schema.test.prisma', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* tmp cleanup best-effort */ }
});

// Lazy imports AFTER the env var is set so the db module resolves DATABASE_URL.
const importStore = () => import('../memory-store');
const importDb = () => import('@/lib/db');

async function seedOpportunity(overrides: Partial<{ title: string; status: string }> = {}) {
  const { db } = await importDb();
  return db.opportunity.create({
    data: {
      title: overrides.title ?? 'SQLite course for Rust devs',
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'rust developers',
      problemSolved: 'No practical SQLite internals course',
      monetizationMethod: 'ONE_TIME',
      status: overrides.status ?? 'RESEARCHED',
    },
  });
}

describe('durable memory store', () => {
  it('derives memory entries from a real research AgentLog with provenance', async () => {
    const { db } = await importDb();
    const { buildOpportunityMemory, MEMORY_CATEGORY_LIST } = await importStore();

    assert.ok(MEMORY_CATEGORY_LIST.includes('VERIFIED_FACTS'));
    assert.equal(MEMORY_CATEGORY_LIST.length, 7);

    const opportunity = await seedOpportunity();

    await db.agentLog.create({
      data: {
        agentType: 'research',
        action: 'research.findings',
        input: `research: ${opportunity.id} sqlite demand`,
        output: JSON.stringify({
          summary: 'Strong recurring forum demand',
          evidence: [{ fact: '12 distinct forum threads in 30 days', source: 'https://example.org/threads' }],
        }),
        success: true,
      },
    });

    const memory = await buildOpportunityMemory(opportunity.id);
    assert.ok(memory.length >= 1, 'expected at least one memory entry');
    for (const entry of memory) {
      assert.ok(entry.provenance.startsWith('AgentLog:'));
      assert.ok(entry.createdAt);
      assert.ok(entry.content.length <= 600);
    }
  });

  it('VERIFIED_DATA research log lands in VERIFIED_FACTS; AI stays AI_INFERENCE', async () => {
    const { db } = await importDb();
    const { buildOpportunityMemory } = await importStore();

    const opportunity = await seedOpportunity({ title: 'Provenance split opp' });

    await db.agentLog.create({
      data: {
        agentType: 'research', action: 'research.findings',
        input: `research: ${opportunity.id} provenance`,
        output: '{"summary":"x"}',
        evidenceType: 'VERIFIED_DATA',
        success: true,
      },
    });
    await db.agentLog.create({
      data: {
        agentType: 'research', action: 'research.findings',
        input: `research: ${opportunity.id} provenance`,
        output: '{"summary":"y"}',
        evidenceType: 'AI_INFERENCE',
        success: true,
      },
    });

    const memory = await buildOpportunityMemory(opportunity.id);
    const byCategory = new Map(memory.map((m) => [m.category, m]));
    assert.ok(byCategory.has('VERIFIED_FACTS'), 'VERIFIED_DATA log must map to VERIFIED_FACTS');
    assert.ok(byCategory.has('AI_INFERENCE'), 'AI_INFERENCE log must stay AI_INFERENCE');
  });

  it('bounded retrieval: limit is respected, entries stay compact', async () => {
    const { db } = await importDb();
    const { buildOpportunityMemory } = await importStore();

    const opportunity = await seedOpportunity({ title: 'Bulk memory opp' });

    for (let i = 0; i < 8; i++) {
      await db.agentLog.create({
        data: {
          agentType: 'research', action: 'research.findings',
          input: `research iteration ${i} ${opportunity.id}: ${'x'.repeat(200)}`,
          output: JSON.stringify({ summary: `finding ${i} ${'y'.repeat(300)}` }),
          success: true,
        },
      });
    }

    const memory = await buildOpportunityMemory(opportunity.id, { limit: 3 });
    assert.ok(memory.length <= 3, `limit must be respected, got ${memory.length}`);
    for (const entry of memory) assert.ok(entry.content.length <= 600);
  });

  it('failed validation becomes FAILED_HYPOTHESES-style decision record, promising kept', async () => {
    const { db } = await importDb();
    const { buildOpportunityMemory } = await importStore();

    const opportunity = await seedOpportunity({ title: 'Hypothesis tracking opp' });

    await db.agentLog.create({
      data: {
        agentType: 'validation', action: 'validation.assess',
        input: `validation: ${opportunity.id} weak`,
        output: JSON.stringify({ recommendation: 'WEAK_SIGNAL' }),
        success: true,
      },
    });
    await db.agentLog.create({
      data: {
        agentType: 'validation', action: 'validation.assess',
        input: `validation: ${opportunity.id} promising`,
        output: JSON.stringify({ recommendation: 'PROMISING' }),
        success: true,
      },
    });

    const memory = await buildOpportunityMemory(opportunity.id);
    const decisions = memory.filter((m) => m.category === 'AI_INFERENCE').map((m) => m.content);
    assert.ok(decisions.some((c) => c.includes('WEAK_SIGNAL')), `weak decision recorded, got: ${decisions.join(' | ')}`);
    assert.ok(decisions.some((c) => c.includes('PROMISING')), `promising decision recorded, got: ${decisions.join(' | ')}`);
  });

  it('experiment SCALE decision becomes SUCCESSFUL_PATTERNS; KILL becomes FAILED_HYPOTHESES', async () => {
    const { db } = await importDb();
    const { buildOpportunityMemory } = await importStore();

    const opportunity = await seedOpportunity({ title: 'Experiment memory opp' });

    await db.experiment.create({
      data: {
        hypothesis: 'SEO landing page converts',
        opportunityId: opportunity.id,
        visitors: 150,
        revenue: 240,
        decision: 'SCALE',
      },
    });
    await db.experiment.create({
      data: {
        hypothesis: 'Paid social funnel converts',
        opportunityId: opportunity.id,
        visitors: 80,
        revenue: 0,
        decision: 'KILL',
      },
    });

    const memory = await buildOpportunityMemory(opportunity.id);
    const categories = memory.map((m) => m.category);
    assert.ok(categories.includes('SUCCESSFUL_PATTERNS'), `expected SUCCESSFUL_PATTERNS, got ${categories.join(',')}`);
    assert.ok(categories.includes('FAILED_HYPOTHESES'), `expected FAILED_HYPOTHESES, got ${categories.join(',')}`);
    const success = memory.find((m) => m.category === 'SUCCESSFUL_PATTERNS')!;
    assert.equal(success.evidenceType, 'VERIFIED_DATA');
    assert.ok(success.provenance.startsWith('Experiment:'));
  });

  it('does not fabricate memory when no records exist', async () => {
    const { buildOpportunityMemory } = await importStore();

    const opportunity = await seedOpportunity({ title: 'Empty opportunity' });

    const memory = await buildOpportunityMemory(opportunity.id);
    assert.equal(memory.length, 0);
  });

  it('memory context items are bounded and provenance-labelled for prompts', async () => {
    const { db } = await importDb();
    const { getOpportunityMemoryContext } = await importStore();

    const opportunity = await seedOpportunity({ title: 'Context items opp' });

    await db.agentLog.create({
      data: {
        agentType: 'research', action: 'research.findings',
        input: `research: ${opportunity.id} ctx`,
        output: '{"summary":"s"}',
        evidenceType: 'VERIFIED_DATA',
        success: true,
      },
    });

    const items = await getOpportunityMemoryContext(opportunity.id);
    assert.ok(items.length >= 1);
    for (const item of items) {
      assert.ok(item.label.length > 0);
      assert.ok(['VERIFIED_DATA', 'AI_INFERENCE', 'USER_ENTERED', 'MOCKED', 'SEARCH_DISCOVERY'].includes(item.evidenceType));
      assert.ok(item.text.length <= 700);
    }
  });
});
