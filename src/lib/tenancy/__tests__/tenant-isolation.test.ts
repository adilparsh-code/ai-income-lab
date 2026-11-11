// ============================================================================
// PHASE 4.2D — MULTI-TENANT ISOLATION MATRIX (real SQLite database)
// ============================================================================
// Every test here goes through the REAL scope resolution, the REAL scoped read
// helpers, the REAL job runner and the REAL Prisma approval store. Only the
// agent execution seam is replaced (it performs no authorization decision).
//
// The matrix covers:
//   A. cross-tenant reads (opportunity, job, research, product factory chain,
//      product, review, approval, audit)
//   B. cross-tenant writes (job attachment, review decision, approval consume,
//      specification ownership)
//   C. approval binding (tenant, owner, action, expiry, replay)
//   D. background execution (tenant persisted, mismatch refused, retry keeps it)
//   E. scope resolution (legacy partition, spoofing, ambiguity, suspension,
//      inactive tenant, role denial, backend failure)
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTestDatabase } from '@/test-utils/install-test-database';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-tenantiso-'));
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
    /* tmp cleanup best-effort */
  }
});

type Db = (typeof import('@/lib/db'))['db'];
type Scoped = typeof import('../scoped-reads');
type ScopeMod = typeof import('../scope');
type Runner = typeof import('@/lib/jobs/job-runner');
type Approvals = typeof import('@/lib/security/approvals');
type ApprovalScope = typeof import('@/lib/security/approval-scope');
type ProductGen = typeof import('@/lib/product-factory/product-generation');
type Runtime = typeof import('@/lib/agency/runtime');

let db: Db;
let scoped: Scoped;
let scopeMod: ScopeMod;
let runner: Runner;
let approvals: Approvals;
let approvalScope: ApprovalScope;
let productGen: ProductGen;
let runtime: Runtime;

// Fixtures shared by the suite (created once; tests never mutate ownership).
const fx = {
  tenantA: '', tenantB: '', tenantInactive: '', slugA: 'acme', slugB: 'globex', slugInactive: 'dormant',
  oppA: '', oppB: '', jobA: '', jobB: '', researchA: '', productA: '',
  specA: '', generationA: '', versionA: '', packageA: '', reviewA: '', reviewB: '',
  approvalA: '', sessionId: '',
  scopeA: null as unknown as import('../scope').TenantScope,
  scopeB: null as unknown as import('../scope').TenantScope,
  legacy: null as unknown as import('../scope').TenantScope,
};

before(async () => {
  ({ db } = await import('@/lib/db'));
  scoped = await import('../scoped-reads');
  scopeMod = await import('../scope');
  runner = await import('@/lib/jobs/job-runner');
  approvals = await import('@/lib/security/approvals');
  approvalScope = await import('@/lib/security/approval-scope');
  productGen = await import('@/lib/product-factory/product-generation');
  runtime = await import('@/lib/agency/runtime');

  const a = await db.tenant.create({ data: { slug: fx.slugA, name: 'Acme' } });
  const b = await db.tenant.create({ data: { slug: fx.slugB, name: 'Globex' } });
  const inactive = await db.tenant.create({ data: { slug: fx.slugInactive, name: 'Dormant', status: 'INACTIVE' } });
  fx.tenantA = a.id; fx.tenantB = b.id; fx.tenantInactive = inactive.id;

  await db.tenantMembership.createMany({
    data: [
      { tenantId: a.id, principalFingerprint: 'principal-a', role: 'ADMIN' },
      { tenantId: b.id, principalFingerprint: 'principal-b', role: 'ADMIN' },
      { tenantId: a.id, principalFingerprint: 'principal-reader', role: 'VIEWER' },
      { tenantId: b.id, principalFingerprint: 'principal-two', role: 'SENDER' },
      { tenantId: a.id, principalFingerprint: 'principal-two', role: 'SENDER' },
      { tenantId: inactive.id, principalFingerprint: 'principal-inactive', role: 'ADMIN' },
      { tenantId: a.id, principalFingerprint: 'principal-suspended', role: 'ADMIN', status: 'SUSPENDED' },
    ],
  });

  const baseOpportunity = {
    category: 'Digital Products',
    businessModel: 'Direct Sales',
    targetAudience: 'Small businesses',
    problemSolved: 'Planning overhead',
    monetizationMethod: 'ONE_TIME_PURCHASE',
  };
  const oppA = await db.opportunity.create({ data: { ...baseOpportunity, title: 'Acme planner', tenantId: a.id } });
  const oppB = await db.opportunity.create({ data: { ...baseOpportunity, title: 'Globex planner', tenantId: b.id } });
  fx.oppA = oppA.id; fx.oppB = oppB.id;

  fx.jobA = (await db.jobRun.create({
    data: {
      jobType: 'RESEARCH', status: 'SUCCEEDED', correlationId: 'corr-a', idempotencyKey: 'RESEARCH:corr-a',
      opportunityId: oppA.id, tenantId: a.id, input: '{"researchObjective":"a"}',
    },
  })).id;
  fx.jobB = (await db.jobRun.create({
    data: {
      jobType: 'RESEARCH', status: 'SUCCEEDED', correlationId: 'corr-b', idempotencyKey: 'RESEARCH:corr-b',
      opportunityId: oppB.id, tenantId: b.id, input: '{"researchObjective":"b"}',
    },
  })).id;

  fx.researchA = (await db.researchResult.create({
    data: {
      opportunityId: oppA.id, tenantId: a.id, objective: 'Acme research',
      findings: '{"findings":["demand exists"]}', provenance: 'MOCKED',
    },
  })).id;

  fx.productA = (await db.product.create({
    data: { name: 'Acme Product', type: 'DIGITAL', opportunityId: oppA.id },
  })).id;

  const specA = await db.productSpecification.create({
    data: {
      label: 'Acme spec', canonicalBody: '{"name":"acme"}', canonicalHash: 'hash-acme-1',
      requestedBy: 'principal-a', source: 'pipeline', tenantId: a.id,
    },
  });
  fx.specA = specA.id;
  const generationA = await db.productGeneration.create({
    data: { specificationId: specA.id, generationMode: 'autonomous-pipeline', generationRef: 'gen-acme-1' },
  });
  fx.generationA = generationA.id;
  const versionA = await db.productVersion.create({
    data: {
      generationId: generationA.id, productId: fx.productA, versionLabel: 'v1',
      content: '{"title":"acme"}', generationMode: 'autonomous-pipeline', contentCanonicalHash: 'content-acme-1',
    },
  });
  fx.versionA = versionA.id;
  fx.packageA = (await db.productPackage.create({
    data: { versionId: versionA.id, packageType: 'build-manifest', packageBody: '{"a":1}', packageHash: 'pkg-acme-1' },
  })).id;

  fx.reviewA = (await db.humanReview.create({
    data: { category: 'SAFETY_REVIEW', title: 'Acme review', requestedBy: 'handoff-receiver', opportunityId: oppA.id, tenantId: a.id },
  })).id;
  fx.reviewB = (await db.humanReview.create({
    data: { category: 'SAFETY_REVIEW', title: 'Globex review', requestedBy: 'handoff-receiver', opportunityId: oppB.id, tenantId: b.id },
  })).id;

  const session = await db.adminSession.create({
    data: { tokenFingerprint: 'fingerprint-session-1', email: 'owner@example.com', expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  fx.sessionId = session.id;

  const issued = await approvals.issueApproval({
    action: 'PUBLISH_PRODUCT',
    subjectId: fx.productA,
    scopeHash: 'scope-hash-acme',
    approver: { sessionId: fx.sessionId, email: 'owner@example.com' },
    tenantId: a.id,
  });
  fx.approvalA = issued.token;

  // Audit rows in both partitions plus a global one.
  await db.securityEvent.createMany({
    data: [
      { kind: 'TENANT_ISOLATION_TEST', outcome: 'ok', surface: 'test:a', tenantId: a.id },
      { kind: 'TENANT_ISOLATION_TEST', outcome: 'ok', surface: 'test:b', tenantId: b.id },
      { kind: 'TENANT_ISOLATION_TEST', outcome: 'ok', surface: 'test:global' },
    ],
  });

  fx.scopeA = { mode: 'tenant', tenantId: a.id, tenantSlug: fx.slugA, principal: 'principal-a', role: 'ADMIN' };
  fx.scopeB = { mode: 'tenant', tenantId: b.id, tenantSlug: fx.slugB, principal: 'principal-b', role: 'ADMIN' };
  fx.legacy = { mode: 'legacy', principal: 'principal-legacy' };
});

function requestWith(headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/test', { headers });
}

describe('A. cross-tenant reads are denied', () => {
  it('opportunities', async () => {
    assert.equal((await scoped.getScopedOpportunity(fx.scopeA, fx.oppA))?.id, fx.oppA);
    assert.equal(await scoped.getScopedOpportunity(fx.scopeB, fx.oppA), null);
    const listB = await scoped.listScopedOpportunities(fx.scopeB);
    assert.ok(listB.every((o) => o.tenantId === fx.tenantB));
    assert.ok(!listB.some((o) => o.id === fx.oppA));
  });

  it('jobs', async () => {
    assert.equal((await scoped.getScopedJob(fx.scopeA, fx.jobA))?.id, fx.jobA);
    assert.equal(await scoped.getScopedJob(fx.scopeB, fx.jobA), null);
    const jobsB = await scoped.listScopedJobs(fx.scopeB);
    assert.ok(jobsB.every((j) => j.tenantId === fx.tenantB));
  });

  it('research results', async () => {
    assert.equal((await scoped.getScopedResearchResult(fx.scopeA, fx.researchA))?.id, fx.researchA);
    assert.equal(await scoped.getScopedResearchResult(fx.scopeB, fx.researchA), null);
    assert.equal((await scoped.listScopedResearchResults(fx.scopeB, { opportunityId: fx.oppA })).length, 0);
  });

  it('product specification, generation, version, package', async () => {
    assert.equal((await scoped.getScopedSpecification(fx.scopeA, fx.specA))?.id, fx.specA);
    assert.equal(await scoped.getScopedSpecification(fx.scopeB, fx.specA), null);
    assert.equal(await scoped.getScopedGeneration(fx.scopeB, fx.generationA), null);
    assert.equal(await scoped.getScopedVersion(fx.scopeB, fx.versionA), null);
    assert.equal(await scoped.getScopedPackage(fx.scopeB, fx.packageA), null);
    assert.equal((await scoped.listScopedPackages(fx.scopeB, fx.versionA)).length, 0);
  });

  it('products (owned through their opportunity)', async () => {
    assert.equal((await scoped.getScopedProduct(fx.scopeA, fx.productA))?.id, fx.productA);
    assert.equal(await scoped.getScopedProduct(fx.scopeB, fx.productA), null);
    assert.equal((await scoped.listScopedProducts(fx.scopeB)).length, 0);
  });

  it('human reviews', async () => {
    const reviewsB = await scoped.listScopedReviews(fx.scopeB);
    assert.ok(reviewsB.every((r) => r.tenantId === fx.tenantB));
    assert.ok(!reviewsB.some((r) => r.id === fx.reviewA));
    assert.equal(await scoped.getScopedReview(fx.scopeB, fx.reviewA), null);
  });

  it('approval grants', async () => {
    const grantsB = await scoped.listScopedApprovalGrants(fx.scopeB);
    assert.ok(grantsB.every((g) => g.tenantId === fx.tenantB));
    assert.ok(!grantsB.some((g) => g.subjectId === fx.productA));
  });

  it('security audit events (and the legacy partition is disjoint)', async () => {
    const eventsA = await scoped.listScopedSecurityEvents(fx.scopeA, { kind: 'TENANT_ISOLATION_TEST' });
    assert.ok(eventsA.every((e) => e.tenantId === fx.tenantA));
    assert.ok(!eventsA.some((e) => e.surface === 'test:b' || e.surface === 'test:global'));

    const legacyEvents = await scoped.listScopedSecurityEvents(fx.legacy, { kind: 'TENANT_ISOLATION_TEST' });
    assert.ok(legacyEvents.every((e) => e.tenantId === null));
    assert.ok(legacyEvents.some((e) => e.surface === 'test:global'));
    assert.ok(!legacyEvents.some((e) => e.surface === 'test:a' || e.surface === 'test:b'));
  });
});

describe('B. cross-tenant writes are refused', () => {
  it('a write guard rejects a foreign parent', async () => {
    await assert.rejects(() => scoped.requireScopedOpportunity(fx.scopeB, fx.oppA), /outside this tenant/);
    await assert.rejects(() => scoped.requireScopedProduct(fx.scopeB, fx.productA), /outside this tenant/);
    assert.ok((await scoped.requireScopedOpportunity(fx.scopeA, fx.oppA)).id === fx.oppA);
  });

  it('a review decision cannot cross the tenant boundary', async () => {
    const foreign = await runtime.decideHumanReview({
      id: fx.reviewA, decision: 'APPROVE', decidedBy: 'principal-b', tenantId: fx.tenantB,
    });
    assert.equal(foreign.ok, false);
    assert.match(foreign.ok === false ? foreign.error : '', /not found/i);
    // The foreign attempt changed nothing.
    const untouched = await db.humanReview.findUnique({ where: { id: fx.reviewA } });
    assert.equal(untouched?.status, 'PENDING');

    const own = await runtime.decideHumanReview({
      id: fx.reviewA, decision: 'APPROVE', decidedBy: 'principal-a', tenantId: fx.tenantA,
    });
    assert.equal(own.ok, true);
  });

  it('a specification cannot be claimed by another tenant', async () => {
    const spec = { name: 'shared-logical-spec' };
    const owned = await productGen.getOrCreateSpecification({ spec, label: 'A' }, { tenantId: fx.tenantA });
    assert.equal(owned.created, true);

    await assert.rejects(
      () => productGen.getOrCreateSpecification({ spec, label: 'B' }, { tenantId: fx.tenantB }),
      (error: Error) => error.name === 'SpecificationTenantConflictError',
      'a global canonical identity must not hand another tenant the spec',
    );

    // The owning tenant still deduplicates normally.
    const again = await productGen.getOrCreateSpecification({ spec, label: 'A2' }, { tenantId: fx.tenantA });
    assert.equal(again.created, false);
    assert.equal(again.spec.id, owned.spec.id);
  });

  it('approval scope resolution refuses a foreign subject', async () => {
    const foreign = await approvalScope.resolveApprovalScope('PUBLISH_PRODUCT', fx.productA, fx.tenantB);
    assert.equal(foreign.ok, false);
    const own = await approvalScope.resolveApprovalScope('PUBLISH_PRODUCT', fx.productA, fx.tenantA);
    assert.equal(own.ok, true);
  });
});

describe('C. approval grants are tenant-bound', () => {
  it('a grant for tenant A cannot be consumed as tenant B', async () => {
    const denied = await approvals.consumeApproval(fx.approvalA, {
      action: 'PUBLISH_PRODUCT', subjectId: fx.productA, scopeHash: 'scope-hash-acme',
      surface: 'test:cross-tenant', tenantId: fx.tenantB,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.ok === false && denied.reason, 'MISMATCH');
  });

  it('wrong action, wrong subject and expiry are refused', async () => {
    const wrongAction = await approvals.consumeApproval(fx.approvalA, {
      action: 'DEPLOY_PRODUCT', subjectId: fx.productA, scopeHash: 'scope-hash-acme',
      surface: 'test:wrong-action', tenantId: fx.tenantA,
    });
    assert.equal(wrongAction.ok === false && wrongAction.reason, 'MISMATCH');

    const wrongSubject = await approvals.consumeApproval(fx.approvalA, {
      action: 'PUBLISH_PRODUCT', subjectId: 'another-product', scopeHash: 'scope-hash-acme',
      surface: 'test:wrong-subject', tenantId: fx.tenantA,
    });
    assert.equal(wrongSubject.ok === false && wrongSubject.reason, 'MISMATCH');

    const expired = await approvals.consumeApproval(fx.approvalA, {
      action: 'PUBLISH_PRODUCT', subjectId: fx.productA, scopeHash: 'scope-hash-acme',
      surface: 'test:expired', tenantId: fx.tenantA, now: new Date(Date.now() + 11 * 60 * 1000),
    });
    assert.equal(expired.ok === false && expired.reason, 'EXPIRED');
  });

  it('the correct grant is single-use', async () => {
    const first = await approvals.consumeApproval(fx.approvalA, {
      action: 'PUBLISH_PRODUCT', subjectId: fx.productA, scopeHash: 'scope-hash-acme',
      surface: 'test:owner', tenantId: fx.tenantA,
    });
    assert.equal(first.ok, true);
    const replay = await approvals.consumeApproval(fx.approvalA, {
      action: 'PUBLISH_PRODUCT', subjectId: fx.productA, scopeHash: 'scope-hash-acme',
      surface: 'test:replay', tenantId: fx.tenantA,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.ok === false && replay.reason, 'CONSUMED');
  });
});

describe('D. background execution preserves trusted tenant context', () => {
  const successExecutor = async () => ({
    success: true,
    reasoning: 'stub agent',
    evidenceType: 'AI_INFERENCE',
    executionTime: 1,
    output: {},
  });

  it('persists the authorized tenant on the job row', async () => {
    const outcome = await runner.runJob(
      'RESEARCH',
      { researchObjective: 'validate a compliant planner' },
      'iso-corr-ok',
      { db: db as never, executeAgentJob: successExecutor as never, tenantId: fx.tenantA },
    );
    assert.equal(outcome.status, 'SUCCEEDED');
    const row = await db.jobRun.findUnique({ where: { idempotencyKey: 'RESEARCH:iso-corr-ok' } });
    assert.equal(row?.tenantId, fx.tenantA);
  });

  it('refuses a tenant that does not own the parent opportunity and drops the reference', async () => {
    let executed = false;
    const outcome = await runner.runJob(
      'RESEARCH',
      { researchObjective: 'cross tenant attempt', opportunityId: fx.oppA },
      'iso-corr-cross',
      {
        db: db as never,
        tenantId: fx.tenantB,
        executeAgentJob: (async () => {
          executed = true;
          return { success: true, reasoning: '', evidenceType: 'AI_INFERENCE', executionTime: 1, output: {} };
        }) as never,
      },
    );
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /does not match the opportunity owner/);
    assert.equal(executed, false, 'a cross-tenant job must never execute');
    const row = await db.jobRun.findUnique({ where: { idempotencyKey: 'RESEARCH:iso-corr-cross' } });
    assert.equal(row?.opportunityId, null);
  });

  it('derives the tenant from the opportunity when no tenant is supplied (legacy caller)', async () => {
    const outcome = await runner.runJob(
      'RESEARCH',
      { researchObjective: 'legacy caller targets a tenant opportunity', opportunityId: fx.oppA },
      'iso-corr-parent',
      { db: db as never, executeAgentJob: successExecutor as never },
    );
    assert.equal(outcome.status, 'SUCCEEDED');
    const row = await db.jobRun.findUnique({ where: { idempotencyKey: 'RESEARCH:iso-corr-parent' } });
    assert.equal(row?.tenantId, fx.tenantA);
  });

  it('retry preserves the tenant', async () => {
    const outcome = await runner.retryJob(
      'RESEARCH',
      { researchObjective: 'retry keeps the tenant' },
      { db: db as never, executeAgentJob: successExecutor as never, tenantId: fx.tenantA },
    );
    assert.equal(outcome.status, 'SUCCEEDED');
    const row = await db.jobRun.findFirst({
      where: { tenantId: fx.tenantA, input: JSON.stringify({ researchObjective: 'retry keeps the tenant' }) },
    });
    assert.ok(row, 'the retried job must keep tenant A');
  });
});

describe('E. scope resolution fails closed', () => {
  it('an authenticated principal with no membership gets the legacy partition only', async () => {
    const resolved = await scopeMod.resolveTenantScope(requestWith(), {
      db: db as never, principal: 'principal-legacy',
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.ok && resolved.scope.mode, 'legacy');
  });

  it('a named tenant the principal does not belong to is refused', async () => {
    const resolved = await scopeMod.resolveTenantScope(
      requestWith({ 'x-tenant-id': fx.slugB }),
      { db: db as never, principal: 'principal-a' },
    );
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false && resolved.status, 403);
  });

  it('a principal with two memberships must name one', async () => {
    const ambiguous = await scopeMod.resolveTenantScope(requestWith(), { db: db as never, principal: 'principal-two' });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.ok === false && ambiguous.status, 409);

    const named = await scopeMod.resolveTenantScope(
      requestWith({ 'x-tenant-id': fx.slugA }),
      { db: db as never, principal: 'principal-two' },
    );
    assert.equal(named.ok, true);
    assert.equal(named.ok && named.scope.mode === 'tenant' && named.scope.tenantId, fx.tenantA);
  });

  it('a suspended membership authorizes nothing (it does not fall back to legacy)', async () => {
    const resolved = await scopeMod.resolveTenantScope(requestWith(), {
      db: db as never, principal: 'principal-suspended',
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false && resolved.reason, 'MEMBERSHIP_SUSPENDED');
  });

  it('an inactive tenant is refused', async () => {
    const resolved = await scopeMod.resolveTenantScope(requestWith(), {
      db: db as never, principal: 'principal-inactive',
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false && resolved.status, 403);
  });

  it('a read-only role cannot request write permission', async () => {
    const read = await scopeMod.resolveTenantScope(requestWith(), {
      db: db as never, principal: 'principal-reader', permission: 'tenant:read',
    });
    assert.equal(read.ok, true);
    const write = await scopeMod.resolveTenantScope(requestWith(), {
      db: db as never, principal: 'principal-reader', permission: 'tenant:write',
    });
    assert.equal(write.ok, false);
    assert.equal(write.ok === false && write.reason, 'ROLE_NOT_PERMITTED');
  });

  it('an unreachable authorization backend refuses instead of granting', async () => {
    const broken = {
      tenantMembership: {
        findMany: async () => {
          throw new Error('authorization database unavailable');
        },
      },
      securityEvent: { create: async () => ({}) },
    };
    const resolved = await scopeMod.resolveTenantScope(requestWith(), {
      db: broken as never, principal: 'principal-a',
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false && resolved.status, 503);
  });
});
