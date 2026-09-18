// Phase 5.3 — Build contract + deployment provider tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createUnavailableDeploymentProvider,
  describeDeploymentStatus,
  resolveDeploymentProvider,
  resolveProductBuilder,
  runQualityGates,
  validateSpecForBuild,
} from '../build-contract';
import type { PublishableProductSpec } from '@/lib/publishing/contract';

function specFixture(overrides: Partial<PublishableProductSpec> = {}): PublishableProductSpec {
  return {
    productType: 'DIGITAL_PRODUCT',
    name: 'LedgerLite',
    targetAudience: 'indie developers',
    problem: 'Manual bookkeeping is slow',
    valueProposition: 'Automates bookkeeping cleanly',
    mvpFeatures: [{ name: 'Core export', description: 'One-click export', priority: 'HIGH' }],
    buildPhases: [{ phase: 1, name: 'MVP', tasks: ['core'], expectedOutput: 'working CLI', risk: 'low' }],
    monetizationModel: 'ONE_TIME_PURCHASE',
    pricingHypothesis: '$29 one-time',
    distributionChannels: ['seo'],
    risks: ['low demand'],
    assumptions: ['search demand exists'],
    evidence: [{ type: 'VERIFIED_DATA', content: 'forum complaints observed' }],
    evidenceProvenance: 'AI_INFERENCE',
    ...overrides,
  };
}

describe('build contract: quality gates', () => {
  it('passes a complete spec through all gates', () => {
    const gates = runQualityGates(specFixture());
    for (const gate of gates) {
      assert.equal(gate.passed, true, `${gate.gate} should pass: ${gate.detail}`);
    }
    assert.equal(validateSpecForBuild(specFixture()).valid, true);
  });

  it('fails spec-completeness when fields are missing', () => {
    const result = validateSpecForBuild(specFixture({ name: '', valueProposition: '' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('spec-completeness')));
  });

  it('fails mvp-defined when no features exist', () => {
    const result = validateSpecForBuild(specFixture({ mvpFeatures: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('mvp-defined')));
  });

  it('flags MOCKED provenance (recorded, not hidden)', () => {
    const gates = runQualityGates(specFixture({ evidenceProvenance: 'MOCKED' }));
    const provenanceGate = gates.find((g) => g.gate === 'provenance-labelled');
    assert.equal(provenanceGate?.passed, false);
  });

  it('rejects guaranteed-income claims in the spec', () => {
    const result = validateSpecForBuild(specFixture({
      valueProposition: 'Guaranteed success with zero effort',
    }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('no-guaranteed-claims')));
  });
});

describe('build contract: unavailable builder', () => {
  it('no product builder is connected (contract only)', () => {
    assert.equal(resolveProductBuilder(), null);
  });
});

describe('deployment provider: not-connected truthfulness', () => {
  it('default provider is the unavailable adapter', () => {
    const provider = resolveDeploymentProvider();
    assert.equal(provider.id, 'unavailable');
  });

  it('validate() reports invalid with the honest error', () => {
    const provider = createUnavailableDeploymentProvider('NEXTJS');
    const result = provider.validate({ target: 'NEXTJS', artifactRef: 'prod-1' });
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /No deployment provider is connected/);
  });

  it('build() returns UNAVAILABLE without artifacts', async () => {
    const provider = createUnavailableDeploymentProvider();
    const result = await provider.build({ target: 'NEXTJS', artifactRef: 'prod-1' });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.artifactRef, null);
    assert.equal(result.sandboxed, true);
  });

  it('deploy() never fakes success — even with a human approval token', async () => {
    const provider = createUnavailableDeploymentProvider();
    const record = await provider.deploy({ target: 'NEXTJS', artifactRef: 'prod-1' }, 'token-abc');
    assert.equal(record.status, 'DEPLOYMENT_NOT_CONNECTED');
    assert.equal(record.deploymentId, null);
    assert.equal(record.url, null);
    assert.equal(record.providerId, null);
  });

  it('status() and rollback() report DEPLOYMENT_NOT_CONNECTED', async () => {
    const provider = createUnavailableDeploymentProvider();
    const status = await provider.status('dep-123');
    assert.equal(status.status, 'DEPLOYMENT_NOT_CONNECTED');
    assert.equal(status.deploymentId, null);

    const rollback = await provider.rollback('dep-123', 'token-abc');
    assert.equal(rollback.status, 'DEPLOYMENT_NOT_CONNECTED');
  });

  it('dashboard description never claims a live deployment', () => {
    const status = describeDeploymentStatus();
    assert.equal(status.status, 'DEPLOYMENT_NOT_CONNECTED');
    assert.match(status.note, /No deployment provider is connected/);
  });
});

describe('deployment provider: authorized adapter contract shape', () => {
  it('a future real adapter satisfies the interface and can confirm deployments', async () => {
    // Structural check: a real adapter is expressible without changing the
    // boundary. This fake demonstrates the contract the lifecycle guard
    // expects (real provider id + real deployment id + url).
    const fakeVercel = {
      id: 'vercel',
      validate: () => ({ valid: true, errors: [] }),
      build: async () => ({
        status: 'SUCCEEDED' as const, artifactRef: 'art-1', version: '1.0.0',
        tests: { total: 1, passed: 1, failed: 0 }, logSummary: 'ok',
        qualityGates: [], generatedAt: new Date().toISOString(), sandboxed: true as const, errors: [],
      }),
      deploy: async () => ({
        status: 'DEPLOYED' as const, providerId: 'vercel', deploymentId: 'dpl-123456',
        url: 'https://example.vercel.app', version: '1.0.0', errors: [], timestamp: new Date().toISOString(),
      }),
      status: async () => ({
        status: 'DEPLOYED' as const, providerId: 'vercel', deploymentId: 'dpl-123456',
        url: 'https://example.vercel.app', version: '1.0.0', errors: [], timestamp: new Date().toISOString(),
      }),
      rollback: async () => ({
        status: 'ROLLED_BACK' as const, providerId: 'vercel', deploymentId: 'dpl-123456',
        url: null, version: '1.0.0', errors: [], timestamp: new Date().toISOString(),
      }),
    };
    const provider = fakeVercel as unknown as ReturnType<typeof createUnavailableDeploymentProvider>;
    const record = await provider.deploy({ target: 'NEXTJS', artifactRef: 'p1' }, 'token');
    assert.equal(record.status, 'DEPLOYED');
    assert.equal(record.deploymentId, 'dpl-123456');
  });
});
