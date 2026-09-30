// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — reads + health tests (hermetic SQLite)
// ============================================================================
// Covers the bounded read projections (field allow-lists, no raw rows, no
// PII leakage) and truthful health derivation.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-agent-reads-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  AI_PROVIDER: 'mock',
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

type ReadsModule = typeof import('../reads');

let reads: ReadsModule;

before(async () => {
  reads = await import('../reads');
});

const opportunityFields = [
  'id', 'title', 'category', 'businessModel', 'targetAudience', 'problemSolved',
  'monetizationMethod', 'halalStatus', 'status', 'overallScore', 'confidenceLevel',
  'evidenceNotes', 'createdAt', 'updatedAt',
];

describe('bounded read projections (real DB)', () => {
  it('READ_OPPORTUNITY returns only the allow-listed fields', async () => {
    const { db } = await import('@/lib/db');
    const opp = await db.opportunity.create({
      data: {
        title: 'Curated developer newsletter',
        category: 'MEDIA',
        businessModel: 'SUBSCRIPTION',
        targetAudience: 'Senior TypeScript engineers',
        problemSolved: 'Scattered release notes',
        monetizationMethod: 'PAID_SUBSCRIPTION',
        halalStatus: 'HALAL',
        status: 'VALIDATED',
        overallScore: 82,
        confidenceLevel: 'HIGH',
        evidenceNotes: 'Recorded evidence only',
        // Field that must NEVER leak into the projection:
        risks: 'internal-only risk notes',
      },
    });

    const projection = await reads.readOpportunity(opp.id);
    assert.ok(projection.found);
    if (projection.found) {
      const keys = Object.keys(projection.data).sort();
      assert.deepEqual(keys, opportunityFields.slice().sort());
      assert.equal((projection.data as Record<string, unknown>).title, 'Curated developer newsletter');
      assert.equal((projection.data as Record<string, unknown>).hasOwnProperty('risks'), false);
    }
  });

  it('READ_OPPORTUNITY reports not_found for a missing id without details', async () => {
    const projection = await reads.readOpportunity('does-not-exist');
    assert.equal(projection.found, false);
    if (!projection.found) assert.equal(projection.reason, 'not_found');
  });

  it('READ_ANALYTICS returns recorded experiment aggregates only', async () => {
    const { db } = await import('@/lib/db');
    const opp = await db.opportunity.create({ data: { title: 'Analytics probe', category: 'MEDIA', businessModel: 'SUBSCRIPTION', targetAudience: 'x', problemSolved: 'y', monetizationMethod: 'SUBSCRIPTION' } });
    await db.experiment.create({
      data: { hypothesis: 'Pricing page test', opportunityId: opp.id, decision: 'SCALE', visitors: 120, revenue: 340.5 },
    });

    const projection = await reads.readAnalytics(opp.id);
    assert.ok(projection.found);
    if (projection.found) {
      assert.equal(projection.data.experimentCount, 1);
      assert.deepEqual(projection.data.decisionsOnFile, ['SCALE']);
      assert.equal(projection.data.basis, 'RECORDED_DATA_ONLY');
    }
  });

  it('READ_REVENUE returns aggregates, never individual payment rows', async () => {
    const { db } = await import('@/lib/db');
    const opp = await db.opportunity.create({ data: { title: 'Revenue probe', category: 'MEDIA', businessModel: 'SUBSCRIPTION', targetAudience: 'x', problemSolved: 'y', monetizationMethod: 'SUBSCRIPTION' } });
    await db.revenue.create({ data: { date: new Date(), revenueSource: 'test', grossRevenue: 100, netRevenue: 80, opportunityId: opp.id } });
    await db.revenue.create({ data: { date: new Date(), revenueSource: 'test', grossRevenue: 50, netRevenue: 40, opportunityId: opp.id } });

    const projection = await reads.readRevenue(opp.id);
    assert.ok(projection.found);
    if (projection.found) {
      assert.equal(projection.data.recordCount, 2);
      assert.equal(projection.data.grossTotal, 150);
      assert.equal(projection.data.netTotal, 120);
      assert.equal(projection.data.basis, 'VERIFIED_RECORDED_ROWS');
      // No individual row ids leak out.
      assert.equal(JSON.stringify(projection.data).includes('"id"'), false);
    }
  });

  it('returns a bounded failure projection on a DB error instead of throwing', async () => {
    const brokenStore = {
      opportunity: { findUnique: async () => { throw new Error('db offline'); } },
      experiment: { findMany: async () => { throw new Error('db offline'); } },
      revenue: { findMany: async () => { throw new Error('db offline'); } },
    };
    const a = await reads.readOpportunity('x', brokenStore as never);
    const b = await reads.readAnalytics('x', brokenStore as never);
    const c = await reads.readRevenue('x', brokenStore as never);
    assert.equal(a.found, false);
    assert.equal(b.found, false);
    assert.equal(c.found, false);
  });
});

describe('truthful health derivation', () => {
  it('derives READY from real config + reachable DB', async () => {
    Object.assign(process.env, {
      AGENT_HEALTHTEST_TOKEN: 'health-test-token',
      AGENT_HEALTHTEST_ID: 'health-test-agent',
      AGENT_HEALTHTEST_CAPABILITIES: 'READ_OPPORTUNITY',
    });
    try {
      const health = await reads.deriveAgentHealth(['READ_OPPORTUNITY']);
      assert.equal(health.status, 'READY');
      assert.equal(health.credentialsConfigured, true);
      assert.equal(health.databaseReachable, true);
      assert.equal(health.contractVersion, 'v1');
    } finally {
      delete process.env.AGENT_HEALTHTEST_TOKEN;
      delete process.env.AGENT_HEALTHTEST_ID;
      delete process.env.AGENT_HEALTHTEST_CAPABILITIES;
    }
  });

  it('derives NOT_CONFIGURED with no credentials (never fakes READY)', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AGENT_') && key.endsWith('_TOKEN')) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
    try {
      const health = await reads.deriveAgentHealth([]);
      assert.equal(health.status, 'NOT_CONFIGURED');
      assert.equal(health.credentialsConfigured, false);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
