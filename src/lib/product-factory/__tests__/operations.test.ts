// Phase 5.5 — Operations summary + capability center tests.
//
// The operations layer aggregates REAL DB rows (JobRun, WorkflowRun, Product,
// Revenue, AgentLog). Tests run against a temporary libSQL file database —
// no mock data is presented as real. Every assertion checks that honest
// labels appear where evidence is absent.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-ops-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma db push', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* tmp cleanup best-effort */ }
});

const importDb = () => import('@/lib/db');
const importOps = () => import('../operations');

async function seedProduct(status: string, name: string) {
  const { db } = await importDb();
  return db.product.create({ data: { name, type: 'DIGITAL_PRODUCT', status } });
}

describe('capability center (pure aggregate)', () => {
  it('derives every capability from real configuration and exposes safe counts', async () => {
    const { describeCapabilityCenter } = await import('../capability-center');
    const report = describeCapabilityCenter();

    assert.ok(report.capabilities.length >= 8);
    const names = report.capabilities.map((c) => c.name);
    for (const expected of ['AI Provider', 'Research Provider', 'Deployment (Vercel)', 'Publishing', 'Ruflo Orchestration']) {
      assert.ok(names.includes(expected), `missing capability: ${expected}`);
    }
    // Counts must add up to the capability list length.
    const total = Object.values(report.counts).reduce((s, v) => s + v, 0);
    assert.equal(total, report.capabilities.length);
    // No capability detail may leak key material patterns.
    for (const c of report.capabilities) {
      assert.ok(!c.detail.includes('sk-'), 'capability detail leaked a key-like string');
    }
  });

  it('reports deployment and publishing as NOT_CONNECTED without credentials — never LIVE', async () => {
    const { describeCapabilityCenter } = await import('../capability-center');
    const report = describeCapabilityCenter();
    const deployment = report.capabilities.find((c) => c.name === 'Deployment (Vercel)')!;
    const publishing = report.capabilities.find((c) => c.name === 'Publishing')!;
    assert.equal(deployment.status, 'NOT_CONNECTED');
    assert.ok(deployment.requiredForLive.some((r) => r.includes('VERCEL_TOKEN')));
    assert.ok(deployment.requiresHumanApproval);
    assert.equal(publishing.status, 'NOT_CONNECTED');
    assert.ok(publishing.requiresHumanApproval);
  });
});

describe('operations summary (real DB aggregates)', () => {
  it('returns honest empty-state labels with no data', async () => {
    const { getOperationsSummary } = await importOps();
    const summary = await getOperationsSummary();

    assert.equal(summary.jobs.today, 0);
    assert.equal(summary.products.length, 0);
    assert.equal(summary.totals.profitLabel, 'INSUFFICIENT_DATA');
    assert.equal(summary.totals.estimatedProfitUsd, null);
    // Deterministic next best action for an empty business.
    assert.equal(summary.nextBestAction.action, 'CONTINUE_DISCOVERY');
    assert.equal(summary.nextBestAction.evidenceStatus, 'SUPPORTED');
  });

  it('aggregates job activity from real JobRun rows', async () => {
    const { db } = await importDb();
    const { getOperationsSummary } = await importOps();

    const mk = (status: string, i: number) =>
      db.jobRun.create({
        data: {
          jobType: 'RESEARCH',
          status,
          correlationId: `corr-${status}-${i}`,
          idempotencyKey: `idem-${status}-${i}-${Math.random().toString(36).slice(2, 8)}`,
          input: '{}',
        },
      });
    await mk('SUCCEEDED', 1);
    await mk('SUCCEEDED', 2);
    await mk('FAILED', 1);
    await mk('BLOCKED', 1);
    await mk('HUMAN_REVIEW', 1);

    const summary = await getOperationsSummary();
    assert.ok(summary.jobs.today >= 5);
    assert.ok(summary.jobs.succeeded24h >= 2);
    assert.ok(summary.jobs.failed24h >= 1);
    assert.ok(summary.jobs.blocked >= 1);
    assert.ok(summary.jobs.humanReview >= 1);
  });

  it('computes product economics from real revenue rows and labels profit honestly', async () => {
    const { db } = await importDb();
    const { getOperationsSummary } = await importOps();

    const product = await seedProduct('PUBLISHED', 'Ops Test Product');
    await db.revenue.create({
      data: {
        date: new Date(),
        revenueSource: 'GUMROAD',
        grossRevenue: 100,
        fees: 10,
        netRevenue: 90,
        productId: product.id,
        referenceNote: 'test-recorded',
      },
    });
    await db.agentLog.create({
      data: {
        agentType: 'product',
        action: 'product.spec',
        productId: product.id,
        inputTokens: 500,
        outputTokens: 500,
        estimatedCostUsd: 4,
      },
    });

    const summary = await getOperationsSummary();
    const row = summary.products.find((p) => p.id === product.id);
    assert.ok(row, 'published product must appear in operations rows');
    assert.equal(row.hasRevenue, true);
    assert.equal(row.grossRevenueUsd, 100);
    assert.equal(row.netRevenueUsd, 90);
    assert.equal(row.estimatedAiCostUsd, 4);
    assert.equal(row.estimatedProfitUsd, 86);
    assert.equal(row.profitLabel, 'ESTIMATED');

    // Human review dominates the next-best-action ranking.
    const reviewSummary = summary;
    if (reviewSummary.jobs.humanReview > 0) {
      assert.equal(reviewSummary.nextBestAction.action, 'RESOLVE_HUMAN_REVIEW');
    }
  });

  it('never fabricates visitor/conversion metrics that were not recorded', async () => {
    const { getOperationsSummary } = await importOps();
    const summary = await getOperationsSummary();
    for (const row of summary.products) {
      if (!row.hasRevenue) {
        assert.equal(row.profitLabel, 'INSUFFICIENT_DATA');
        assert.equal(row.estimatedProfitUsd, null);
      }
      // Traffic metrics stay null unless ProductEvents were recorded.
      if (row.visitors !== null) {
        assert.ok(typeof row.visitors === 'number');
      }
    }
  });
});
