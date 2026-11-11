// ============================================================================
// PHASE 4.2E — SERVER-SIDE SURFACE ISOLATION
// ============================================================================
// These tests exercise the REAL query filters and REAL loader functions against
// a real SQLite database. Nothing is mocked at the authorization boundary: the
// scope objects are produced by resolveTenantScope's decision path, and the
// loaders run their production Prisma queries.
//
// Covered:
//   * relation-derived partitions (Revenue via Opportunity OR Product,
//     Experiment, Product, Offer, AgentLog)
//   * dashboard aggregates (counts, top opportunity, revenue totals)
//   * business-intelligence, lifecycle and income-engine summaries
//   * write-path attachment guards
//   * request scope resolution: valid, spoofed, suspended, unauthenticated
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTestDatabase } from '@/test-utils/install-test-database';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-surface-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  OPERATOR_CONTROL_TOKEN: 'test-operator-token-value',
});

before(() => {
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

type TenantScope = import('@/lib/tenancy/scope').TenantScope;

let db: (typeof import('@/lib/db'))['db'];
let scopeMod: typeof import('@/lib/tenancy/scope');
let rel: typeof import('@/lib/tenancy/relation-scope');
let dashboard: typeof import('@/lib/loaders/dashboard');
let bi: typeof import('@/lib/loaders/business-intelligence');
let lifecycle: typeof import('@/lib/loaders/lifecycle');
let income: typeof import('@/lib/income-engine/summary');
let actionScope: typeof import('@/lib/tenancy/action-scope');

let scopeA: TenantScope;
let scopeB: TenantScope;
let legacy: TenantScope;

let tenantAId = '';
let oppA = '';
let oppB = '';
let oppLegacy = '';
let productA = '';
let productB = '';

const PRINCIPAL_A = 'surface-test-principal-a';

before(async () => {
  ({ db } = await import('@/lib/db'));
  scopeMod = await import('@/lib/tenancy/scope');
  rel = await import('@/lib/tenancy/relation-scope');
  dashboard = await import('@/lib/loaders/dashboard');
  bi = await import('@/lib/loaders/business-intelligence');
  lifecycle = await import('@/lib/loaders/lifecycle');
  income = await import('@/lib/income-engine/summary');
  actionScope = await import('@/lib/tenancy/action-scope');

  const a = await db.tenant.create({ data: { slug: 'surface-a', name: 'Surface A' } });
  const b = await db.tenant.create({ data: { slug: 'surface-b', name: 'Surface B' } });
  tenantAId = a.id;

  await db.tenantMembership.create({
    data: { tenantId: a.id, principalFingerprint: PRINCIPAL_A, role: 'ADMIN', status: 'ACTIVE' },
  });

  scopeA = { mode: 'tenant', tenantId: a.id, tenantSlug: a.slug, principal: PRINCIPAL_A, role: 'ADMIN' };
  scopeB = { mode: 'tenant', tenantId: b.id, tenantSlug: b.slug, principal: 'surface-principal-b', role: 'ADMIN' };
  legacy = { mode: 'legacy', principal: 'surface-legacy-operator' };

  const base = {
    category: 'Digital Products',
    businessModel: 'Direct Sales',
    targetAudience: 'Remote workers',
    problemSolved: 'Inconsistent habits',
    monetizationMethod: 'ONE_TIME_PURCHASE',
  };
  const oa = await db.opportunity.create({
    data: { ...base, title: 'A-opportunity', status: 'VALIDATED', overallScore: 91, tenantId: a.id },
  });
  const ob = await db.opportunity.create({
    data: { ...base, title: 'B-opportunity', status: 'VALIDATED', overallScore: 97, tenantId: b.id },
  });
  const ol = await db.opportunity.create({
    data: { ...base, title: 'L-opportunity', status: 'IDEA', overallScore: 40, tenantId: null },
  });
  oppA = oa.id;
  oppB = ob.id;
  oppLegacy = ol.id;

  productA = (await db.product.create({ data: { name: 'A-product', type: 'DIGITAL', opportunityId: oa.id } })).id;
  productB = (await db.product.create({ data: { name: 'B-product', type: 'DIGITAL', opportunityId: ob.id } })).id;
  await db.product.create({ data: { name: 'L-product', type: 'DIGITAL', opportunityId: null } });

  await db.experiment.create({ data: { hypothesis: 'A-experiment', opportunityId: oa.id } });
  await db.experiment.create({ data: { hypothesis: 'B-experiment', opportunityId: ob.id } });

  const day = new Date('2026-01-15T00:00:00.000Z');
  await db.revenue.create({ data: { date: day, revenueSource: 'A-sale', grossRevenue: 100, netRevenue: 80, opportunityId: oa.id } });
  // B's revenue is attributed through the PRODUCT only — the trickiest path.
  await db.revenue.create({ data: { date: day, revenueSource: 'B-sale', grossRevenue: 500, netRevenue: 400, productId: productB } });
  await db.revenue.create({ data: { date: day, revenueSource: 'L-sale', grossRevenue: 20, netRevenue: 10 } });

  await db.offer.create({ data: { type: 'DIGITAL_PRODUCT', title: 'A-offer', opportunityId: oa.id } });
  await db.offer.create({ data: { type: 'DIGITAL_PRODUCT', title: 'B-offer', opportunityId: ob.id } });

  await db.agentLog.create({ data: { agentType: 'research', action: 'A-log', opportunityId: oa.id } });
  await db.agentLog.create({ data: { agentType: 'research', action: 'B-log', opportunityId: ob.id } });
  await db.agentLog.create({ data: { agentType: 'research', action: 'L-log' } });
});

describe('A. relation-derived partition filters', () => {
  it('opportunities (direct column)', async () => {
    const rowsA = await db.opportunity.findMany({ where: rel.opportunityWhere(scopeA) });
    assert.deepEqual(rowsA.map((r) => r.id), [oppA]);
    const rowsLegacy = await db.opportunity.findMany({ where: rel.opportunityWhere(legacy) });
    assert.deepEqual(rowsLegacy.map((r) => r.id), [oppLegacy]);
  });

  it('products (via opportunity; unattributed stays legacy)', async () => {
    const rowsA = await db.product.findMany({ where: rel.productWhere(scopeA) });
    assert.deepEqual(rowsA.map((r) => r.id), [productA]);
    const rowsLegacy = await db.product.findMany({ where: rel.productWhere(legacy) });
    assert.deepEqual(rowsLegacy.map((r) => r.name), ['L-product']);
    const rowsB = await db.product.findMany({ where: rel.productWhere(scopeB) });
    assert.deepEqual(rowsB.map((r) => r.id), [productB]);
  });

  it('revenue (via opportunity OR product -> opportunity)', async () => {
    const rowsA = await db.revenue.findMany({ where: rel.revenueWhere(scopeA) });
    assert.deepEqual(rowsA.map((r) => r.revenueSource), ['A-sale']);

    const rowsB = await db.revenue.findMany({ where: rel.revenueWhere(scopeB) });
    assert.deepEqual(rowsB.map((r) => r.revenueSource), ['B-sale'], 'product-attributed revenue follows the product owner');

    const rowsLegacy = await db.revenue.findMany({ where: rel.revenueWhere(legacy) });
    assert.deepEqual(rowsLegacy.map((r) => r.revenueSource), ['L-sale'], 'tenant revenue is never visible in legacy mode');
  });

  it('experiments, offers and agent logs', async () => {
    assert.deepEqual(
      (await db.experiment.findMany({ where: rel.experimentWhere(scopeA) })).map((r) => r.hypothesis),
      ['A-experiment'],
    );
    assert.deepEqual(
      (await db.offer.findMany({ where: rel.offerWhere(scopeA) })).map((r) => r.title),
      ['A-offer'],
    );
    assert.deepEqual(
      (await db.offer.findMany({ where: rel.offerWhere(legacy) })).map((r) => r.title),
      [],
    );
    const logsA = await db.agentLog.findMany({ where: await rel.agentLogWhere(scopeA) });
    assert.deepEqual(logsA.map((r) => r.action), ['A-log']);
    const logsLegacy = await db.agentLog.findMany({ where: await rel.agentLogWhere(legacy) });
    assert.deepEqual(logsLegacy.map((r) => r.action), ['L-log']);
  });
});

describe('B. dashboard and aggregate isolation', () => {
  it('dashboard stats report only the scoped partition', async () => {
    const a = await dashboard.getDashboardStats(scopeA);
    assert.equal(a.totalOpportunities, 1);
    assert.equal(a.validatedOpportunities, 1);
    assert.equal(a.totalRevenue, 80);
    assert.equal(a.topOpportunity?.title, 'A-opportunity');

    const b = await dashboard.getDashboardStats(scopeB);
    assert.equal(b.totalOpportunities, 1);
    assert.equal(b.totalRevenue, 400);

    const l = await dashboard.getDashboardStats(legacy);
    assert.equal(l.totalOpportunities, 1);
    assert.equal(l.totalRevenue, 10);
    assert.equal(l.topOpportunity?.title, 'L-opportunity');
  });

  it('next best action never selects a foreign opportunity', async () => {
    const a = await dashboard.getNextBestAction(scopeA);
    assert.equal(a?.opportunityId, oppA);
    const l = await dashboard.getNextBestAction(legacy);
    assert.equal(l?.opportunityId, oppLegacy, 'legacy sees only its own unattributed row');
  });

  it('business intelligence aggregates only scoped records', async () => {
    const a = await bi.getBusinessIntelligenceSummary(scopeA);
    assert.equal(a.error, null);
    for (const entity of a.topEntities) {
      assert.ok(!entity.label.includes('B-'), `foreign entity leaked: ${entity.label}`);
    }
    const b = await bi.getBusinessIntelligenceSummary(scopeB);
    for (const entity of b.topEntities) {
      assert.ok(!entity.label.includes('A-'), `foreign entity leaked: ${entity.label}`);
    }
  });

  it('lifecycle and income-engine summaries are scoped', async () => {
    const a = await lifecycle.getLifecycleOverview(scopeA);
    assert.equal(a.counts.opportunities, 1);
    assert.equal(a.counts.products, 1);
    assert.equal(a.opportunities[0]?.opportunity.id, oppA);

    const b = await lifecycle.getLifecycleOverview(scopeB);
    assert.equal(b.counts.opportunities, 1);
    assert.equal(b.opportunities[0]?.opportunity.id, oppB);

    const ia = await income.getIncomeEngineSummary(scopeA);
    assert.equal(ia.actionableOpportunities, 1);
    assert.equal(ia.opportunitiesWithRevenue, 1);

    const il = await income.getIncomeEngineSummary(legacy);
    assert.equal(il.actionableOpportunities, 1, 'only the unattributed legacy row is counted');
    assert.equal(il.opportunitiesWithRevenue, 0, 'unattributed revenue is not attributed to an opportunity');
  });
});

describe('C. write-path attachment guards', () => {
  it('refuses to attach to a foreign opportunity', async () => {
    await assert.rejects(
      () => rel.assertOpportunityInScope(scopeA, oppB),
      (error: Error) => error.name === 'TenantAccessError',
    );
    const own = await rel.assertOpportunityInScope(scopeA, oppA);
    assert.equal(own.id, oppA);
  });

  it('refuses to attach to a foreign product', async () => {
    await assert.rejects(
      () => rel.assertProductInScope(scopeA, productB),
      (error: Error) => error.name === 'TenantAccessError',
    );
  });

  it('a tenant cannot attach to an unattributed legacy parent', async () => {
    await assert.rejects(
      () => rel.assertOpportunityInScope(scopeA, oppLegacy),
      (error: Error) => error.name === 'TenantAccessError',
      'legacy rows are a separate partition, not a shared pool',
    );
  });
});

describe('D. request scope guard fails closed', () => {
  const req = (headers: Record<string, string> = {}) =>
    new Request('http://internal.test/action', { headers });

  it('resolves a valid membership', async () => {
    const scope = await actionScope.currentScope('tenant:read', 'test:surface', {
      request: req({ 'x-tenant-id': 'surface-a' }),
      principal: PRINCIPAL_A,
    });
    assert.equal(scope.mode, 'tenant');
    assert.equal(scopeMod.scopeTenantId(scope), tenantAId);
  });

  it('a spoofed tenant header is refused (naming is not a grant)', async () => {
    await assert.rejects(
      () =>
        actionScope.currentScope('tenant:read', 'test:surface', {
          request: req({ 'x-tenant-id': 'surface-b' }),
          principal: PRINCIPAL_A,
        }),
      (error: Error & { status?: number }) => error.name === 'TenantActionError' && error.status === 403,
    );
  });

  it('no principal is refused before any query', async () => {
    await assert.rejects(
      () => actionScope.currentScope('tenant:read', 'test:surface', { request: req() }),
      (error: Error & { reason?: string }) => error.name === 'TenantActionError' && error.reason === 'NO_PRINCIPAL',
    );
  });

  it('a suspended membership authorizes nothing', async () => {
    const suspendedTenant = await db.tenant.create({ data: { slug: 'surface-susp', name: 'Susp' } });
    await db.tenantMembership.create({
      data: {
        tenantId: suspendedTenant.id,
        principalFingerprint: 'surface-principal-susp',
        role: 'ADMIN',
        status: 'SUSPENDED',
      },
    });
    await assert.rejects(
      () =>
        actionScope.currentScope('tenant:read', 'test:surface', {
          request: req({ 'x-tenant-id': 'surface-susp' }),
          principal: 'surface-principal-susp',
        }),
      (error: Error & { reason?: string }) => error.name === 'TenantActionError' && error.reason === 'MEMBERSHIP_SUSPENDED',
    );
  });

  it('a read-only role cannot exercise a write permission', async () => {
    const viewerTenant = await db.tenant.create({ data: { slug: 'surface-viewer', name: 'Viewer' } });
    await db.tenantMembership.create({
      data: {
        tenantId: viewerTenant.id,
        principalFingerprint: 'surface-principal-viewer',
        role: 'VIEWER',
        status: 'ACTIVE',
      },
    });
    await assert.rejects(
      () =>
        actionScope.currentScope('tenant:write', 'test:surface', {
          request: req({ 'x-tenant-id': 'surface-viewer' }),
          principal: 'surface-principal-viewer',
        }),
      (error: Error & { status?: number }) => error.name === 'TenantActionError' && error.status === 403,
    );
  });
});
