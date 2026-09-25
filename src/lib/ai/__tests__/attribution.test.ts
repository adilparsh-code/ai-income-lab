// Phase 5.4 — AI cost attribution tests: per-product aggregation from the
// single AgentLog ledger, proportional input/output cost split, honest
// ESTIMATED basis, and idempotency (aggregating twice never double-counts).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-attr-'));
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

const importAttribution = () => import('@/lib/ai/attribution');
const importDb = () => import('@/lib/db');

async function seedProduct(name: string): Promise<string> {
  const { db } = await importDb();
  const opportunity = await db.opportunity.create({
    data: {
      title: `Attribution ${name}`,
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'testers',
      problemSolved: 'test',
      monetizationMethod: 'ONE_TIME',
      status: 'VALIDATED',
    },
  });
  const product = await db.product.create({
    data: { name, type: 'DIGITAL_PRODUCT', opportunityId: opportunity.id },
  });
  return product.id;
}

async function seedAiLog(productId: string | null, overrides: Partial<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number; purpose: string }> = {}) {
  const { db } = await importDb();
  return db.agentLog.create({
    data: {
      agentType: 'product',
      action: 'product.spec',
      productId,
      inputTokens: overrides.inputTokens ?? 1000,
      outputTokens: overrides.outputTokens ?? 500,
      estimatedCostUsd: overrides.estimatedCostUsd ?? 0.03,
      purpose: overrides.purpose ?? 'product.spec',
      success: true,
    },
  });
}

describe('per-product AI cost attribution', () => {
  it('aggregates executions for one product with a proportional cost split', async () => {
    const productId = await seedProduct('Attribution Split Product');
    await seedAiLog(productId, { inputTokens: 1000, outputTokens: 1000, estimatedCostUsd: 0.02 });
    await seedAiLog(productId, { inputTokens: 300, outputTokens: 100, estimatedCostUsd: 0.01, purpose: 'product.copy' });

    const { getProductAiCostAttribution } = await importAttribution();
    const summary = await getProductAiCostAttribution(productId);

    assert.equal(summary.basis, 'ESTIMATED_TOKEN_BASED');
    assert.equal(summary.executions, 2);
    assert.equal(summary.inputTokens, 1300);
    assert.equal(summary.outputTokens, 1100);
    // Second log: 75% input, 25% output of $0.01.
    const expectedInput = 0.01 + 0.0075;
    const expectedOutput = 0.01 + 0.0025;
    assert.ok(Math.abs(summary.aiInputCostUsd - expectedInput) < 1e-9);
    assert.ok(Math.abs(summary.aiOutputCostUsd - expectedOutput) < 1e-9);
    assert.ok(Math.abs(summary.aiTotalCostUsd - 0.03) < 1e-9);
  });

  it('is idempotent: repeated aggregation never double-counts', async () => {
    const productId = await seedProduct('Attribution Idempotent Product');
    await seedAiLog(productId, { estimatedCostUsd: 0.05 });

    const { getProductAiCostAttribution } = await importAttribution();
    const first = await getProductAiCostAttribution(productId);
    const second = await getProductAiCostAttribution(productId);
    const third = await getProductAiCostAttribution(productId);

    assert.equal(first.aiTotalCostUsd, second.aiTotalCostUsd);
    assert.equal(second.aiTotalCostUsd, third.aiTotalCostUsd);
    assert.equal(first.executions, second.executions);
    assert.equal(second.executions, 1);
  });

  it('never mixes another product’s executions into the bucket', async () => {
    const productA = await seedProduct('Attribution A');
    const productB = await seedProduct('Attribution B');
    await seedAiLog(productA, { estimatedCostUsd: 0.04 });
    await seedAiLog(productB, { estimatedCostUsd: 99 });

    const { getProductAiCostAttribution } = await importAttribution();
    const summaryA = await getProductAiCostAttribution(productA);
    assert.equal(summaryA.executions, 1);
    assert.ok(Math.abs(summaryA.aiTotalCostUsd - 0.04) < 1e-9);
  });

  it('reports zero honestly for products with no AI usage', async () => {
    const productId = await seedProduct('Attribution Empty Product');
    const { getProductAiCostAttribution } = await importAttribution();
    const summary = await getProductAiCostAttribution(productId);
    assert.equal(summary.executions, 0);
    assert.equal(summary.aiTotalCostUsd, 0);
  });
});

describe('attribution breakdown', () => {
  it('buckets by product/opportunity and reports unattributed rows honestly', async () => {
    const productA = await seedProduct('Breakdown A');
    const productB = await seedProduct('Breakdown B');
    await seedAiLog(productA, { estimatedCostUsd: 0.01 });
    await seedAiLog(productB, { estimatedCostUsd: 0.02 });
    // Unattributed legacy row (no product/opportunity scope).
    const { db } = await importDb();
    await db.agentLog.create({
      data: { agentType: 'research', action: 'research.findings', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.5, success: true },
    });

    const { getAiCostAttributionBreakdown } = await importAttribution();
    const breakdown = await getAiCostAttributionBreakdown({ start: new Date(Date.now() - 86_400_000), end: new Date() });

    assert.ok(breakdown.byProduct[productA]);
    assert.ok(Math.abs(breakdown.byProduct[productA].estimatedCostUsd - 0.01) < 1e-9);
    assert.ok(breakdown.byProduct[productB]);
    assert.ok(breakdown.unattributed.executions >= 1);
    assert.equal(breakdown.basis, 'ESTIMATED_TOKEN_BASED');
    // Totals = sum of product + opportunity + unattributed buckets (no double count).
    const bucketSum = Object.values(breakdown.byProduct).reduce((s, b) => s + b.executions, 0)
      + Object.values(breakdown.byOpportunity).reduce((s, b) => s + b.executions, 0)
      + breakdown.unattributed.executions;
    assert.equal(bucketSum, breakdown.totals.executions);
  });
});
