// Phase 5.1 — Research provider contract tests (offline, injectable fetch).
// No network, no DB, no AI. Malformed external results are exercised directly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProviderForTests,
  describeResearchProviderHealth,
  parsePublishedDate,
  type ResearchProvider,
} from '../provider';
import type { SearchProvider, SearchProviderResult } from '../search-provider';

const NOW = new Date('2026-09-18T12:00:00.000Z');

/** Deterministic stub search provider. */
function stubSearchProvider(behavior: {
  configured?: boolean;
  result?: SearchProviderResult;
}): SearchProvider {
  return {
    id: 'stub',
    isConfigured: () => behavior.configured ?? true,
    configurationHint: () => (behavior.configured ?? true ? null : 'configure me'),
    async search(): Promise<SearchProviderResult> {
      return behavior.result ?? { status: 'OK', results: [] };
    },
  };
}

describe('provider health (truthful availability)', () => {
  it('reports RESEARCH_UNAVAILABLE when no provider is configured', () => {
    const previous = process.env.RESEARCH_SEARCH_PROVIDER;
    process.env.RESEARCH_SEARCH_PROVIDER = 'none-such';
    try {
      const health = describeResearchProviderHealth();
      assert.equal(health.status, 'RESEARCH_UNAVAILABLE');
      assert.equal(health.providerId, null);
      assert.ok(health.hint.includes('RESEARCH_SEARCH_PROVIDER'));
    } finally {
      if (previous === undefined) delete process.env.RESEARCH_SEARCH_PROVIDER;
      else process.env.RESEARCH_SEARCH_PROVIDER = previous;
    }
  });
});

describe('provider contract — search()', () => {
  it('returns RESEARCH_UNAVAILABLE (never fabricated results) when unconfigured', async () => {
    const provider: ResearchProvider = buildProviderForTests(null, () => NOW);
    const result = await provider.search('anything');
    assert.equal(result.status, 'RESEARCH_UNAVAILABLE');
    assert.equal(result.discovery.length, 0);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  });

  it('maps OK search results to SEARCH_DISCOVERY provenance with relevance', async () => {
    const provider: ResearchProvider = buildProviderForTests(
      stubSearchProvider({
        result: {
          status: 'OK',
          results: [
            { title: 'T1', url: 'https://example.com/a', snippet: 'Demand is growing for planners 2025-01-15' },
            { title: 'T2', url: 'https://example.com/b', snippet: 'No date here' },
          ],
        },
      }),
      () => NOW,
    );
    const result = await provider.search('planners');
    assert.equal(result.status, 'OK');
    assert.equal(result.discovery.length, 2);
    const first = result.discovery[0];
    assert.equal(first.evidenceType, 'SEARCH_DISCOVERY');
    assert.equal(first.sourceProvider, 'stub');
    assert.equal(first.sourceUrl, 'https://example.com/a');
    assert.equal(first.retrievedAt, NOW.toISOString());
    assert.equal(first.publishedAt, '2025-01-15T00:00:00.000Z');
    assert.ok(first.freshnessDays !== null && first.freshnessDays > 0);
    assert.equal(first.relevance, 1);
    assert.equal(result.discovery[1].publishedAt, null, 'unknown freshness is reported as null, never guessed');
    assert.equal(result.discovery[1].relevance, 0.5);
  });

  it('propagates provider ERROR without inventing results', async () => {
    const provider: ResearchProvider = buildProviderForTests(
      stubSearchProvider({ result: { status: 'ERROR', results: [], error: 'instance unreachable' } }),
      () => NOW,
    );
    const result = await provider.search('q');
    assert.equal(result.status, 'ERROR');
    assert.equal(result.discovery.length, 0);
  });
});

describe('provider contract — fetch/extract (VERIFIED_DATA)', () => {
  it('health() reflects the wrapped provider id', () => {
    const provider: ResearchProvider = buildProviderForTests(stubSearchProvider({}), () => NOW);
    const health = provider.health();
    assert.equal(health.providerId, 'stub');
    assert.equal(health.status, 'AVAILABLE');
  });
});

describe('published-date parsing (freshness)', () => {
  it('parses ISO dates inside snippets and rejects future dates', () => {
    assert.equal(parsePublishedDate('Report published 2025-03-10 about X'), '2025-03-10T00:00:00.000Z');
    assert.equal(parsePublishedDate('Will ship 2099-01-01 eventually'), null, 'future dates are not treated as published');
    assert.equal(parsePublishedDate('no dates at all'), null);
  });

  it('parses long-form dates', () => {
    assert.equal(parsePublishedDate('Updated Mar 4, 2025 with new data'), new Date('Mar 4, 2025').toISOString());
  });
});
