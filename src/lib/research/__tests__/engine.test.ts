// Offline unit tests for the Real Research Engine.
// Search, fetch, cache, and clock are injected — no network, no DB, no AI key.
// These tests enforce the core invariants:
//   - halal gates run BEFORE any search/fetch/AI
//   - discovery is never upgraded into VERIFIED_DATA
//   - only successfully fetched+validated content is VERIFIED_DATA
//   - unavailable capability is reported, never fabricated
//   - caching prevents repeated external fetches

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearchSources, type ResearchEngineDeps } from '../engine';
import type { SearchProvider } from '../search-provider';
import type { SourceEvidence } from '../core';

const FIXED_NOW = new Date('2026-01-15T10:00:00Z');

function makeProvider(
  results: { title: string; url: string; snippet: string }[],
  options: { id?: string; configured?: boolean; status?: 'OK' | 'ERROR' | 'NOT_CONFIGURED'; error?: string } = {},
): { provider: SearchProvider; searchCalls: () => number } {
  let calls = 0;
  const provider: SearchProvider = {
    id: options.id ?? 'searxng',
    isConfigured: () => options.configured ?? true,
    configurationHint: () => null,
    search: async () => {
      calls += 1;
      if (options.status === 'ERROR') return { status: 'ERROR', results: [], error: options.error ?? 'provider down' };
      if (options.status === 'NOT_CONFIGURED') return { status: 'NOT_CONFIGURED', results: [], error: options.error ?? 'not configured' };
      return { status: 'OK', results };
    },
  };
  return { provider, searchCalls: () => calls };
}

interface FetchLog {
  calls: number;
  urls: string[];
}

function makeFetcher(
  behavior: 'ok' | 'fail',
  body = '<html><head><title>Test Page</title></head><body>Some extracted evidence text for the page.</body></html>',
): { fetchPage: ResearchEngineDeps['fetchPage']; log: FetchLog } {
  const log: FetchLog = { calls: 0, urls: [] };
  const fetchPage: ResearchEngineDeps['fetchPage'] = async (url: string) => {
    log.calls += 1;
    log.urls.push(url);
    if (behavior === 'fail') {
      return {
        ok: false,
        url,
        category: 'http_error',
        httpStatus: 500,
        error: 'HTTP 500 from origin',
        durationMs: 5,
        attempts: 3,
      };
    }
    return {
      ok: true,
      url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      contentLength: body.length,
      text: body,
      durationMs: 12,
      attempts: 1,
    };
  };
  return { fetchPage, log };
}

function makeMemoryCache() {
  const store = new Map<string, SourceEvidence>();
  let reads = 0;
  let writes = 0;
  return {
    cache: {
      load: async (url: string, query: string) => {
        reads += 1;
        return store.get(`${url}|${query}`) ?? null;
      },
      save: async (evidence: SourceEvidence) => {
        writes += 1;
        // The engine passes context separately; this fake keys by url+fixed
        // query via closure of the current query under test (set below).
        store.set(`${evidence.url}|${currentQuery}`, evidence);
      },
    },
    stats: () => ({ reads, writes, size: store.size }),
    store,
  };
}

let currentQuery = '';

function makeDeps(overrides: Partial<ResearchEngineDeps> = {}): ResearchEngineDeps {
  return {
    search: () => null,
    fetchPage: async () => {
      throw new Error('fetch must not be called in this test');
    },
    now: () => FIXED_NOW,
    cache: { load: async () => null, save: async () => undefined },
    ...overrides,
  };
}

const BASE_OPTIONS = {
  objective: 'Research demand for printable homeschool planners',
  query: 'printable homeschool planners demand',
  maxSources: 5,
  maxFetches: 3,
  includeAiSynthesis: false,
};

describe('engine — halal gates run BEFORE search/fetch/AI', () => {
  it('hard-blocks NOT_ALLOWED objectives with zero network and zero AI', async () => {
    const { provider, searchCalls } = makeProvider([
      { title: 'would-be result', url: 'https://example.com', snippet: 's' },
    ]);
    const { fetchPage, log } = makeFetcher('ok');

    const result = await runResearchSources(
      { ...BASE_OPTIONS, objective: 'Launch a gambling and betting affiliate site' },
      makeDeps({ search: () => provider, fetchPage }),
    );

    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.discovery.length, 0);
    assert.equal(result.evidence.length, 0);
    assert.equal(result.ai, null);
    assert.equal(searchCalls(), 0, 'search provider must never be called for prohibited topics');
    assert.equal(log.calls, 0, 'no fetch may happen for prohibited topics');
    assert.match(result.reasoning, /NOT_ALLOWED/i);
  });

  it('pauses REVIEW_REQUIRED objectives with humanReviewRequired and zero network', async () => {
    const { provider, searchCalls } = makeProvider([
      { title: 'x', url: 'https://example.com', snippet: 's' },
    ]);
    const { fetchPage, log } = makeFetcher('ok');

    const result = await runResearchSources(
      { ...BASE_OPTIONS, objective: 'Evaluate a conventional mortgage lead-gen business' },
      makeDeps({ search: () => provider, fetchPage }),
    );

    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.humanReviewRequired, true);
    assert.equal(searchCalls(), 0);
    assert.equal(log.calls, 0);
    assert.match(result.reasoning, /REVIEW_REQUIRED/i);
  });
});

describe('engine — explicit unavailability (never fabricated)', () => {
  it('returns NOT_CONFIGURED when no provider exists, fetching nothing', async () => {
    const { fetchPage, log } = makeFetcher('ok');
    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ fetchPage }));

    assert.equal(result.status, 'NOT_CONFIGURED');
    assert.equal(result.discovery.length, 0);
    assert.equal(result.evidence.length, 0);
    assert.equal(result.searchProviderId, null);
    assert.equal(log.calls, 0);
    assert.match(result.reasoning, /not configured/i);
    // The reason must not contain any invented source or number.
    assert.ok(!/https?:\/\//.test(result.reasoning.split('Set')[0]));
  });

  it('returns FAILED with zero results when the provider errors', async () => {
    const { provider } = makeProvider([], { status: 'ERROR', error: 'instance down' });
    const { fetchPage, log } = makeFetcher('ok');
    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ search: () => provider, fetchPage }));

    assert.equal(result.status, 'FAILED');
    assert.equal(result.discovery.length, 0);
    assert.equal(result.evidence.length, 0);
    assert.equal(log.calls, 0);
    assert.match(result.reasoning, /instance down/);
  });

  it('returns PARTIAL (not fabricated results) when discovery is empty', async () => {
    const { provider } = makeProvider([]);
    const { fetchPage, log } = makeFetcher('ok');
    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ search: () => provider, fetchPage }));

    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.evidence.length, 0);
    assert.equal(log.calls, 0);
  });
});

describe('engine — provenance separation', () => {
  const providerResults = [
    { title: 'Fetched One', url: 'https://one.example.com/a', snippet: 'snippet one' },
    { title: 'Fetch Failed', url: 'https://fail.example.com/b', snippet: 'snippet two' },
    { title: 'Beyond Cap', url: 'https://cap.example.com/c', snippet: 'snippet three' },
    { title: 'Duplicate', url: 'https://one.example.com/a', snippet: 'dup' },
  ];

  it('marks only fetched pages VERIFIED_DATA and keeps the rest SEARCH_DISCOVERY', async () => {
    // Custom fetcher: fails for fail.example.com, succeeds elsewhere.
    const fetchPage: ResearchEngineDeps['fetchPage'] = async (url: string) =>
      url.startsWith('https://fail.')
        ? { ok: false as const, url, category: 'http_error' as const, httpStatus: 500, error: 'HTTP 500 from origin', durationMs: 4, attempts: 3 }
        : {
            ok: true as const,
            url,
            finalUrl: url,
            status: 200,
            contentType: 'text/html',
            contentLength: 128,
            text: '<html><title>Fetched</title><body>Verified page body content.</body></html>',
            durationMs: 9,
            attempts: 1,
          };
    const { provider } = makeProvider(providerResults);
    const cache = makeMemoryCache();
    currentQuery = BASE_OPTIONS.query;

    const result = await runResearchSources(
      { ...BASE_OPTIONS, maxFetches: 2 },
      makeDeps({ search: () => provider, fetchPage, cache: cache.cache }),
    );

    assert.equal(result.status, 'PARTIAL'); // one fetch failed
    assert.equal(result.sourcesDiscovered, 3, 'duplicates are deduped');
    assert.equal(result.evidence.length, 2, 'fetching stops once maxFetches succeeds');

    // Every evidence item: fetched from origin, with fetch metadata + timestamp.
    for (const e of result.evidence) {
      assert.equal(e.evidenceType, 'VERIFIED_DATA');
      assert.equal(e.httpStatus, 200);
      assert.ok(e.fetchedAt.length > 0);
      assert.equal(e.fetchedAt, FIXED_NOW.toISOString());
      assert.ok(e.contentLength > 0);
      assert.ok(e.domain.length > 0);
    }
    assert.ok(result.evidence.some((e) => e.url === 'https://one.example.com/a'));

    // A failed fetch never becomes evidence — the engine continues to the next
    // discovery item until the quota is filled (partial success, fail-closed).
    assert.ok(!result.evidence.some((e) => e.url.startsWith('https://fail.')));

    // Fetch errors are reported with their source URL.
    assert.ok(result.fetchErrors.some((err) => err.startsWith('https://fail.example.com/b')));
    assert.match(result.fetchErrors[0], /HTTP 500/);
  });

  it('keeps discovery items beyond maxFetches out of the evidence set', async () => {
    const fetchPage: ResearchEngineDeps['fetchPage'] = async (url: string) => ({
      ok: true as const,
      url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      contentLength: 64,
      text: '<html><title>T</title></html>',
      durationMs: 5,
      attempts: 1,
    });
    const { provider } = makeProvider([
      { title: 'A', url: 'https://a.example.com', snippet: 's' },
      { title: 'B', url: 'https://b.example.com', snippet: 's' },
      { title: 'C', url: 'https://c.example.com', snippet: 's' },
      { title: 'D', url: 'https://d.example.com', snippet: 's' },
    ]);

    const result = await runResearchSources(
      { ...BASE_OPTIONS, maxFetches: 1 },
      makeDeps({ search: () => provider, fetchPage }),
    );

    assert.equal(result.sourcesDiscovered, 4);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].evidenceType, 'VERIFIED_DATA');
    assert.equal(result.evidence[0].url, 'https://a.example.com');
    // The other three remain discovery-only (they exist on the provider result
    // list but were never fetched, so they must not be claimed as evidence).
    assert.equal(result.fetchErrors.length, 0);
  });

  it('filters private/unsafe discovery URLs before any fetch', async () => {
    const { fetchPage, log } = makeFetcher('ok');
    const { provider } = makeProvider([
      { title: 'SSRF', url: 'http://169.254.169.254/meta', snippet: 's' },
      { title: 'Local', url: 'http://localhost:8080/x', snippet: 's' },
    ]);

    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ search: () => provider, fetchPage }));

    assert.equal(result.sourcesDiscovered, 0);
    assert.equal(log.calls, 0);
  });
});

describe('engine — caching', () => {
  it('serves the second run from cache without re-fetching', async () => {
    const { fetchPage, log } = makeFetcher('ok');
    const { provider } = makeProvider([
      { title: 'Cached', url: 'https://cacheable.example.com/page', snippet: 's' },
    ]);
    const mem = makeMemoryCache();
    currentQuery = BASE_OPTIONS.query;
    const deps = makeDeps({ search: () => provider, fetchPage, cache: mem.cache });

    const first = await runResearchSources(BASE_OPTIONS, deps);
    assert.equal(first.status, 'OK');
    assert.equal(first.servedFrom, 'live');
    assert.equal(log.calls, 1);
    assert.equal(mem.stats().writes, 1);

    const second = await runResearchSources(BASE_OPTIONS, deps);
    assert.equal(second.status, 'OK');
    assert.equal(second.servedFrom, 'cache', 'second run must come from cache');
    assert.equal(log.calls, 1, 'no second external fetch may occur');
    assert.equal(mem.stats().reads, 2, 'each run consults the cache once per URL');
    assert.equal(second.sourcesSucceeded, 1);
    // Cached evidence keeps its original fetch timestamp (never re-stamped).
    assert.equal(second.evidence[0].fetchedAt, first.evidence[0].fetchedAt);
  });

  it('does not write cache when every fetch fails', async () => {
    const { fetchPage } = makeFetcher('fail');
    const { provider } = makeProvider([{ title: 'X', url: 'https://x.example.com', snippet: 's' }]);
    const mem = makeMemoryCache();
    currentQuery = BASE_OPTIONS.query;

    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ search: () => provider, fetchPage, cache: mem.cache }));
    assert.equal(result.status, 'PARTIAL');
    assert.equal(mem.stats().writes, 0, 'failed fetches must not be cached as evidence');
  });
});

describe('engine — AI synthesis stays separate and fail-closed', () => {
  it('skips synthesis entirely when includeAiSynthesis is false', async () => {
    const { fetchPage } = makeFetcher('ok');
    const { provider } = makeProvider([{ title: 'A', url: 'https://a.example.com', snippet: 's' }]);
    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ search: () => provider, fetchPage }));
    assert.equal(result.ai, null);
  });

  it('reports no interpretation when AI fails closed — evidence is untouched', async () => {
    process.env.AI_MAX_RETRIES = '0';
    try {
      const { fetchPage } = makeFetcher('ok');
      const { provider } = makeProvider([{ title: 'A', url: 'https://a.example.com', snippet: 's' }]);
      const result = await runResearchSources(
        { ...BASE_OPTIONS, includeAiSynthesis: true },
        makeDeps({ search: () => provider, fetchPage }),
      );
      // The mock provider output cannot satisfy the synthesis schema, so the
      // engine must fail CLOSED: ai stays null, evidence is unchanged, and
      // nothing was invented to fill the gap.
      assert.equal(result.ai, null);
      assert.equal(result.evidence.length, 1);
      assert.match(result.reasoning, /No AI synthesis/);
    } finally {
      delete process.env.AI_MAX_RETRIES;
    }
  });
});

describe('engine — no fabricated content anywhere', () => {
  it('reasoning never contains invented market/customer/price/revenue claims', async () => {
    const { fetchPage } = makeFetcher('ok');
    const { provider } = makeProvider([{ title: 'A', url: 'https://a.example.com', snippet: 's' }]);
    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ search: () => provider, fetchPage }));

    const fabricated = [/market size/i, /\$\d[\d,.]*\s*(billion|million)/i, /\d+\s*customers/i, /revenue of \$?\d/i];
    for (const pattern of fabricated) {
      assert.ok(!pattern.test(result.reasoning), `reasoning must not contain ${pattern}`);
    }
  });

  it('evidence excerpts come only from fetched bodies (title/excerpt extraction)', async () => {
    const body = '<html><head><title>Real Title</title></head><body><p>Real extracted content paragraph.</p></body></html>';
    const { fetchPage } = makeFetcher('ok', body);
    const { provider } = makeProvider([{ title: 'Provider Title', url: 'https://real.example.com', snippet: 'provider snippet' }]);

    const result = await runResearchSources(BASE_OPTIONS, makeDeps({ search: () => provider, fetchPage }));
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].title, 'Real Title', 'title must come from the fetched page');
    assert.match(result.evidence[0].excerpt, /Real extracted content paragraph/);
    assert.ok(!result.evidence[0].excerpt.includes('provider snippet'), 'excerpt must not reuse search snippets');
  });
});
