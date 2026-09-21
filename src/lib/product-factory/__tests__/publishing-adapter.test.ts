// Phase 5.4 — Publishing adapter foundation tests: halal gates, asset rights,
// claim guards, approval boundary, honest NOT_CONNECTED statuses.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createListing,
  evaluateAssetRights,
  getListingStatus,
  publishListing,
  scanListingClaims,
  updateListing,
  validateListing,
  type ListingContent,
} from '../publishing-adapter';
import type { PublishableProductSpec } from '@/lib/publishing/contract';

function spec(): PublishableProductSpec {
  return {
    productType: 'DIGITAL_PRODUCT',
    name: 'Weekly Meal Planner',
    targetAudience: 'Busy parents',
    problem: 'Planning meals is time-consuming',
    valueProposition: 'Plan a week of meals in minutes',
    mvpFeatures: [{ name: 'Planner', description: 'Weekly meal plan generator', priority: 'P0' }],
    buildPhases: [{ phase: 1, name: 'Core', tasks: ['Build planner'], expectedOutput: 'Planner', risk: 'Low' }],
    monetizationModel: 'ONE_TIME_PURCHASE',
    pricingHypothesis: 'To be tested',
    distributionChannels: ['Direct website'],
    risks: [],
    assumptions: [],
    evidence: [{ type: 'VERIFIED_DATA', content: 'recorded validation' }],
    evidenceProvenance: 'AI_INFERENCE',
  };
}

function content(overrides: Partial<ListingContent> = {}): ListingContent {
  return {
    title: 'Weekly Meal Planner',
    description: 'A simple planner for busy parents.',
    featureList: ['Weekly plan generator'],
    faq: [{ question: 'Is this a subscription?', answer: 'No, it is a one-time purchase.' }],
    seoDraft: { title: 'Weekly Meal Planner', description: 'Simple meal planning', keywords: ['meal planner'] },
    metadata: { productType: 'DIGITAL_PRODUCT', monetizationModel: 'ONE_TIME_PURCHASE', channels: 'DIRECT', version: '1' } as unknown as ListingContent['metadata'],
    contentProvenance: 'AI_GENERATED',
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof validateListing>[0]> = {}) {
  return {
    channel: 'DIGITAL_PRODUCT' as const,
    spec: spec(),
    content: content(),
    assets: [{ assetId: 'a1', rightsStatus: 'OWNED' as const, publicationStatus: 'PUBLISHABLE' }],
    halalStatus: 'HALAL' as const,
    ...overrides,
  };
}

describe('claim guards', () => {
  it('flags guaranteed-income language deterministically', () => {
    const findings = scanListingClaims('Earn $5000 per month guaranteed!');
    assert.ok(findings.length >= 2);
  });

  it('flags fabricated social proof', () => {
    const findings = scanListingClaims('Trusted by 5000 happy customers with 5 stars!');
    assert.ok(findings.length >= 1);
  });

  it('allows honest copy with no findings', () => {
    assert.deepEqual(scanListingClaims('A weekly planner for busy parents.'), []);
  });

  it('blocks listing creation on claims and reports BLOCKED_CLAIMS', () => {
    const result = validateListing(input({
      content: content({ description: 'Guaranteed income from day one!' }),
    }));
    assert.equal(result.status, 'BLOCKED_CLAIMS');
    assert.ok(result.claimFindings.length > 0);
  });
});

describe('asset rights gate', () => {
  it('blocks BLOCKED/UNCLEAR/HUMAN_REVIEW assets', () => {
    assert.equal(evaluateAssetRights([{ assetId: 'a', rightsStatus: 'BLOCKED', publicationStatus: 'NOT_PUBLISHABLE' }]).allowed, false);
    assert.equal(evaluateAssetRights([{ assetId: 'a', rightsStatus: 'UNCLEAR', publicationStatus: 'HUMAN_REVIEW' }]).allowed, false);
    assert.equal(evaluateAssetRights([{ assetId: 'a', rightsStatus: 'OWNED', publicationStatus: 'PUBLISHABLE' }]).allowed, true);
  });

  it('BLOCKED_RIGHTS stops listing creation before any draft', () => {
    const result = validateListing(input({
      assets: [{ assetId: 'a2', rightsStatus: 'UNCLEAR', publicationStatus: 'HUMAN_REVIEW' }],
    }));
    assert.equal(result.status, 'BLOCKED_RIGHTS');
  });
});

describe('halal gates', () => {
  it('NOT_ALLOWED blocks everything with BLOCKED_HALAL', async () => {
    const validation = validateListing(input({ halalStatus: 'NOT_ALLOWED' }));
    assert.equal(validation.status, 'BLOCKED_HALAL');

    const published = await publishListing(input({ halalStatus: 'NOT_ALLOWED', humanApprovalToken: 'tok' }));
    assert.equal(published.status, 'BLOCKED_HALAL');
  });

  it('REVIEW_REQUIRED requires a human before any listing proceeds', async () => {
    const validation = validateListing(input({ halalStatus: 'REVIEW_REQUIRED' }));
    assert.equal(validation.status, 'BLOCKED_HALAL');
    assert.ok(validation.errors[0].match(/human must review/i));
  });
});

describe('draft + publish boundary', () => {
  it('createListing produces a review-required draft, never a live listing', () => {
    const result = createListing(input());
    assert.equal(result.status, 'DRAFT_CREATED');
    assert.ok(result.draft);
    assert.equal(result.draft?.requiresHumanReview, true);
    assert.equal(result.listingId, null);
    assert.equal(result.draft?.provenance, 'AI_GENERATED');
  });

  it('updateListing applies the same gates', () => {
    const result = updateListing(input({ halalStatus: 'REVIEW_REQUIRED' }));
    assert.equal(result.status, 'BLOCKED_HALAL');
  });

  it('publishListing without approval reports NOT_AUTHORIZED', async () => {
    const result = await publishListing(input());
    assert.equal(result.status, 'NOT_AUTHORIZED');
    assert.equal(result.listingId, null);
    assert.match(result.errors.join(' '), /approval/i);
  });

  it('publishListing with approval still cannot publish without an adapter', async () => {
    const result = await publishListing(input({ humanApprovalToken: 'human-decision-token' }));
    assert.equal(result.status, 'PUBLISHING_UNAVAILABLE');
    assert.equal(result.listingId, null);
  });

  it('getListingStatus honestly reports NOT_CONNECTED', async () => {
    const status = await getListingStatus('DIGITAL_PRODUCT', 'ref-1');
    assert.equal(status.status, 'NOT_CONNECTED');
    assert.match(status.hint, /no publishing provider is connected/i);
  });
});
