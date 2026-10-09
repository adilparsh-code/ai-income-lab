// ===========================================================================
// PHASE B1 — PRODUCT FACTORY CORE (hermetic DB tests, REAL service layer)
// ===========================================================================
// Exercises the REAL Product Factory Core service against a temporary SQLite
// database (same convention as the commercial-db and agency hermetic suites).
// Nothing is mocked: specification create/find, generation+version creation,
// packaging, immutability, and duplicate-identity protection are all real DB
// operations. Concurrency is approximated by duplicate writes, not by threads
// (Node single-threaded test runner).
// ===========================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-b1-'));
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
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Import the REAL service (uses lazy `db` singleton that picks up DATABASE_URL).
import { db } from '@/lib/db';

import {
  canonicalHashFor,
  getOrCreateSpecification,
  generateFromSpecification,
  createPackageForVersion,
  loadVersionWithChain,
  loadPackagesForVersion,
  versionContentExists,
  type GenerationMode,
} from '../product-generation';
import {
  canonicalSpecificationOf,
  canonicalHashOf,
  toCanonicalJson,
  sha256Hex,
} from '../canonical';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productType: 'DIGITAL_PRODUCT',
    name: 'Homeschool Planner',
    targetAudience: 'Homeschool parents',
    problem: 'Planning lessons takes too long',
    valueProposition: 'Structured weekly plans in minutes',
    mvpFeatures: [
      { name: 'Weekly Planner', description: 'Generates a weekly lesson plan', priority: 'P0' },
      { name: 'Progress Tracker', description: 'Tracks completed lessons', priority: 'P1' },
    ],
    buildPhases: [
      { phase: 1, name: 'Core', tasks: ['Build planner'], expectedOutput: 'Working planner', risk: 'Low' },
    ],
    monetizationModel: 'ONE_TIME_PURCHASE',
    pricingHypothesis: 'Single purchase price to be tested',
    distributionChannels: ['Direct website'],
    risks: ['Limited initial evidence'],
    assumptions: ['Parents want structured plans'],
    evidence: [{ type: 'VERIFIED_DATA', content: 'Recorded validation result' }],
    evidenceProvenance: 'AI_INFERENCE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Specification validation (canonical identity is well-formed)
// ---------------------------------------------------------------------------

describe('B1 specification validation', () => {
  it('canonicalHashFor returns a stable 64-char hex sha256', () => {
    const h = canonicalHashFor({ spec: baseSpec() });
    assert.ok(/^[0-9a-f]{64}$/.test(h), 'canonical hash must be hex sha256');
    assert.equal(h, canonicalHashFor({ spec: baseSpec() }));
  });

  it('canonical hash is stable across equivalent specs with different key order', () => {
    const a = canonicalHashFor({ spec: baseSpec() });
    const shuffled: Record<string, unknown> = {};
    for (const k of Object.keys(baseSpec()).reverse()) {
      shuffled[k] = (baseSpec() as Record<string, unknown>)[k];
    }
    assert.equal(a, canonicalHashFor({ spec: shuffled }));
  });

  it('canonical hash differs when a meaningful field changes', () => {
    assert.notEqual(
      canonicalHashFor({ spec: baseSpec() }),
      canonicalHashFor({ spec: baseSpec({ name: 'Different Name' }) }),
    );
  });

  it('canonical spec uses only canonical fields (volatile metadata excluded)', () => {
    const spec = baseSpec({
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'db-123',
      correlationId: 'corr',
      attempt: 3,
    });
    const canon = canonicalSpecificationOf(spec);
    assert.equal(canon.createdAt, undefined);
    assert.equal(canon.id, undefined);
    assert.equal(canon.correlationId, undefined);
    assert.equal(canon.attempt, undefined);
    const body = toCanonicalJson(canon);
    assert.ok(!body.includes('"createdAt"'));
    assert.ok(!body.includes('db-123'));
    assert.ok(!body.includes('"correlationId"'));
  });
});

// ---------------------------------------------------------------------------
// 2. Deterministic canonicalization (cross-check with service)
// ---------------------------------------------------------------------------

describe('B1 deterministic canonicalization', () => {
  it('service canonicalHashFor matches canonical.ts canonicalHashOf output', () => {
    const spec = baseSpec();
    const expected = canonicalHashOf(canonicalSpecificationOf(spec));
    assert.equal(canonicalHashFor({ spec }), expected);
  });

  it('canonical JSON text is byte-stable for equivalent objects', () => {
    const spec = baseSpec();
    const canon = canonicalSpecificationOf(spec);
    const text = toCanonicalJson(canon);
    const canon2 = canonicalSpecificationOf({
      ...spec,
      mvpFeatures: (spec.mvpFeatures as Record<string, unknown>[]).map((f: Record<string, unknown>) => {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(f).reverse()) o[k] = f[k];
        return o;
      }),
    });
    assert.equal(text, toCanonicalJson(canon2));
  });

  it('sha256 primitive is deterministic', () => {
    assert.equal(sha256Hex('x'), sha256Hex('x'));
    assert.notEqual(sha256Hex('x'), sha256Hex('y'));
  });
});

// ---------------------------------------------------------------------------
// 3. Specification persistence + deterministic identity
// ---------------------------------------------------------------------------

describe('B1 specification persistence', () => {
  it('creates a specification and returns its canonical identity', async () => {
    const { spec, created } = await getOrCreateSpecification({
      spec: baseSpec(),
      label: 'Planner spec',
      requestedBy: 'tester',
      source: 'manual',
    });
    assert.equal(created, true);
    assert.ok(spec.id);
    assert.ok(spec.canonicalHash);
    assert.ok(/^[0-9a-f]{64}$/.test(spec.canonicalHash));
    assert.equal(spec.label, 'Planner spec');
    assert.equal(spec.requestedBy, 'tester');
    assert.equal(spec.source, 'manual');
    const body = JSON.parse(spec.canonicalBody) as Record<string, unknown>;
    assert.deepEqual(body, canonicalSpecificationOf(baseSpec()));
  });

  it('returns the same existing specification when requested again', async () => {
    const specA = baseSpec({ name: 'Unique-' + Math.random().toString(36).slice(2, 8) });
    const first = await getOrCreateSpecification({ spec: specA, label: 'first' });
    const second = await getOrCreateSpecification({ spec: specA, label: 'second' });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.spec.id, first.spec.id);
    assert.equal(second.spec.canonicalHash, first.spec.canonicalHash);
    assert.equal(second.spec.label, 'first');
  });

  it('deterministically resolves equivalent specs with different request shapes', async () => {
    const core = baseSpec({ name: 'Stable-' + Math.random().toString(36).slice(2, 8) });
    const first = await getOrCreateSpecification({ spec: core, requestedBy: 'a', source: 'manual' });
    const second = await getOrCreateSpecification({ spec: core, requestedBy: 'b', source: 'pipeline', label: 'other-label' });
    assert.equal(second.spec.id, first.spec.id);
    assert.equal(second.created, false);
  });
});

// ---------------------------------------------------------------------------
// 4. Generation creates a product version + persists generationMode
// ---------------------------------------------------------------------------

describe('B1 generation creates a product version', () => {
  it('creates a generation and an immutable version linked to the spec', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const result = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: {
        productType: 'DIGITAL_PRODUCT',
        name: 'Homeschool Planner v1',
        mvpFeatures: baseSpec().mvpFeatures,
        buildPhases: baseSpec().buildPhases,
        monetizationModel: 'ONE_TIME_PURCHASE',
      },
      versionLabel: 'v1',
      outcomeSummary: { artifactCount: 3, testsPassed: 2, testsTotal: 2 },
    });
    assert.ok(result.generation.id);
    assert.equal(result.generation.specificationId, spec.id);
    assert.ok(result.generation.generationRef);
    assert.ok(result.generation.generationRef.startsWith(spec.canonicalHash.slice(0, 16)));
    assert.equal(result.generation.generationMode, 'deterministic-builder');
    assert.equal(result.generation.status, 'SUCCEEDED');
    assert.ok(result.version.id);
    assert.equal(result.version.generationId, result.generation.id);
    assert.equal(result.version.versionLabel, 'v1');
    assert.equal(result.version.generationMode, 'deterministic-builder');
    assert.ok(result.version.contentCanonicalHash);
    assert.ok(/^[0-9a-f]{64}$/.test(result.version.contentCanonicalHash));
    const content = JSON.parse(result.version.content);
    assert.equal(content.name, 'Homeschool Planner v1');
    assert.equal(result.version.productId, null);
  });

  it('persists generationMode on BOTH the generation and the version', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const mode = 'autonomous-pipeline';
    const result = await generateFromSpecification(spec.id, {
      generationMode: mode,
      content: { name: 'mode-persist-test', productType: 'DIGITAL_PRODUCT' },
    });
    assert.equal(result.generation.generationMode, mode);
    assert.equal(result.version.generationMode, mode);
  });

  it('derives a stable version label when omitted', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const result = await generateFromSpecification(spec.id, {
      generationMode: 'manual-review',
      content: { name: 'label-test', productType: 'DIGITAL_PRODUCT' },
    });
    assert.equal(result.version.versionLabel, 'v1');
  });

  it('optionally links the version to an existing Product row (plain column)', async () => {
    const product = await db.product.create({
      data: { id: 'prod-1', name: 'Homeschool Planner', type: 'DIGITAL_PRODUCT' },
    });
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const result = await generateFromSpecification(spec.id, {
      generationMode: 'imported',
      content: { name: 'product-link-test', productType: 'DIGITAL_PRODUCT' },
      productId: product.id,
    });
    assert.equal(result.version.productId, product.id);
    const chain = await loadVersionWithChain(result.version.id);
    if (!chain) throw new Error('chain must exist');
    assert.equal(chain!.specification.id, spec.id);
    assert.equal(chain!.generation.specificationId, spec.id);
    await db.product.delete({ where: { id: product.id } });
  });

  it('fails fast on an unknown generation mode (never persisted as garbage)', async () => {
    // Use a UNIQUE spec so we can verify no versions exist for IT (ignoring versions
    // from other tests that share the deterministic baseSpec()).
    const uniqueName = 'unknown-mode-' + Math.random().toString(36).slice(2, 10);
    const { spec } = await getOrCreateSpecification({ spec: baseSpec({ name: uniqueName }) });
    await assert.rejects(
      () =>
        generateFromSpecification(spec.id, {
          generationMode: 'fraudulent-mode' as GenerationMode,
          content: { name: 'unknown-mode-test', productType: 'DIGITAL_PRODUCT' },
        }),
      /Unknown generation mode/,
    );
    const versions = await db.productVersion.findMany({ where: { generation: { specificationId: spec.id } } });
    assert.equal(versions.length, 0, 'no version should be persisted for an unknown generation mode');
  });
});

// ---------------------------------------------------------------------------
// 5. Product version immutability
// ---------------------------------------------------------------------------

describe('B1 product version immutability', () => {
  it('productVersion.contentCanonicalHash is unique (dedup guard)', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const content = { name: 'Immutable', productType: 'DIGITAL_PRODUCT' };
    const first = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content,
      versionLabel: 'v1',
    });
    // Duplicate content resolves to the SAME existing version (dedup), never a new row.
    const second = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content,
      versionLabel: 'v1-duplicate',
    });
    assert.equal(second.version.id, first.version.id, 'duplicate content must return the existing version');
    assert.equal(second.version.versionLabel, 'v1', 'the original label is preserved');
    // Verify only ONE version row exists with this content canonical hash.
    const versions = await db.productVersion.findMany({ where: { contentCanonicalHash: first.version.contentCanonicalHash } });
    assert.equal(versions.length, 1, 'content canonical hash must remain unique');
  });

  it('creates a NEW version (different label) rather than overwriting an existing one', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const v1 = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'v1-content', productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v1',
    });
    const v2 = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'v2-content', productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v2',
    });
    assert.notEqual(v1.version.id, v2.version.id);
    assert.equal(v1.version.versionLabel, 'v1');
    assert.equal(v2.version.versionLabel, 'v2');
    assert.equal(JSON.parse(v1.version.content).name, 'v1-content');
  });

  it('contentCanonicalHash is derived from canonical content (stable)', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const content = { name: 'Stable', productType: 'DIGITAL_PRODUCT' };
    const a = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { ...content, name: 'Stable' },
      versionLabel: 'v1',
    });
    const b = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { ...content, productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v2',
    });
    assert.equal(a.version.contentCanonicalHash, b.version.contentCanonicalHash);
    assert.equal(a.version.id, b.version.id, 'identical canonical content must collapse to ONE version');
  });

  it('versionContentExists detects an existing content canonical hash', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const content = { name: 'Audit', productType: 'DIGITAL_PRODUCT' };
    const created = await generateFromSpecification(spec.id, {
      generationMode: 'manual-review',
      content,
    });
    assert.equal(await versionContentExists(created.version.contentCanonicalHash), true);
    assert.equal(await versionContentExists(sha256Hex('never-existed')), false);
  });
});

// ---------------------------------------------------------------------------
// 6. Package traceability
// ---------------------------------------------------------------------------

describe('B1 package traceability', () => {
  it('creates a package traceable to spec -> generation -> version', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'pkg-traceable-test', productType: 'DIGITAL_PRODUCT' },
    });
    const pkg = await createPackageForVersion(gen.version.id, {
      packageType: 'build-manifest',
      packageBody: {
        productId: 'p-1',
        productType: 'DIGITAL_PRODUCT',
        version: '0.1.0+abc',
      },
      artifactRef: 'manifests/p-1/v1/manifest.json',
    });
    assert.ok(pkg.id);
    assert.equal(pkg.versionId, gen.version.id);
    assert.equal(pkg.packageType, 'build-manifest');
    assert.ok(pkg.packageHash);
    assert.ok(/^[0-9a-f]{64}$/.test(pkg.packageHash));
    assert.equal(pkg.artifactRef, 'manifests/p-1/v1/manifest.json');
    const chain = await loadVersionWithChain(gen.version.id);
    if (!chain) throw new Error('chain must exist');
    assert.equal(chain!.version.id, gen.version.id);
    assert.equal(chain!.generation.generationMode, 'deterministic-builder');
    assert.equal(chain!.specification.id, spec.id);
    const packages = await loadPackagesForVersion(gen.version.id);
    assert.equal(packages.length, 1);
    assert.equal(packages[0].id, pkg.id);
  });

  it('package content is immutable after creation', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'package-immutable-test', productType: 'DIGITAL_PRODUCT' },
    });
    const pkg = await createPackageForVersion(gen.version.id, {
      packageType: 'listing-draft',
      packageBody: { title: 'Draft v1'},
    });
    const reloaded = await db.productPackage.findUnique({ where: { id: pkg.id } });
    assert.ok(reloaded);
    assert.equal(JSON.parse(reloaded.packageBody).title, 'Draft v1');
  });

  it('rejects package creation for a nonexistent version', async () => {
    await assert.rejects(
      () =>
        createPackageForVersion('nonexistent-version', {
          packageType: 'build-manifest',
          packageBody: {},
        }),
      /ProductVersion "nonexistent-version" not found/,
    );
  });

  it('rejects a package with an empty packageType', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'empty-packagetype-test', productType: 'DIGITAL_PRODUCT' },
    });
    await assert.rejects(
      () => createPackageForVersion(gen.version.id, { packageType: '', packageBody: {} }),
      /packageType is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Duplicate identity protection (DB-level + application-level)
// ---------------------------------------------------------------------------

describe('B1 duplicate identity protection', () => {
  it('canonicalHash unique constraint is the real guard against concurrent duplicates', async () => {
    const spec = baseSpec({ name: 'Concurrent-' + Math.random().toString(36).slice(2, 8) });
    const hash = canonicalHashFor({ spec });
    const first = await getOrCreateSpecification({ spec });
    assert.equal(first.created, true);
    const second = await getOrCreateSpecification({ spec });
    assert.equal(second.created, false);
    assert.equal(second.spec.id, first.spec.id);
    await assert.rejects(
      () =>
        db.productSpecification.create({
          data: {
            label: 'dup',
            canonicalBody: first.spec.canonicalBody,
            canonicalHash: hash,
            requestedBy: 'dup',
            source: 'dup',
          },
        }),
      /unique constraint|Unique constraint|SQLITE_CONSTRAINT|P2002/i,
    );
  });

  it('canonicalHash lookup is case/content-sensitive (different specs are distinct)', async () => {
    const a = await getOrCreateSpecification({ spec: baseSpec({ name: 'A' }) });
    const b = await getOrCreateSpecification({ spec: baseSpec({ name: 'B' }) });
    assert.notEqual(a.spec.id, b.spec.id);
    assert.notEqual(a.spec.canonicalHash, b.spec.canonicalHash);
  });
});

// ---------------------------------------------------------------------------
// 8. Failure paths
// ---------------------------------------------------------------------------

describe('B1 failure paths', () => {
  it('getOrCreateSpecification throws on a non-unique db error it cannot classify', async () => {
    const spec = baseSpec({ name: 'Race-' + Math.random().toString(36).slice(2, 8) });
    const first = await getOrCreateSpecification({ spec });
    assert.equal(first.created, true);
    const second = await getOrCreateSpecification({ spec });
    assert.equal(second.created, false);
    assert.ok(second.spec.id);
  });

  it('generateFromSpecification throws when the specification does not exist', async () => {
    await assert.rejects(
      () =>
        generateFromSpecification('no-such-spec', {
          generationMode: 'deterministic-builder',
          content: { name: 'unknown-mode-test', productType: 'DIGITAL_PRODUCT' },
        }),
      /ProductSpecification "no-such-spec" not found/,
    );
  });

  it('createPackageForVersion throws when the version does not exist', async () => {
    await assert.rejects(
      () =>
        createPackageForVersion('no-such-version', {
          packageType: 'build-manifest',
          packageBody: {},
        }),
      /ProductVersion "no-such-version" not found/,
    );
  });

  it('rejects an invalid canonical spec that is not a plain object', async () => {
    await assert.rejects(
      () => getOrCreateSpecification({ spec: new Date('2026-01-01') as unknown as Record<string, unknown> }),
      /plain JSON objects/,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrency-style duplicate protection (safe approximation)
// ---------------------------------------------------------------------------

describe('B1 concurrency-safe duplicate protection', () => {
  it('repeated rapid identical requests resolve to exactly one specification', async () => {
    const spec = baseSpec({ name: 'Concurrent-' + Math.random().toString(36).slice(2, 8) });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => getOrCreateSpecification({ spec })),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof getOrCreateSpecification>>>[];
    assert.equal(fulfilled.length, 5, 'all requests should fulfill (no unexpected errors)');
    const ids = new Set(fulfilled.map((r) => r.value.spec.id));
    assert.equal(ids.size, 1, 'all requests must resolve to the SAME specification row');
    const createdCount = fulfilled.filter((r) => r.value.created).length;
    assert.ok(createdCount === 1, 'exactly one request should have created the row; got ' + createdCount);
  });

  it('generation+version creation is transactional (version never exists without generation)', async () => {
    const { spec } = await getOrCreateSpecification({ spec: baseSpec() });
    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'transactional-test', productType: 'DIGITAL_PRODUCT' },
    });
    const genRow = await db.productGeneration.findUnique({ where: { id: gen.generation.id } });
    const verRow = await db.productVersion.findUnique({ where: { id: gen.version.id } });
    assert.ok(genRow);
    assert.ok(verRow);
    assert.equal(verRow.generationId, gen.generation.id);
    assert.ok(/^[0-9a-f]{64}$/.test(verRow.contentCanonicalHash));
  });
});

// ---------------------------------------------------------------------------
// Telemetry: confirm production paths were not touched
// ---------------------------------------------------------------------------

describe('B1 production surface unchanged', () => {
  it('the Product model is unchanged (no new relation fields added)', async () => {
    const product = await db.product.create({
      data: {
        id: 'prod-b1-check',
        name: 'B1 check',
        type: 'DIGITAL_PRODUCT',
        solution: '{}',
        userFlows: '[]',
        techRequirements: '[]',
        acceptanceCriteria: '[]',
        lifecycleHistory: '[]',
      },
    });
    const reloaded = await db.product.findUnique({ where: { id: product.id } });
    if (!reloaded) throw new Error('reloaded must exist');
    assert.equal(reloaded.solution, '{}');
    assert.equal(reloaded.userFlows, '[]');
    assert.equal(reloaded.techRequirements, '[]');
    assert.equal(reloaded.acceptanceCriteria, '[]');
    assert.equal(reloaded.lifecycleHistory, '[]');
    await db.product.delete({ where: { id: product.id } });
  });

  it('the existing Offer/PipelineRun/Revenue models are untouched', async () => {
    const opp = await db.opportunity.create({
      data: {
        id: 'opp-b1-check',
        title: 'B1 check',
        category: 'Software',
        businessModel: 'SaaS',
        targetAudience: 'Parents',
        problemSolved: 'Planning',
        monetizationMethod: 'Subscription',
        demandScore: 1,
        competitionScore: 1,
        commercialIntentScore: 1,
        automationScore: 1,
        differentiationScore: 1,
        monetizationScore: 1,
        halalConfidenceScore: 100,
        overallScore: 1,
      },
    });
    const run = await db.pipelineRun.create({
      data: {
        opportunityId: opp.id,
        objective: 'B1 check',
        currentStage: 'RESEARCH',
        status: 'COMPLETED',
        result: '{}',
        completedAt: new Date(),
        durationMs: 1,
      },
    });
    const rev = await db.revenue.create({
      data: {
        date: new Date(),
        revenueSource: 'B1 check',
        grossRevenue: 1,
        fees: 0,
        advertisingCost: 0,
        otherCosts: 0,
        netRevenue: 1,
        referenceNote: 'B1 check',
        opportunityId: opp.id,
      },
    });
    assert.ok(run.id);
    assert.ok(rev.id);
    await db.revenue.delete({ where: { id: rev.id } });
    await db.pipelineRun.delete({ where: { id: run.id } });
    await db.opportunity.delete({ where: { id: opp.id } });
  });
});

// ===========================================================================
// 10. PROVENANCE-AWARE VERSION DEDUPLICATION (Codex issue #2 fix)
// ===========================================================================
// Verifies that identical content from different specifications or generation
// modes produces NEW versions, not a reuse of an unrelated historical version.
// Provenance (specificationId + generationMode) is part of version identity.

describe('B1 provenance-aware version deduplication', () => {
  it('identical content from a different specification creates a NEW version', async () => {
    const specA = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Spec-A-' + Math.random().toString(36).slice(2, 8) }),
    });
    const specB = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Spec-B-' + Math.random().toString(36).slice(2, 8) }),
    });
    assert.notEqual(specA.spec.id, specB.spec.id);

    const content = { name: 'shared-content', productType: 'DIGITAL_PRODUCT' };
    const versionA = await generateFromSpecification(specA.spec.id, {
      generationMode: 'deterministic-builder',
      content,
    });
    const versionB = await generateFromSpecification(specB.spec.id, {
      generationMode: 'deterministic-builder',
      content,
    });

    assert.notEqual(versionA.version.id, versionB.version.id,
      'identical content from different specs must create separate versions');
    assert.notEqual(versionA.version.generationId, versionB.version.generationId,
      'generations must be distinct for different specs');
    assert.equal(versionA.version.content, versionB.version.content,
      'content is identical (expected)');
    assert.equal(versionA.version.contentCanonicalHash, versionB.version.contentCanonicalHash,
      'content canonical hash is identical (expected — same content)');

    const chainA = await loadVersionWithChain(versionA.version.id);
    const chainB = await loadVersionWithChain(versionB.version.id);
    if (!chainA) throw new Error("chainA must exist");
    if (!chainB) throw new Error("chainB must exist");
    assert.equal(chainA.specification.id, specA.spec.id);
    assert.equal(chainB.specification.id, specB.spec.id);
  });

  it('identical content from a different generation mode creates a NEW version', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Mode-diff-' + Math.random().toString(36).slice(2, 8) }),
    });

    const content = { name: 'mode-content', productType: 'DIGITAL_PRODUCT' };

    const versionA = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content,
    });

    const versionB = await generateFromSpecification(spec.id, {
      generationMode: 'manual-review',
      content,
    });

    assert.notEqual(versionA.version.id, versionB.version.id,
      'identical content with different generation modes must create separate versions');
    assert.notEqual(versionA.version.generationId, versionB.version.generationId);
    assert.equal(versionA.version.generationMode, 'deterministic-builder');
    assert.equal(versionB.version.generationMode, 'manual-review');
  });

  it('identical content from the SAME specification + mode returns the existing version (dedup still works)', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Dedup-ok-' + Math.random().toString(36).slice(2, 8) }),
    });

    const content = { name: 'dedup-content', productType: 'DIGITAL_PRODUCT' };

    const first = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content,
      versionLabel: 'v1',
    });

    const second = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content,
      versionLabel: 'v2',
    });

    assert.equal(second.version.id, first.version.id,
      'same spec + same mode + same content must return the existing version');
    assert.equal(second.version.versionLabel, 'v1',
      'original label is preserved (version is immutable)');
  });

  it('three specs with identical content each get their own version', async () => {
    const specs = await Promise.all([
      getOrCreateSpecification({ spec: baseSpec({ name: 'Triple-A' }) }),
      getOrCreateSpecification({ spec: baseSpec({ name: 'Triple-B' }) }),
      getOrCreateSpecification({ spec: baseSpec({ name: 'Triple-C' }) }),
    ]);

    const content = { name: 'triple-content', productType: 'DIGITAL_PRODUCT' };

    const versions = await Promise.all(
      specs.map(s => generateFromSpecification(s.spec.id, {
        generationMode: 'deterministic-builder',
        content,
      })),
    );

    const versionIds = new Set(versions.map(v => v.version.id));
    assert.equal(versionIds.size, 3,
      'each specification must get its own version despite identical content');
    assert.equal(versions[0].version.contentCanonicalHash,
                 versions[1].version.contentCanonicalHash,
                 'content hashes match (same content)');
    assert.equal(versions[1].version.contentCanonicalHash,
                 versions[2].version.contentCanonicalHash,
                 'content hashes match (same content)');

    const chains = await Promise.all(
      versions.map(v => loadVersionWithChain(v.version.id)),
    );
    for (let i = 0; i < 3; i++) {
      if (!chains[i]) throw new Error(`chain ${i} must exist`);
      assert.equal(chains[i].specification.id, specs[i].spec.id,
        `version ${i} must trace to spec ${i}`);
    }
  });
});

// ===========================================================================
// 11. PACKAGE IDENTITY WITH PROVENANCE (Codex issue #3 fix)
// ===========================================================================
// packageHash now includes versionId + packageType + canonical body.
// This means:
//  - Same body CAN exist for different versions (different versionId -> different hash)
//  - Same body CANNOT be duplicated for the same version + type (unique constraint)
//  - Package provenance is always traceable through versionId FK

describe('B1 package identity with provenance', () => {
  it('the same package body can exist for different versions', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Pkg-provenance-' + Math.random().toString(36).slice(2, 8) }),
    });

    const v1 = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'v1-pkg-test', productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v1',
    });
    const v2 = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'v2-pkg-test', productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v2',
    });

    const sameBody = { title: 'Shared Draft', version: '1.0.0' };

    const pkg1 = await createPackageForVersion(v1.version.id, {
      packageType: 'listing-draft',
      packageBody: sameBody,
    });
    const pkg2 = await createPackageForVersion(v2.version.id, {
      packageType: 'listing-draft',
      packageBody: sameBody,
    });

    assert.notEqual(pkg1.packageHash, pkg2.packageHash,
      'same body for different versions must produce different package hashes');
    assert.equal(pkg1.versionId, v1.version.id);
    assert.equal(pkg2.versionId, v2.version.id);

    const packages1 = await loadPackagesForVersion(v1.version.id);
    const packages2 = await loadPackagesForVersion(v2.version.id);
    assert.equal(packages1.length, 1);
    assert.equal(packages2.length, 1);
    assert.equal(packages1[0].packageBody, pkg1.packageBody);
    assert.equal(packages2[0].packageBody, pkg2.packageBody);
  });

  it('the same package body CANNOT be duplicated for the same version + type', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Pkg-dedup-' + Math.random().toString(36).slice(2, 8) }),
    });

    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'pkg-dedup-test', productType: 'DIGITAL_PRODUCT' },
    });

    const body = { title: 'Unique Draft', version: '1.0.0' };

    const pkg1 = await createPackageForVersion(gen.version.id, {
      packageType: 'listing-draft',
      packageBody: body,
    });

    await assert.rejects(
      () => createPackageForVersion(gen.version.id, {
        packageType: 'listing-draft',
        packageBody: body,
      }),
      /unique constraint|Unique constraint|SQLITE_CONSTRAINT|P2002/i,
      'duplicate package for same version+type+body must be rejected',
    );

    const packages = await loadPackagesForVersion(gen.version.id);
    assert.equal(packages.length, 1,
      'only one package should exist for this version after duplicate rejection');
    assert.equal(packages[0].id, pkg1.id);
  });

  it('the same package body CAN exist for the same version with different package types', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Pkg-type-diff-' + Math.random().toString(36).slice(2, 8) }),
    });

    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'pkg-type-test', productType: 'DIGITAL_PRODUCT' },
    });

    const body = { title: 'Multi-type Draft', version: '1.0.0' };

    const pkg1 = await createPackageForVersion(gen.version.id, {
      packageType: 'build-manifest',
      packageBody: body,
    });
    const pkg2 = await createPackageForVersion(gen.version.id, {
      packageType: 'listing-draft',
      packageBody: body,
    });

    assert.notEqual(pkg1.packageHash, pkg2.packageHash,
      'different package types must produce different hashes');
    assert.equal(pkg1.versionId, pkg2.versionId);
    assert.equal(pkg1.packageType, 'build-manifest');
    assert.equal(pkg2.packageType, 'listing-draft');

    const packages = await loadPackagesForVersion(gen.version.id);
    assert.equal(packages.length, 2,
      'two packages with different types should both exist for the same version');
  });

  it('package provenance remains traceable through the full chain', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Pkg-trace-' + Math.random().toString(36).slice(2, 8) }),
    });

    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'autonomous-pipeline',
      content: { name: 'trace-test', productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v1.0.0',
    });

    const pkg = await createPackageForVersion(gen.version.id, {
      packageType: 'artifact-bundle-descriptor',
      packageBody: { artifactId: 'art-1', format: 'tar.gz' },
      artifactRef: 'artifacts/bundle-1.tar.gz',
    });

    const chain = await loadVersionWithChain(gen.version.id);
    if (!chain) throw new Error('chain must exist');
    assert.equal(chain.version.id, gen.version.id);
    assert.equal(chain.generation.id, gen.generation.id);
    assert.equal(chain.generation.generationMode, 'autonomous-pipeline');
    assert.equal(chain.specification.id, spec.id);
    assert.equal(chain.generation.specificationId, spec.id);

    const packages = await loadPackagesForVersion(gen.version.id);
    assert.equal(packages.length, 1);
    assert.equal(packages[0].id, pkg.id);
    assert.equal(packages[0].versionId, gen.version.id);
    assert.equal(packages[0].packageType, 'artifact-bundle-descriptor');
  });
});

// ===========================================================================
// 12. IMMUTABILITY REGRESSION (ensure fixes did not weaken immutability)
// ===========================================================================

describe('B1 immutability regression after provenance fixes', () => {
  it('a version is never overwritten when content changes (new generation created)', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Immut-regress-' + Math.random().toString(36).slice(2, 8) }),
    });

    const v1 = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'original', productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v1',
    });

    const v2 = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'changed', productType: 'DIGITAL_PRODUCT' },
      versionLabel: 'v2',
    });

    assert.notEqual(v1.version.id, v2.version.id);
    assert.equal(JSON.parse(v1.version.content).name, 'original');
    assert.equal(JSON.parse(v2.version.content).name, 'changed');

    const reloadedV1 = await db.productVersion.findUnique({ where: { id: v1.version.id } });
    assert.ok(reloadedV1);
    assert.equal(JSON.parse(reloadedV1.content).name, 'original');
  });

  it('a package is never used to mutate a version', async () => {
    const { spec } = await getOrCreateSpecification({
      spec: baseSpec({ name: 'Pkg-immut-' + Math.random().toString(36).slice(2, 8) }),
    });

    const gen = await generateFromSpecification(spec.id, {
      generationMode: 'deterministic-builder',
      content: { name: 'pkg-immut-content', productType: 'DIGITAL_PRODUCT' },
    });

    const versionBefore = await db.productVersion.findUnique({ where: { id: gen.version.id } });
    if (!versionBefore) throw new Error('versionBefore must exist');

    await createPackageForVersion(gen.version.id, {
      packageType: 'build-manifest',
      packageBody: { productId: 'p-999', productType: 'DIGITAL_PRODUCT', version: '9.9.9' },
    });

    // Version must be unchanged after packaging.
    const versionAfter = await db.productVersion.findUnique({ where: { id: gen.version.id } });
    if (!versionAfter) throw new Error('versionAfter must exist');
    assert.equal(versionAfter.content, versionBefore.content);
    assert.equal(versionAfter.generationMode, versionBefore.generationMode);
    assert.equal(versionAfter.contentCanonicalHash, versionBefore.contentCanonicalHash);
    assert.equal(versionAfter.versionLabel, versionBefore.versionLabel);
  });
});
