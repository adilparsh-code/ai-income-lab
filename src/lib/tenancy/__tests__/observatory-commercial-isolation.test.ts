import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-obscomm-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { installTestDatabase } = await import('@/test-utils/install-test-database');
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

type PnlFn = (s: unknown) => Promise<{ totals: { grossRevenueUsd: { value: number | null } } }>;
type CommFn = (s: unknown) => Promise<{ offers: { total: number } }>;

let db: {
  opportunity: { create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }> };
  product: { create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }> };
  revenue: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  offer: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
};
let getPnlObservatory: PnlFn;
let getCommercialSummary: CommFn;

before(async () => {
  const dbMod = (await import('@/lib/db')) as unknown as { db: typeof db };
  db = dbMod.db;
  const obsMod = (await import('@/lib/observatory')) as { getPnlObservatory: PnlFn };
  getPnlObservatory = obsMod.getPnlObservatory;
  const commMod = (await import('@/lib/commercial/commercial-summary')) as { getCommercialSummary: CommFn };
  getCommercialSummary = commMod.getCommercialSummary;
});

describe('observatory/commercial tenant isolation', () => {
  let oppA: string;
  let oppB: string;
  let prodA: string;
  let prodB: string;

  before(async () => {
    const a = await db.opportunity.create({ data: { title: 'A opp', category: 'Digital Products', businessModel: 'Direct', monetizationMethod: 'ONE_TIME_PURCHASE', targetAudience: 't', problemSolved: 'p', tenantId: 'tenant-a', halalStatus: 'HALAL', status: 'VALIDATED' } });
    const b = await db.opportunity.create({ data: { title: 'B opp', category: 'Digital Products', businessModel: 'Direct', monetizationMethod: 'ONE_TIME_PURCHASE', targetAudience: 't', problemSolved: 'p', tenantId: 'tenant-b', halalStatus: 'HALAL', status: 'VALIDATED' } });
    oppA = a.id; oppB = b.id;
    const pa = await db.product.create({ data: { opportunityId: oppA, name: 'A prod', type: 'DIGITAL_PRODUCT', status: 'PUBLISHED' } });
    const pb = await db.product.create({ data: { opportunityId: oppB, name: 'B prod', type: 'DIGITAL_PRODUCT', status: 'PUBLISHED' } });
    prodA = pa.id; prodB = pb.id;
    await db.revenue.create({ data: { date: new Date(), revenueSource: 'test', grossRevenue: 100, fees: 1, advertisingCost: 1, otherCosts: 1, netRevenue: 97, currency: 'USD', productId: prodA, opportunityId: oppA } });
    await db.revenue.create({ data: { date: new Date(), revenueSource: 'test', grossRevenue: 200, fees: 1, advertisingCost: 1, otherCosts: 1, netRevenue: 197, currency: 'USD', productId: prodB, opportunityId: oppB } });
  });

  it('P&L: tenant A sees only its revenue', async () => {
    const scopeA = { mode: 'tenant' as const, tenantId: 'tenant-a', tenantSlug: 'a', principal: 'p', role: 'ADMIN' };
    const scopeB = { mode: 'tenant' as const, tenantId: 'tenant-b', tenantSlug: 'b', principal: 'p', role: 'ADMIN' };
    const pnlA = await getPnlObservatory(scopeA);
    const pnlB = await getPnlObservatory(scopeB);
    assert.ok(Math.abs((pnlA.totals.grossRevenueUsd.value ?? 0) - 100) < 0.001);
    assert.ok(Math.abs((pnlB.totals.grossRevenueUsd.value ?? 0) - 200) < 0.001);
  });

  it('Commercial summary: offer counts isolated', async () => {
    await db.offer.create({ data: { type: 'DIGITAL_PRODUCT', title: 'A offer', price: 10, opportunityId: oppA } });
    await db.offer.create({ data: { type: 'DIGITAL_PRODUCT', title: 'B offer', price: 20, opportunityId: oppB } });
    const scopeA = { mode: 'tenant' as const, tenantId: 'tenant-a', tenantSlug: 'a', principal: 'p', role: 'ADMIN' };
    const scopeB = { mode: 'tenant' as const, tenantId: 'tenant-b', tenantSlug: 'b', principal: 'p', role: 'ADMIN' };
    const sA = await getCommercialSummary(scopeA);
    const sB = await getCommercialSummary(scopeB);
    assert.equal(sA.offers.total, 1);
    assert.equal(sB.offers.total, 1);
  });

  it('legacy scope does not see tenant rows', async () => {
    const legacy = { mode: 'legacy' as const, principal: 'legacy' };
    const pnl = await getPnlObservatory(legacy);
    assert.equal(pnl.totals.grossRevenueUsd.value, null);
  });
});
