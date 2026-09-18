// Phase 5.1 — Opportunity candidate tests: provenance integrity + halal gates.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHalalScreening,
  buildOpportunityCandidate,
  describeCandidateProvenance,
  isCandidateExecutable,
  requiresHumanReview,
  type OpportunityCandidate,
} from '../candidate';
import type { ProviderDiscovery, ProviderPageEvidence } from '../provider';

const RETRIEVED = '2026-09-18T10:00:00.000Z';

function discovery(overrides: Partial<ProviderDiscovery> = {}): ProviderDiscovery {
  return {
    evidenceType: 'SEARCH_DISCOVERY',
    sourceProvider: 'stub',
    sourceUrl: 'https://example.com/item',
    sourceTitle: 'Market demand grows for printable planners',
    snippet: 'Search interest in printable planners has risen among teachers.',
    retrievedAt: RETRIEVED,
    publishedAt: null,
    freshnessDays: null,
    relevance: 0.9,
    ...overrides,
  };
}

function fetchedPage(overrides: Partial<ProviderPageEvidence> = {}): ProviderPageEvidence {
  return {
    evidenceType: 'VERIFIED_DATA',
    sourceProvider: 'stub',
    sourceUrl: 'https://source.example.com/report',
    sourceTitle: 'Independent classroom supply report',
    domain: 'source.example.com',
    excerpt: 'Teachers report spending their own money on classroom materials. Many schools lack budget for supplies. This creates recurring demand.',
    facts: [
      { fact: 'Teachers report spending their own money on classroom materials.', evidenceType: 'VERIFIED_DATA', confidence: null },
      { fact: 'Many schools lack budget for supplies.', evidenceType: 'VERIFIED_DATA', confidence: null },
    ],
    retrievedAt: RETRIEVED,
    httpStatus: 200,
    contentType: 'text/html',
    contentLength: 4096,
    fetchDurationMs: 120,
    ...overrides,
  };
}

function baseCandidate(overrides: Partial<Parameters<typeof buildOpportunityCandidate>[0]> = {}): OpportunityCandidate {
  return buildOpportunityCandidate({
    objective: 'Affordable classroom planner products for teachers',
    discovery: [discovery()],
    fetchedPages: [fetchedPage()],
    ...overrides,
  });
}

describe('candidate normalization (provenance integrity)', () => {
  it('preserves VERIFIED_DATA and SEARCH_DISCOVERY as separate classes', () => {
    const candidate = baseCandidate();
    assert.equal(candidate.provenance.verifiedFactCount, 2);
    assert.equal(candidate.provenance.discoveryCount, 1);
    const verified = candidate.evidence.filter((e) => e.evidenceType === 'VERIFIED_DATA');
    const discovered = candidate.evidence.filter((e) => e.evidenceType === 'SEARCH_DISCOVERY');
    assert.equal(verified.length, 2);
    assert.equal(discovered.length, 1);
    assert.ok(verified.every((e) => e.sourceStatus === 'OK'));
    assert.ok(discovered.every((e) => e.sourceStatus === 'SNIPPET_ONLY'));
  });

  it('records source metadata: URL, title, provider, timestamp, freshness', () => {
    const candidate = baseCandidate({ discovery: [discovery({ publishedAt: '2025-01-15T00:00:00.000Z', freshnessDays: 611 })] });
    const item = candidate.evidence.find((e) => e.evidenceType === 'SEARCH_DISCOVERY');
    assert.ok(item);
    assert.equal(item.sourceUrl, 'https://example.com/item');
    assert.equal(item.sourceTitle, 'Market demand grows for printable planners');
    assert.equal(item.sourceProvider, 'stub');
    assert.equal(item.retrievedAt, RETRIEVED);
    assert.equal(item.freshnessDays, 611);
    assert.equal(item.relevance, 0.9);
  });

  it('carries source domains into the provenance rollup', () => {
    const candidate = baseCandidate();
    assert.ok(candidate.provenance.sourceDomains.includes('example.com'));
    assert.ok(candidate.provenance.sourceDomains.includes('source.example.com'));
  });

  it('never fabricates VERIFIED_DATA when nothing was fetched', () => {
    const candidate = baseCandidate({ fetchedPages: [] });
    assert.equal(candidate.provenance.verifiedFactCount, 0);
    assert.ok(candidate.evidenceGaps.some((g) => g.includes('No VERIFIED_DATA')));
    assert.ok(candidate.evidence.every((e) => e.evidenceType !== 'VERIFIED_DATA'));
  });

  it('reports uncertainty and evidence gaps instead of claims', () => {
    const candidate = baseCandidate();
    const allText = [
      ...candidate.uncertainties,
      ...candidate.evidenceGaps,
      ...candidate.monetizationHypotheses,
    ].join(' ').toLowerCase();
    assert.ok(allText.includes('hypothesis') || allText.includes('not') || allText.includes('no '));
    assert.ok(!/market size of \$?\d/.test(allText), 'no market-size claims');
    assert.ok(!/guaranteed/.test(allText), 'no guarantee claims');
    assert.ok(candidate.customerProblem.text.length > 0);
    assert.ok(candidate.risks.some((r) => r.toLowerCase().includes('untrusted')));
  });

  it('has zero AI inference content (no AI ran in normalization)', () => {
    const candidate = baseCandidate();
    assert.equal(candidate.provenance.aiInferenceCount, 0);
  });
});

describe('halal screening of candidates', () => {
  it('screens clean candidates as HALAL', () => {
    const candidate = baseCandidate();
    assert.equal(candidate.halal.status, 'HALAL');
    assert.ok(isCandidateExecutable(candidate));
    assert.equal(requiresHumanReview(candidate), false);
    assert.ok(candidate.halal.disclaimer.includes('not a religious authority'));
  });

  it('hard-rejects gambling-related candidates as NOT_ALLOWED', () => {
    const candidate = buildOpportunityCandidate({
      objective: 'Affiliate site reviewing online gambling and casino bonuses',
      discovery: [discovery({ sourceTitle: 'Best casino bonus sites', snippet: 'Top gambling offers and betting deals.' })],
      fetchedPages: [],
    });
    assert.equal(candidate.halal.status, 'NOT_ALLOWED');
    assert.equal(isCandidateExecutable(candidate), false);
    assert.ok(candidate.halal.reasons.length > 0);
  });

  it('flags interest-based finance as REVIEW_REQUIRED (human decides)', () => {
    const candidate = buildOpportunityCandidate({
      objective: 'Loan comparison content site using conventional finance affiliate offers',
      discovery: [discovery({ sourceTitle: 'Mortgage rates portal', snippet: 'Compare conventional banking loan options.' })],
      fetchedPages: [],
    });
    assert.equal(candidate.halal.status, 'REVIEW_REQUIRED');
    assert.equal(requiresHumanReview(candidate), true);
    assert.equal(isCandidateExecutable(candidate), false);
  });

  it('re-screening an edited candidate updates the verdict deterministically', () => {
    const candidate = baseCandidate();
    const polluted: OpportunityCandidate = {
      ...candidate,
      title: 'Pirated cracked software bundle',
    };
    const screened = applyHalalScreening(polluted);
    assert.equal(screened.halal.status, 'NOT_ALLOWED');
  });
});

describe('candidate summary', () => {
  it('summarizes provenance truthfully', () => {
    const summary = describeCandidateProvenance(baseCandidate());
    assert.ok(summary.includes('2 verified fact(s)'));
    assert.ok(summary.includes('1 discovery snippet(s)'));
    assert.ok(summary.includes('halal=HALAL'));
    assert.ok(summary.includes('No market size'));
  });
});
