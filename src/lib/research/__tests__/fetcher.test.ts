// Offline unit tests for the Real Research Engine fetcher.
// All HTTP behavior is simulated via an injected fetch implementation —
// no real network access happens in this suite.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage } from '../fetcher';

function htmlResponse(body: string, init?: { status?: number; contentType?: string }): Response {
  const status = init?.status ?? 200;
  return new Response(body, {
    status,
    headers: { 'content-type': init?.contentType ?? 'text/html; charset=utf-8' },
  });
}

function okFetch(body: string, contentType?: string): typeof fetch {
  return (async () => htmlResponse(body, { contentType })) as typeof fetch;
}

describe('fetchPage — successful fetch', () => {
  it('returns verified page content with metadata', async () => {
    const fetchImpl = okFetch('<html><head><title>Example Page</title></head><body><h1>Hello</h1><p>' + 'x'.repeat(300) + '</p></body></html>');
    const result = await fetchPage('https://example.com/page', { fetchImpl });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 200);
      assert.equal(result.contentType, 'text/html');
      assert.ok(result.contentLength > 0);
      assert.ok(result.text.includes('Example Page'));
      assert.equal(result.attempts, 1);
    }
  });

  it('extracts content from JSON endpoints', async () => {
    const fetchImpl = okFetch('{"items":[1,2,3]}', 'application/json');
    const result = await fetchPage('https://example.com/data.json', { fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.contentType, 'application/json');
  });
});

describe('fetchPage — URL guard', () => {
  it('blocks localhost/private/metadata URLs before any request', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return htmlResponse('nope');
    }) as typeof fetch;

    for (const url of [
      'http://localhost:3000/admin',
      'http://127.0.0.1/x',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/router',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'not a url at all',
    ]) {
      const result = await fetchPage(url, { fetchImpl });
      assert.equal(result.ok, false, url);
      if (!result.ok) assert.equal(result.category, 'blocked_url', url);
    }
    assert.equal(calls, 0, 'the fetch implementation must never be invoked for blocked URLs');
  });

  it('does not follow redirects into private hosts', async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target === 'https://public.example.com/redirect') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/meta' } });
      }
      return htmlResponse('internal');
    }) as typeof fetch;

    const result = await fetchPage('https://public.example.com/redirect', { fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'blocked_url');
  });
});

describe('fetchPage — timeout and network errors', () => {
  it('reports a timeout when the request aborts', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as typeof fetch;

    const result = await fetchPage('https://example.com/slow', { fetchImpl, maxRetries: 0 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.category, 'timeout');
      assert.match(result.error, /timed out/i);
    }
  });

  it('retries retryable failures and reports attempts', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) throw new Error('socket hang up');
      return htmlResponse('<html><title>Recovered</title></html>');
    }) as typeof fetch;

    const result = await fetchPage('https://example.com/flaky', { fetchImpl, maxRetries: 2 });
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
    if (result.ok) assert.equal(result.attempts, 3);
  });

  it('does NOT retry non-retryable HTTP errors (4xx)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return htmlResponse('forbidden', { status: 403 });
    }) as typeof fetch;

    const result = await fetchPage('https://example.com/private', { fetchImpl, maxRetries: 3 });
    assert.equal(result.ok, false);
    assert.equal(calls, 1, 'a 403 must not be retried');
    if (!result.ok) assert.equal(result.category, 'http_error');
  });

  it('retries 5xx and succeeds on recovery', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return htmlResponse('boom', { status: 503 });
      return htmlResponse('<html><title>OK now</title></html>');
    }) as typeof fetch;

    const result = await fetchPage('https://example.com/flaky-5xx', { fetchImpl, maxRetries: 2 });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  });
});

describe('fetchPage — response validation', () => {
  it('rejects non-textual content types without reading the body', async () => {
    const fetchImpl = okFetch('%PDF-1.7 binary', 'application/pdf');
    const result = await fetchPage('https://example.com/doc.pdf', { fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.category, 'invalid_content');
      assert.match(result.error, /content type/i);
    }
  });

  it('rejects empty bodies', async () => {
    const fetchImpl = okFetch('');
    const result = await fetchPage('https://example.com/empty', { fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'invalid_content');
  });

  it('truncates oversized bodies at the size limit', async () => {
    const big = 'a'.repeat(64 * 1024);
    const fetchImpl = okFetch(`<html><body>${big}</body></html>`);
    const result = await fetchPage('https://example.com/huge', { fetchImpl, maxBytes: 8 * 1024 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.contentLength <= 8 * 1024, `contentLength ${result.contentLength} must respect the cap`);
    }
  });

  it('follows redirect chains to public targets', async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target === 'https://example.com/start') {
        return new Response(null, { status: 301, headers: { location: '/middle' } });
      }
      if (target === 'https://example.com/middle') {
        return new Response(null, { status: 302, headers: { location: 'https://www.example.com/end' } });
      }
      return htmlResponse('<html><title>Destination</title></html>');
    }) as typeof fetch;

    const result = await fetchPage('https://example.com/start', { fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.finalUrl, 'https://www.example.com/end');
  });
});
