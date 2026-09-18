// Phase 5 — Publishing contract tests (truthfulness: nothing publishes).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  describePublishingStatus,
  requestPublishing,
  resolvePublishingProvider,
  toPublishableSpec,
  validateSpecLocally,
  type PublishableProductSpec,
} from '../contract';
import type { ProductResult } from '@/lib/agents/types';

function specFixture(overrides: Partial<PublishableProductSpec> = {}): PublishableProductSpec {
  return {
    productType: 'DIGITAL_PRODUCT',
    name: 'Test Product',
    targetAudience: 'indie developers',
    problem: 'Manual bookkeeping is slow',
    valueProposition: 'Automates it',
    mvpFeatures: [{ name: 'Core export', description: 'One-click export', priority: 'HIGH' }],
    buildPhases: [{ phase: 1, name: 'MVP', tasks: ['core'], expectedOutput: 'working CLI', risk: 'low' }],
    monetizationModel: 'ONE_TIME',
    pricingHypothesis: '$29 one-time',
    distributionChannels: ['seo'],
    risks: ['low demand'],
    assumptions: ['search demand exists'],
    evidence: [{ type: 'VERIFIED_DATA', content: 'forum complaints observed' }],
    evidenceProvenance: 'VERIFIED_DATA',
    ...overrides,
  };
}

function productResultFixture(): ProductResult {
  return {
    productType: 'DIGITAL_PRODUCT',
    productConcept: {
      productNameHypothesis: 'LedgerLite',
      positioning: 'simple',
      differentiation: 'fast',
    },
    targetCustomer: 'indie developers',
    problemBeingSolved: 'Manual bookkeeping is slow',
    valueProposition: 'Automates it',
    mvpFeatures: [{ name: 'Core export', description: 'One-click export', priority: 'HIGH' }],
    buildPhases: [{ phase: 1, name: 'MVP', tasks: ['core'], expectedOutput: 'working CLI', risk: 'low' }],
    monetizationModel: 'ONE_TIME',
    pricingHypothesis: '$29 one-time',
    distributionChannels: ['seo'],
    risks: ['low demand'],
    assumptions: ['search demand exists'],
    evidence: [{ type: 'VERIFIED_DATA', content: 'forum complaints observed' }],
    capabilityStatus: 'LIVE',
  } as unknown as ProductResult;
}

describe('publishing boundary: unavailable provider truthfulness', () => {
  it('no provider is registered — resolvePublishingProvider returns null', () => {
    for (const channel of describePublishingStatus().channels) {
      assert.equal(resolvePublishingProvider(channel), null);
    }
  });

  it('requestPublishing without a provider returns PUBLISHING_UNAVAILABLE and nothing is published', () => {
    const response = requestPublishing({ channel: 'DIGITAL_PRODUCT', spec: specFixture() });
    assert.equal(response.status, 'PUBLISHING_UNAVAILABLE');
    assert.equal(response.providerId, null);
    assert.equal(response.draft, null);
    assert.equal(response.publication, null);
    assert.match(response.errors[0], /No publishing provider is connected/);
  });

  it('status description never claims LIVE publication', () => {
    const status = describePublishingStatus();
    assert.equal(status.status, 'PUBLISHING_UNAVAILABLE');
    assert.match(status.note, /No publishing provider is connected/);
    assert.ok(status.note.includes('human approval'));
  });

  it('invalid spec with no provider: unavailable, no draft, validation warnings surfaced', () => {
    const response = requestPublishing({
      channel: 'DIGITAL_PRODUCT',
      spec: specFixture({ name: '', mvpFeatures: [] }),
    });
    assert.equal(response.status, 'PUBLISHING_UNAVAILABLE');
    assert.equal(response.draft, null);
    assert.equal(response.publication, null);
    // The provider gap is the blocking error; local validation problems still surface.
    assert.match(response.errors[0], /No publishing provider is connected/);
    assert.ok(response.errors.some((e) => /Product name is required/.test(e)));
    assert.ok(response.errors.some((e) => /MVP feature is required/.test(e)));
  });

  it('structural validation flags MOCKED provenance and missing VERIFIED_DATA', () => {
    const result = validateSpecLocally(
      specFixture({ evidenceProvenance: 'MOCKED', evidence: [{ type: 'AI_INFERENCE', content: 'guess' }] }),
    );
    assert.ok(result.valid);
    assert.ok(result.warnings.some((w) => /MOCKED/.test(w)));
    assert.ok(result.warnings.some((w) => /VERIFIED_DATA/.test(w)));
  });

  it('a valid spec passes local validation cleanly', () => {
    const result = validateSpecLocally(specFixture());
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

describe('publishing boundary: human approval gate', () => {
  it('local validation is deterministic and independent of any provider', () => {
    const a = validateSpecLocally(specFixture());
    const b = validateSpecLocally(specFixture());
    assert.deepEqual(a, b);
  });

  it('toPublishableSpec preserves provenance and never upgrades it', () => {
    const spec = toPublishableSpec(productResultFixture());
    assert.equal(spec.name, 'LedgerLite');
    assert.equal(spec.evidenceProvenance, 'AI_INFERENCE');
    assert.equal(spec.mvpFeatures.length, 1);
    assert.equal(spec.buildPhases[0].name, 'MVP');
    // AI inference from a live-capable agent stays AI_INFERENCE — never VERIFIED_DATA.
    assert.notEqual(spec.evidenceProvenance, 'VERIFIED_DATA');
  });

  it('toPublishableSpec marks mocked agent output as MOCKED', () => {
    const mocked = { ...productResultFixture(), capabilityStatus: 'MOCK' };
    const spec = toPublishableSpec(mocked as ProductResult);
    assert.equal(spec.evidenceProvenance, 'MOCKED');
  });
});
