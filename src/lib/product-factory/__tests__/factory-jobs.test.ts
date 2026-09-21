// Phase 5.3 — Factory job execution tests (hermetic via injected DB fakes).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeFactoryJob, mapFactoryOutcomeToStatus, __setFactoryDbForTests } from '../factory-jobs';
import type { PublishableProductSpec } from '@/lib/publishing/contract';
import type { FactoryDbSurface, ProductRecord } from '../factory-jobs';

// factory-jobs loads the product through its own module-level db surface. To
// stay hermetic, tests inject a fake DB surface via the exported seam.

const SPEC_JSON = JSON.stringify({
  problem: 'Manual bookkeeping is slow',
  valueProposition: 'Automates bookkeeping cleanly',
  mvpFeatures: [{ name: 'Core export', description: 'One-click export', priority: 'HIGH' }],
  buildPhases: [{ phase: 1, name: 'MVP', tasks: ['core'], expectedOutput: 'CLI', risk: 'low' }],
  distributionChannels: ['seo'],
  monetizationModel: 'ONE_TIME_PURCHASE',
  pricingHypothesis: '$29',
  risks: ['low demand'],
  assumptions: ['search demand exists'],
  evidence: [{ type: 'VERIFIED_DATA', content: 'forum complaints' }],
  evidenceProvenance: 'AI_INFERENCE',
} satisfies Partial<PublishableProductSpec>);

function fakeProduct(overrides: Record<string, unknown> = {}): ProductRecord {
  return {
    id: 'prod-1',
    status: 'VALIDATED',
    name: 'LedgerLite',
    type: 'DIGITAL_PRODUCT',
    targetAudience: 'indie developers',
    notes: SPEC_JSON,
    opportunityId: 'opp-1',
    lifecycleHistory: '[]',
    opportunity: { halalStatus: 'HALAL' },
    ...overrides,
  } as ProductRecord;
}

/** Install a hermetic fake DB surface for the duration of a test. */
function withFakeDb(product: ProductRecord | null, revenueRows: unknown[] = []): void {
  __setFactoryDbForTests({
    product: {
      findUnique: async () => product,
      update: async () => ({}),
    },
    revenue: {
      findMany: async () => revenueRows as never,
    },
  } as unknown as FactoryDbSurface);
}

// Every test sets the seam; reset after the suite.
process.on('exit', () => __setFactoryDbForTests(null));

// Default seam for all tests in this file.
withFakeDb(fakeProduct());

describe('factory jobs: input validation and gates', () => {
  it('rejects a missing productId', async () => {
    const outcome = await executeFactoryJob('PRODUCT_TEST', {});
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /productId is required/);
  });

  it('fails when the product does not exist', async () => {
    withFakeDb(null);
    const outcome = await executeFactoryJob('PRODUCT_TEST', { productId: 'ghost' });
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /not found/);
    withFakeDb(fakeProduct());
  });

  it('blocks every factory action for NOT_ALLOWED opportunities (no provider calls)', async () => {
    withFakeDb(fakeProduct({ opportunity: { halalStatus: 'NOT_ALLOWED' } }));
    const outcome = await executeFactoryJob('PRODUCT_PUBLISH', {
      productId: 'prod-1',
      humanApprovalToken: 'token',
    });
    assert.equal(outcome.status, 'BLOCKED');
    assert.match(outcome.error ?? '', /NOT_ALLOWED/);
    withFakeDb(fakeProduct());
  });

  it('routes REVIEW_REQUIRED to HUMAN_REVIEW before any factory work', async () => {
    withFakeDb(fakeProduct({ opportunity: { halalStatus: 'REVIEW_REQUIRED' } }));
    const outcome = await executeFactoryJob('PRODUCT_TEST', { productId: 'prod-1' });
    assert.equal(outcome.status, 'HUMAN_REVIEW');
    withFakeDb(fakeProduct());
  });

  it('maps halal BLOCKED above everything else in the status mapper', () => {
    assert.equal(
      mapFactoryOutcomeToStatus({ status: 'SUCCEEDED', summary: null }, true),
      'BLOCKED',
    );
    assert.equal(
      mapFactoryOutcomeToStatus({ status: 'DEGRADED', summary: null }, false),
      'DEGRADED',
    );
  });
});

describe('factory jobs: PRODUCT_TEST quality gates', () => {
  it('passes a complete spec through all gates', async () => {
    const outcome = await executeFactoryJob('PRODUCT_TEST', { productId: 'prod-1' });
    assert.equal(outcome.status, 'SUCCEEDED');
    const summary = outcome.summary as { passed: number; total: number };
    assert.equal(summary.passed, summary.total);
  });
});

describe('factory jobs: approval gates for high-impact actions', () => {
  it('PRODUCT_DEPLOY without a token returns HUMAN_REVIEW and deploys nothing', async () => {
    const outcome = await executeFactoryJob('PRODUCT_DEPLOY', { productId: 'prod-1' });
    assert.equal(outcome.status, 'HUMAN_REVIEW');
    const summary = outcome.summary as { message: string };
    assert.match(summary.message, /human approval token/i);
  });

  it('PRODUCT_PUBLISH without a token returns HUMAN_REVIEW and publishes nothing', async () => {
    const outcome = await executeFactoryJob('PRODUCT_PUBLISH', { productId: 'prod-1' });
    assert.equal(outcome.status, 'HUMAN_REVIEW');
  });

  it('PRODUCT_DEPLOY with a token but no provider stays DEGRADED (NOT_CONNECTED)', async () => {
    const outcome = await executeFactoryJob('PRODUCT_DEPLOY', {
      productId: 'prod-1',
      humanApprovalToken: 'token-abc',
    });
    assert.equal(outcome.status, 'DEGRADED');
    const summary = outcome.summary as { deployment: { status: string; deploymentId: string | null } };
    assert.equal(summary.deployment.status, 'DEPLOYMENT_NOT_CONNECTED');
    assert.equal(summary.deployment.deploymentId, null);
  });

  it('PRODUCT_PUBLISH with a token but no provider stays DEGRADED (PUBLISHING_UNAVAILABLE)', async () => {
    const outcome = await executeFactoryJob('PRODUCT_PUBLISH', {
      productId: 'prod-1',
      humanApprovalToken: 'token-abc',
    });
    assert.equal(outcome.status, 'DEGRADED');
    const summary = outcome.summary as { publishing: { status: string; published: boolean } };
    assert.equal(summary.publishing.status, 'PUBLISHING_UNAVAILABLE');
    assert.equal(summary.publishing.published, false);
  });

  it('PRODUCT_BUILD with no builder is honest DEGRADED (UNAVAILABLE)', async () => {
    const outcome = await executeFactoryJob('PRODUCT_BUILD', { productId: 'prod-1' });
    assert.equal(outcome.status, 'DEGRADED');
    const summary = outcome.summary as { buildStatus: string };
    assert.equal(summary.buildStatus, 'UNAVAILABLE');
  });

  it('unknown factory job type fails loudly', async () => {
    const outcome = await executeFactoryJob('NOT_A_JOB', { productId: 'prod-1' });
    assert.equal(outcome.status, 'FAILED');
  });
});
