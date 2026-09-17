// Offline unit tests for the SearchProvider abstraction.
// All HTTP behavior is simulated via injected fetch implementations —
// no real network access happens in this suite.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SearxngSearchProvider,
  TavilySearchProvider,
  describeSearchConfiguration,
  resolveSearchProviderId,
} from '../search-provider';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// SearXNG adapter
// ---------------------------------------------------------------------------

describe('SearXNG adapter', () => {
  it('parses results into title/url/snippet and is always configured', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return jsonResponse({
        results: [
          { title: 'Result A', url: 'https://a.example.com/x', content: 'Snippet A' },
          { title: 'Result B', url: 'https://b.example.com/y', content: 'Snippet B' },
        ],
      });
    }) as typeof fetch;

    const provider = new SearxngSearchProvider('https://searx.example.com', fetchImpl);
    assert.equal(provider.id, 'searxng');
    assert.equal(provider.isConfigured(), true);

    const result = await provider.search('test query', { limit: 5 });
    assert.equal(result.status, 'OK');
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results[0], {
      title: 'Result A',
      url: 'https://a.example.com/x',
      snippet: 'Snippet A',
    });
    assert.ok(requestedUrl.includes('q=test+query'), 'must send the query');
    assert.ok(requestedUrl.includes('format=json'), 'must request the JSON API');
  });

  it('filters out malformed and unsafe result entries', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: [
          { title: 'Good', url: 'https://good.example.com', content: 'ok' },
          { title: 'No url', content: 'missing url' },
          { title: 'Bad url type', url: 12345, content: 'url not a string' },
          { title: 'Private host', url: 'http://127.0.0.1:8080/internal', content: 'ssrf attempt' },
          { title: 'Not http', url: 'ftp://files.example.com/f', content: 'wrong scheme' },
        ],
      })) as typeof fetch;

    const provider = new SearxngSearchProvider('https://searx.example.com', fetchImpl);
    const result = await provider.search('anything');
    assert.equal(result.status, 'OK');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, 'https://good.example.com');
  });

  it('respects the limit', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `R${i}`,
          url: `https://r${i}.example.com`,
          content: 's',
        })),
      })) as typeof fetch;

    const provider = new SearxngSearchProvider('https://searx.example.com', fetchImpl);
    const result = await provider.search('q', { limit: 3 });
    assert.equal(result.results.length, 3);
  });

  it('returns explicit ERROR on network failure (never fabricated results)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const provider = new SearxngSearchProvider('https://searx.example.com', fetchImpl);
    const result = await provider.search('q');
    assert.equal(result.status, 'ERROR');
    assert.equal(result.results.length, 0);
    assert.match(result.error ?? '', /failed/i);
  });

  it('returns explicit ERROR on HTTP 403 with a self-hosting hint', async () => {
    const fetchImpl = (async () => new Response('blocked', { status: 403 })) as typeof fetch;
    const provider = new SearxngSearchProvider('https://searx.example.com', fetchImpl);
    const result = await provider.search('q');
    assert.equal(result.status, 'ERROR');
    assert.equal(result.results.length, 0);
    assert.match(result.error ?? '', /403/);
    assert.match(result.error ?? '', /RESEARCH_SEARXNG_URL/);
  });

  it('returns explicit ERROR on unreadable JSON', async () => {
    const fetchImpl = (async () => new Response('<html>not json</html>', { status: 200 })) as typeof fetch;
    const provider = new SearxngSearchProvider('https://searx.example.com', fetchImpl);
    const result = await provider.search('q');
    assert.equal(result.status, 'ERROR');
    assert.equal(result.results.length, 0);
    assert.match(result.error ?? '', /unreadable/i);
  });
});

// ---------------------------------------------------------------------------
// Tavily adapter (optional, key-gated)
// ---------------------------------------------------------------------------

describe('Tavily adapter', () => {
  it('returns results when configured', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: [
          { title: 'T1', url: 'https://t.example.com/1', content: 'C1' },
          { title: 'T2', url: 'https://t.example.com/2', content: 'C2' },
        ],
      })) as typeof fetch;

    const provider = new TavilySearchProvider('tvly-test-key', fetchImpl);
    assert.equal(provider.isConfigured(), true);
    const result = await provider.search('q');
    assert.equal(result.status, 'OK');
    assert.equal(result.results.length, 2);
  });

  it('reports clear errors on failures', async () => {
    const fetchImpl = (async () => new Response('denied', { status: 401 })) as typeof fetch;
    const provider = new TavilySearchProvider('tvly-test-key', fetchImpl);
    const result = await provider.search('q');
    assert.equal(result.status, 'ERROR');
    assert.match(result.error ?? '', /401/);
  });
});

// ---------------------------------------------------------------------------
// Registry / configuration states
// ---------------------------------------------------------------------------

describe('search provider registry', () => {
  beforeEach(() => {
    delete process.env.RESEARCH_SEARCH_PROVIDER;
    delete process.env.TAVILY_API_KEY;
  });

  it('defaults to searxng', () => {
    assert.equal(resolveSearchProviderId(), 'searxng');
  });

  it('resolves tavily when selected', () => {
    process.env.RESEARCH_SEARCH_PROVIDER = 'tavily';
    assert.equal(resolveSearchProviderId(), 'tavily');
  });

  it('resolves none for unknown providers (never a silent fallback)', () => {
    process.env.RESEARCH_SEARCH_PROVIDER = 'brave';
    assert.equal(resolveSearchProviderId(), null, 'brave is a future boundary, not an implementation');
    process.env.RESEARCH_SEARCH_PROVIDER = '';
    assert.equal(resolveSearchProviderId(), null);
  });

  it('describes unconfigured tavily with an actionable hint', () => {
    process.env.RESEARCH_SEARCH_PROVIDER = 'tavily';
    const state = describeSearchConfiguration();
    assert.equal(state.configured, false);
    assert.match(state.hint, /TAVILY_API_KEY/);
  });

  it('describes searxng as configured by default', () => {
    const state = describeSearchConfiguration();
    assert.equal(state.providerId, 'searxng');
    assert.equal(state.configured, true);
  });
});
