// Phase 5.3 — Listing factory + asset registry + revenue/economics tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createListingDraft, findUnsupportedClaims, registerAsset } from '../listing-factory';
import {
  attributeRevenueRow,
  computeProductEconomics,
  revenueIdempotencyKey,
  type AttributableRevenueRow,
} from '../economics';
import type { PublishableProductSpec } from '@/lib/publishing/contract';

function specFixture(overrides: Partial<PublishableProductSpec> = {}): PublishableProductSpec {
  return {
    productType: 'DIGITAL_PRODUCT',
    name: 'LedgerLite',
    targetAudience: 'indie developers',
    problem: 'Manual bookkeeping is slow',
    valueProposition: 'Automates bookkeeping cleanly',
    mvpFeatures: [
      { name: 'Core export', description: 'One-click CSV export of all records', priority: 'HIGH' },
      { name: 'Categories', description: 'Auto-categorize expenses', priority: 'MEDIUM' },
    ],
    buildPhases: [{ phase: 1, name: 'MVP', tasks: ['core'], expectedOutput: 'CLI', risk: 'low' }],
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

describe('listing factory: draft assembly', () => {
  it('produces a complete AI_GENERATED draft with human review required', () => {
    const draft = createListingDraft(specFixture(), { seoKeywords: ['bookkeeping', 'csv'] });
    assert.equal(draft.provenance, 'AI_GENERATED');
    assert.equal(draft.requiresHumanReview, true);
    assert.ok(draft.title.length > 0);
    assert.ok(draft.description.includes('Problem:'));
    assert.equal(draft.featureList.length, 2);
    assert.ok(draft.faq.length > 0);
    assert.deepEqual(draft.seoDraft.keywords, ['bookkeeping', 'csv']);
    assert.equal(draft.rightsMetadata.copyrightStatus, 'ORIGINAL_AI_GENERATED');
    assert.equal(draft.rightsMetadata.reviewedBy, null);
  });

  it('flags trademark risk for well-known brand names', () => {
    const draft = createListingDraft(specFixture({ name: 'NotionBackup Pro' }));
    assert.equal(draft.rightsMetadata.trademarkRisk, 'REVIEW_REQUIRED');
  });

  it('keeps MOCKED provenance visible as a warning', () => {
    const draft = createListingDraft(specFixture({ evidenceProvenance: 'MOCKED' }));
    assert.ok(draft.warnings.some((w) => /MOCKED/.test(w)));
  });

  it('bounds long fields', () => {
    const draft = createListingDraft(specFixture({
      valueProposition: 'x'.repeat(5000),
    }));
    assert.ok(draft.description.length <= 2000);
    assert.ok(draft.seoDraft.description.length <= 155);
  });
});

describe('listing factory: unsupported claim guard', () => {
  it('detects guaranteed outcomes, invented customers, and fake testimonials', () => {
    assert.ok(findUnsupportedClaims('results are guaranteed').includes('no guaranteed outcomes'));
    assert.ok(findUnsupportedClaims('join 5000 customers').some((r) => /customer counts/.test(r)));
    assert.ok(findUnsupportedClaims('95% conversion rate').some((r) => /conversion/.test(r)));
    assert.ok(findUnsupportedClaims('see these testimonials').some((r) => /testimonial/.test(r)));
    assert.ok(findUnsupportedClaims('completely risk-free').some((r) => /risk-free/.test(r)));
    assert.ok(findUnsupportedClaims('earn $1000 per day').some((r) => /earnings/.test(r)));
  });

  it('clean copy passes without violations', () => {
    assert.deepEqual(findUnsupportedClaims('Automates bookkeeping cleanly for solo developers'), []);
  });
});

describe('asset registry: provenance and rights', () => {
  it('generated assets are OWNED and publishable', () => {
    const asset = registerAsset({
      assetId: 'a1', productId: 'p1', type: 'PRODUCT_IMAGE', source: 'GENERATED',
      provenance: 'AI_GENERATED', rightsStatus: 'OWNED', createdAt: new Date().toISOString(),
    });
    assert.equal(asset.rightsStatus, 'OWNED');
    assert.equal(asset.publicationStatus, 'PUBLISHABLE');
  });

  it('manual uploads are CLEAR and publishable', () => {
    const asset = registerAsset({
      assetId: 'a2', productId: 'p1', type: 'SCREENSHOT', source: 'MANUAL_UPLOAD',
      provenance: 'USER_ENTERED', rightsStatus: 'CLEAR', createdAt: new Date().toISOString(),
    });
    assert.equal(asset.publicationStatus, 'PUBLISHABLE');
  });

  it('third-party assets without origin are blocked from publication', () => {
    const asset = registerAsset({
      assetId: 'a3', productId: 'p1', type: 'THUMBNAIL', source: 'THIRD_PARTY',
      provenance: 'VERIFIED_DATA', rightsStatus: 'UNCLEAR', createdAt: new Date().toISOString(),
    });
    assert.equal(asset.rightsStatus, 'HUMAN_REVIEW');
    assert.equal(asset.publicationStatus, 'NOT_PUBLISHABLE');
  });

  it('third-party assets with origin go to HUMAN_REVIEW (never auto-publishable)', () => {
    const asset = registerAsset({
      assetId: 'a4', productId: 'p1', type: 'LISTING_GRAPHIC', source: 'THIRD_PARTY',
      provenance: 'VERIFIED_DATA', rightsStatus: 'UNCLEAR', origin: 'https://example.com/image.png',
      createdAt: new Date().toISOString(),
    });
    assert.equal(asset.rightsStatus, 'UNCLEAR');
    assert.equal(asset.publicationStatus, 'HUMAN_REVIEW');
  });

  it('never copies copyrighted assets silently — UNCLEAR rights cannot be PUBLISHABLE', () => {
    for (const source of ['GENERATED', 'MANUAL_UPLOAD', 'THIRD_PARTY'] as const) {
      const withUnclear = registerAsset({
        assetId: `x-${source}`, productId: 'p1', type: 'PREVIEW', source,
        provenance: 'AI_GENERATED', rightsStatus: 'UNCLEAR', origin: 'somewhere',
        createdAt: new Date().toISOString(),
      });
      if (withUnclear.rightsStatus === 'UNCLEAR' || withUnclear.rightsStatus === 'HUMAN_REVIEW') {
        assert.notEqual(withUnclear.publicationStatus, 'PUBLISHABLE');
      }
    }
  });
});

describe('revenue attribution', () => {
  function row(overrides: Partial<AttributableRevenueRow> = {}): AttributableRevenueRow {
    return {
      id: 'r1', date: new Date('2026-01-15'), revenueSource: 'GUMROAD',
      grossRevenue: 100, fees: 5, netRevenue: 95,
      productId: null, opportunityId: null, referenceNote: null,
      ...overrides,
    };
  }

  it('attributes to PRODUCT when productId exists', () => {
    const a = attributeRevenueRow(row({ productId: 'p1' }));
    assert.equal(a.source, 'PRODUCT');
    assert.equal(a.refId, 'p1');
    assert.equal(a.evidenceType, 'VERIFIED');
    assert.equal(a.grossRevenue, 100);
    assert.equal(a.netRevenue, 95);
  });

  it('attributes to OPPORTUNITY when only opportunityId exists', () => {
    const a = attributeRevenueRow(row({ opportunityId: 'o1' }));
    assert.equal(a.source, 'OPPORTUNITY');
  });

  it('attributes to CAMPAIGN from a named source with no links', () => {
    const a = attributeRevenueRow(row({ revenueSource: 'Newsletter blast' }));
    assert.equal(a.source, 'CAMPAIGN');
    assert.equal(a.refId, 'Newsletter blast');
  });

  it('reports UNKNOWN_SOURCE instead of inventing attribution', () => {
    const a = attributeRevenueRow(row({ revenueSource: '' }));
    assert.equal(a.source, 'UNKNOWN_SOURCE');
    assert.equal(a.refId, null);

    const a2 = attributeRevenueRow(row({ revenueSource: 'unknown' }));
    assert.equal(a2.source, 'UNKNOWN_SOURCE');
  });

  it('builds deterministic idempotency keys (duplicate prevention)', () => {
    const input = { date: '2026-01-15', revenueSource: 'Gumroad', grossRevenue: 100, productId: 'p1' };
    const k1 = revenueIdempotencyKey(input);
    const k2 = revenueIdempotencyKey({ ...input, revenueSource: 'gumroad' });
    assert.equal(k1, k2, 'case differences must not create duplicates');
    assert.notEqual(k1, revenueIdempotencyKey({ ...input, grossRevenue: 101 }), 'different amounts differ');
    assert.notEqual(k1, revenueIdempotencyKey({ ...input, date: '2026-01-16' }), 'different dates differ');
  });
});

describe('product economics', () => {
  it('labels AI cost ESTIMATED and revenue VERIFIED', () => {
    const e = computeProductEconomics({
      aiCostUsd: 0.05,
      buildCostUsd: null,
      deploymentCostUsd: null,
      publishingCostUsd: null,
      marketingCostUsd: null,
      grossRevenueUsd: 100,
      feesUsd: 5,
      netRevenueUsd: 95,
    });
    assert.equal(e.costs.ai.provenance, 'ESTIMATED');
    assert.equal(e.revenue.gross.provenance, 'VERIFIED');
    assert.equal(e.hasRevenueEvidence, true);
  });

  it('computes estimated profit and claims PROFITABLE with sufficient evidence', () => {
    const e = computeProductEconomics({
      aiCostUsd: 0.5,
      buildCostUsd: null,
      deploymentCostUsd: 0,
      publishingCostUsd: null,
      marketingCostUsd: 10,
      grossRevenueUsd: 500,
      feesUsd: 25,
      netRevenueUsd: 475,
    });
    assert.equal(e.profitabilityClaim, 'PROFITABLE');
    assert.equal(e.estimatedProfit.amountUsd, 464.5);
    assert.equal(e.estimatedProfit.provenance, 'ESTIMATED');
    assert.match(e.claimBasis, /recorded revenue and labelled costs/);
  });

  it('claims UNPROFITABLE when costs exceed net revenue', () => {
    const e = computeProductEconomics({
      aiCostUsd: 2,
      buildCostUsd: null,
      deploymentCostUsd: null,
      publishingCostUsd: null,
      marketingCostUsd: 100,
      grossRevenueUsd: 50,
      feesUsd: 5,
      netRevenueUsd: 45,
    });
    assert.equal(e.profitabilityClaim, 'UNPROFITABLE');
  });

  it('never claims profitability without revenue evidence', () => {
    const e = computeProductEconomics({
      aiCostUsd: 0.5,
      buildCostUsd: null,
      deploymentCostUsd: null,
      publishingCostUsd: null,
      marketingCostUsd: null,
      grossRevenueUsd: null,
      feesUsd: null,
      netRevenueUsd: null,
    });
    assert.equal(e.profitabilityClaim, 'INSUFFICIENT_DATA');
    assert.match(e.claimBasis, /No recorded revenue/);
  });

  it('treats sub-threshold revenue as INSUFFICIENT_DATA', () => {
    const e = computeProductEconomics({
      aiCostUsd: 0.5,
      buildCostUsd: null,
      deploymentCostUsd: null,
      publishingCostUsd: null,
      marketingCostUsd: null,
      grossRevenueUsd: 0,
      feesUsd: 0,
      netRevenueUsd: 0,
    });
    assert.equal(e.profitabilityClaim, 'INSUFFICIENT_DATA');
  });

  it('derives net revenue from gross minus fees when net is not recorded', () => {
    const e = computeProductEconomics({
      aiCostUsd: null,
      buildCostUsd: null,
      deploymentCostUsd: null,
      publishingCostUsd: null,
      marketingCostUsd: null,
      grossRevenueUsd: 200,
      feesUsd: 10,
      netRevenueUsd: null,
    });
    assert.equal(e.revenue.net.amountUsd, 190);
  });
});
