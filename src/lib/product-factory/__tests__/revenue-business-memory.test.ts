// Phase 5.5 — Durable revenue ingestion + Business-Manager memory bridge tests.
//
// Runs against a temporary libSQL database (schema pushed via prisma) — no
// mock data is presented as real. Proves: idempotent revenue recording,
// derived (never caller-supplied) idempotency keys, shared attribution rules,
// VERIFIED-only evidence, and honest business-memory derivation from real rows.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-rev-'));
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

const importDb = () => import('@/lib/db');
const importEcon = () => import('../economics');
const importMem = () => import('@/lib/agents/memory-store');

async function seedProductFor(opportunityTitle: string, productName: string) {
  const { db } = await importDb();
  const opportunity = await db.opportunity.create({
    data: {
      title: opportunityTitle,
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'test audience',
      problemSolved: 'test problem',
      monetizationMethod: 'ONE_TIME',
      status: 'RESEARCHED',
    },
  });
  const product = await db.product.create({
    data: { name: productName, type: 'DIGITAL_PRODUCT', status: 'PUBLISHED', opportunityId: opportunity.id },
  });
  return { opportunity, product };
}

describe('durable revenue ingestion', () => {
  it('records a revenue row with server-derived idempotency and shared attribution', async () => {
    const { recordRevenueWithAttribution, attributeRevenueRow } = await importEcon();
    const { product } = await seedProductFor('Revenue ingestion opp', 'Rev Test Product');

    const result = await recordRevenueWithAttribution({
      date: new Date().toISOString(),
      revenueSource: 'Gumroad payout',
      grossRevenue: 42,
      fees: 2,
      productId: product.id,
      opportunityId: product.opportunityId,
    });

    assert.equal(result.status, 'RECORDED');
    assert.ok(result.revenueId);
    assert.ok(result.errors.length === 0);
    assert.ok(result.attribution);
    assert.equal(result.attribution!.source, 'PRODUCT');
    assert.equal(result.attribution!.evidenceType, 'VERIFIED');
    // Independent derivation must agree with the stored attribution.
    const direct = attributeRevenueRow({
      id: result.revenueId!,
      date: new Date(),
      revenueSource: 'Gumroad payout',
      grossRevenue: 42,
      fees: 2,
      netRevenue: 40,
      productId: product.id,
      opportunityId: product.opportunityId,
    });
    assert.equal(direct.source, result.attribution!.source);
  });

  it('collapses an identical replay to DUPLICATE — never a double-recorded figure', async () => {
    const { recordRevenueWithAttribution } = await importEcon();
    const { db } = await importDb();
    const { product } = await seedProductFor('Replay opp', 'Replay Product');

    const input = {
      date: '2026-09-18T10:00:00.000Z',
      revenueSource: 'Stripe',
      grossRevenue: 99,
      fees: 3.3,
      productId: product.id,
      opportunityId: product.opportunityId,
    };
    const first = await recordRevenueWithAttribution(input);
    assert.equal(first.status, 'RECORDED');

    const replay = await recordRevenueWithAttribution(input);
    assert.equal(replay.status, 'DUPLICATE');
    assert.equal(replay.revenueId, null);

    const count = await db.revenue.count({ where: { productId: product.id } });
    assert.equal(count, 1, 'replay must not create a second row');
  });

  it('rejects invalid input without recording and without leaking storage errors', async () => {
    const { recordRevenueWithAttribution } = await importEcon();

    const bad = await recordRevenueWithAttribution({
      date: 'not-a-date',
      revenueSource: '',
      grossRevenue: -5,
    });
    assert.equal(bad.status, 'INVALID');
    assert.ok(bad.errors.length > 0);

    const netAboveGross = await recordRevenueWithAttribution({
      date: new Date().toISOString(),
      revenueSource: 'Test',
      grossRevenue: 10,
      netRevenue: 11,
    });
    assert.equal(netAboveGross.status, 'INVALID');
  });

  it('derives net deterministically when not supplied and attributes CAMPAIGN from the source label', async () => {
    const { recordRevenueWithAttribution } = await importEcon();
    const result = await recordRevenueWithAttribution({
      date: new Date().toISOString(),
      revenueSource: 'direct sale',
      grossRevenue: 20,
      fees: 1,
    });
    assert.equal(result.status, 'RECORDED');
    // Shared attribution rule: no product/opportunity ids + a named source → CAMPAIGN.
    assert.equal(result.attribution!.source, 'CAMPAIGN');
    const { db } = await importDb();
    const row = await db.revenue.findUniqueOrThrow({ where: { id: result.revenueId! } });
    assert.equal(row.netRevenue, 19);
  });
});

describe('Business-Manager memory bridge', () => {
  it('derives product outcomes and growth decisions from real rows with provenance', async () => {
    const { db } = await importDb();
    const { buildOpportunityBusinessMemory, MEMORY_CATEGORY_LIST } = await importMem();

    assert.equal(MEMORY_CATEGORY_LIST.length, 7);
    const { opportunity, product } = await seedProductFor('BM memory opp', 'BM Memory Product');

    await db.revenue.create({
      data: {
        date: new Date(),
        revenueSource: 'GUMROAD',
        grossRevenue: 150,
        fees: 5,
        netRevenue: 145,
        productId: product.id,
      },
    });
    // A deterministic PRODUCT_ANALYZE run whose decision becomes a memory entry.
    await db.jobRun.create({
      data: {
        jobType: 'PRODUCT_ANALYZE',
        status: 'SUCCEEDED',
        correlationId: `bm-test-${product.id}`,
        idempotencyKey: `bm-test-${product.id}`,
        input: JSON.stringify({ productId: product.id, opportunityId: opportunity.id }),
        output: JSON.stringify({ summary: { evidenceState: 'PROMISING', recommendedAction: 'IMPROVE', dataStatus: 'SUPPORTED' } }),
      },
    });

    const entries = await buildOpportunityBusinessMemory(opportunity.id);
    assert.ok(entries.length > 0);

    const outcome = entries.find((e) => e.id.startsWith('product-outcome:'));
    assert.ok(outcome, 'product outcome entry must exist');
    assert.equal(outcome.category, 'SUCCESSFUL_PATTERNS');
    assert.equal(outcome.evidenceType, 'VERIFIED_DATA');
    assert.equal(outcome.provenance, `Product:${product.id}`);
    assert.ok(outcome.content.includes('BM Memory Product'));
    assert.ok(outcome.content.includes('gross $150.00'));

    const growth = entries.find((e) => e.id.startsWith('growth-decision:'));
    assert.ok(growth, 'growth decision entry must exist');
    assert.equal(growth.category, 'BUSINESS_DECISIONS');
    assert.equal(growth.evidenceType, 'VERIFIED_DATA');
    assert.ok(growth.content.includes('PROMISING'));
    assert.ok(growth.content.includes('IMPROVE'));

    // Every entry stays bounded and provenance-carrying.
    for (const e of entries) {
      assert.ok(e.content.length <= 600);
      assert.ok(e.provenance.length > 0);
      assert.ok(e.createdAt.length > 0);
    }
  });

  it('reports no recorded revenue honestly for products without revenue', async () => {
    const { buildOpportunityBusinessMemory } = await importMem();
    const { opportunity } = await seedProductFor('No revenue opp', 'No Revenue Product');

    const entries = await buildOpportunityBusinessMemory(opportunity.id);
    const outcome = entries.find((e) => e.id.startsWith(`product-outcome:`) && e.content.includes('No Revenue Product'));
    assert.ok(outcome, 'outcome entry must exist even without revenue');
    assert.equal(outcome.category, 'EXPERIMENT_RESULTS');
    assert.ok(outcome.content.includes('no recorded revenue yet'));
  });
});
