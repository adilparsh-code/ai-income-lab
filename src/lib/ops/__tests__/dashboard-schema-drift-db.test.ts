// ============================================================================
// Dashboard loaders vs. a database that is behind prisma/migrations
// ============================================================================
// Regression for the production dashboard crash: when migration 0010 had not
// been applied, every full-row `db.revenue.findMany()` failed with Prisma
// P2022 (column `Revenue.revenueBasis` does not exist) and the uncaught
// rejection crashed the dashboard Server Component render. Here the Revenue
// columns added by 0010 are dropped from a hermetic SQLite database and the
// dashboard loaders must still succeed, because they select only the columns
// they actually read.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { db } from '@/lib/db';
import { getDashboardStats, getRevenueChartData } from '@/actions/dashboard';
import { getLifecycleOverview } from '@/actions/lifecycle';
import { getBusinessIntelligenceSummary } from '@/actions/business-intelligence';

// The Prisma client is constructed lazily on first query, so pointing
// DATABASE_URL at the temporary database here (after imports) is sufficient.
const tempDir = mkdtempSync(join(tmpdir(), 'aill-dashboard-drift-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  execSync('npx prisma7 db push --schema=prisma/schema.test.prisma', {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: process.env,
  });

  const opportunity = await db.opportunity.create({
    data: {
      title: 'Drift test opportunity',
      category: 'Test',
      businessModel: 'Direct Sales',
      targetAudience: 'Testers',
      problemSolved: 'Schema drift',
      monetizationMethod: 'Sales',
      overallScore: 70,
    },
  });
  await db.revenue.create({
    data: {
      date: new Date(),
      revenueSource: 'test',
      grossRevenue: 100,
      fees: 10,
      netRevenue: 90,
      opportunityId: opportunity.id,
    },
  });

  // Simulate a database where migration 0010 has not been applied.
  await db.$executeRawUnsafe('DROP INDEX IF EXISTS "Revenue_revenueBasis_idx"');
  for (const column of ['revenueBasis', 'recognizedUsd', 'refundTotalUsd', 'evidenceBasis']) {
    await db.$executeRawUnsafe(`ALTER TABLE "Revenue" DROP COLUMN "${column}"`);
  }
});

after(async () => {
  await db.$disconnect().catch(() => undefined);
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

describe('dashboard loaders against a pre-0010 Revenue table', () => {
  it('a full-row Revenue read fails (proves the simulated drift)', async () => {
    // PostgreSQL reports this as P2022; the SQLite test adapter wraps it in a
    // driver error, so the drift is asserted on the missing column itself.
    await assert.rejects(() => db.revenue.findMany(), /revenueBasis/);
  });

  it('getDashboardStats succeeds and reports recorded revenue', async () => {
    const stats = await getDashboardStats();
    assert.equal(stats.totalOpportunities, 1);
    assert.equal(stats.totalRevenue, 90);
  });

  it('getRevenueChartData succeeds', async () => {
    const data = await getRevenueChartData();
    assert.equal(data.length, 6);
    assert.equal(data.reduce((sum, m) => sum + m.revenue, 0), 90);
  });

  it('getLifecycleOverview succeeds', async () => {
    const overview = await getLifecycleOverview();
    assert.equal(overview.opportunities.length, 1);
  });

  it('getBusinessIntelligenceSummary loads real data instead of its error fallback', async () => {
    const summary = await getBusinessIntelligenceSummary();
    assert.equal(summary.error, null);
    assert.equal(summary.hasRevenueData, true);
    assert.equal(summary.overall.recordCount, 1);
  });
});
