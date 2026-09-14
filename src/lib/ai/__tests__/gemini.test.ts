// Phase 4.2.2 — Gemini provider adapter tests.
// Verifies the adapter conforms to the generic AiProvider interface and that
// request construction / response parsing / error classification are correct.
// All network behaviour is simulated through an injected fetch (no live API).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../gemini';
import { AiProviderError, isAiProviderError, classifyGenericError } from '../provider';
import type { AiGenerateOptions, AiProvider } from '../provider';

const OPTS: AiGenerateOptions = {
  model: 'gemini-2.5-flash',
  maxOutputTokens: 200,
  temperature: 0.3,
  timeoutMs: 5000,
  jsonSchema: { required: ['summary'], properties: { summary: 'string' } },
  purpose: 'research.findings',
};

type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;

function makeProvider(fetchImpl: FakeFetch): GeminiProvider {
  return new GeminiProvider({ apiKey: 'test-key-do-not-log', fetchImpl });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function successfulBody(text: string, input = 12, output = 7): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output },
  };
}

describe('Gemini Provider Adapter (Phase 4.2.2)', () => {
  it('conforms to the generic AiProvider interface', () => {
    const provider = makeProvider(async () => jsonResponse(200, {}));
    const api: AiProvider = provider; // interface conformance check at compile time
    assert.equal(api.id, 'gemini');
    assert.equal(typeof api.generate, 'function');
  });

  it('constructs the request and parses a successful response', async () => {
    const researchJson = JSON.stringify({ summary: 'Opportunity found.', demandSignals: ['x'] });
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const provider = makeProvider(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, successfulBody(researchJson));
    });

    const result = await provider.generate('some research prompt', OPTS);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.model, 'gemini-2.5-flash');
    assert.equal(result.text, researchJson);
    assert.deepEqual(result.parsed, { summary: 'Opportunity found.', demandSignals: ['x'] });
    assert.equal(result.inputTokens, 12);
    assert.equal(result.outputTokens, 7);
    assert.ok(result.latencyMs >= 0);

    // Request construction checks.
    assert.ok(capturedUrl.includes(':generateContent'));
    assert.ok(capturedUrl.includes('gemini-2.5-flash'));
    assert.ok(capturedUrl.includes('key='));
    assert.equal(capturedInit?.method, 'POST');
    const body = JSON.parse(String(capturedInit?.body));
    assert.ok(body.contents?.[0]?.parts?.[0]?.text.includes('some research prompt'));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.temperature, 0.3);
  });

  it('falls back to token estimation when usage metadata is missing', async () => {
    const provider = makeProvider(async () =>
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
    );
    const result = await provider.generate('hello', OPTS);
    assert.ok(result.inputTokens >= 1, 'should estimate input tokens');
    assert.ok(result.outputTokens >= 1, 'should estimate output tokens');
  });

  it('rejects missing API key at construction time', () => {
    assert.throws(() => new GeminiProvider({ apiKey: '' }), /missing/i);
  });
});

describe('Gemini error classification', () => {
  function expectCategory(body: unknown, status: number): Promise<string> {
    const provider = makeProvider(async () => jsonResponse(status, body));
    return provider.generate('p', OPTS).then(
      () => {
        throw new Error('expected request to reject');
      },
      (err: AiProviderError) => err.category
    );
  }

  it('classifies authentication failure (401)', async () => {
    assert.equal(await expectCategory({ error: { code: 401, message: 'bad key', status: 'UNAUTHENTICATED' } }, 401), 'authentication');
  });

  it('classifies permission failure (403)', async () => {
    assert.equal(await expectCategory({ error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED' } }, 403), 'authentication');
  });

  it('classifies quota exhaustion (429 with exhausted message)', async () => {
    const provider = makeProvider(async () =>
      jsonResponse(429, { error: { code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED' } })
    );
    await assert.rejects(() => provider.generate('p', OPTS), (err) => {
      assert.equal((err as AiProviderError).category, 'quota');
      assert.equal((err as AiProviderError).retryable, true);
      return true;
    });
  });

  it('classifies a bare rate limit (429)', async () => {
    const provider = makeProvider(async () => jsonResponse(429, { error: { code: 429, message: 'Too many requests' } }));
    await assert.rejects(() => provider.generate('p', OPTS), (err) => {
      assert.equal((err as AiProviderError).category, 'rate_limit');
      assert.equal((err as AiProviderError).retryable, true);
      return true;
    });
  });

  it('classifies malformed/invalid response (empty candidates)', async () => {
    const provider = makeProvider(async () => jsonResponse(200, { candidates: [] }));
    await assert.rejects(() => provider.generate('p', OPTS), (err) => {
      assert.equal((err as AiProviderError).category, 'invalid_response');
      return true;
    });
  });

  it('classifies a provider outage (503)', async () => {
    const provider = makeProvider(async () =>
      jsonResponse(503, { error: { code: 503, message: 'Service unavailable', status: 'UNAVAILABLE' } })
    );
    await assert.rejects(() => provider.generate('p', OPTS), (err) => {
      assert.equal((err as AiProviderError).category, 'provider_unavailable');
      assert.equal((err as AiProviderError).retryable, true);
      return true;
    });
  });

  it('classifies a timeout', async () => {
    const provider = makeProvider(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await assert.rejects(() => provider.generate('p', OPTS), (err) => {
      assert.equal((err as AiProviderError).category, 'timeout');
      assert.equal((err as AiProviderError).retryable, true);
      return true;
    });
  });

  it('classifies a network failure', async () => {
    const provider = makeProvider(async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(() => provider.generate('p', OPTS), (err) => {
      assert.equal((err as AiProviderError).category, 'network');
      assert.equal((err as AiProviderError).retryable, true);
      return true;
    });
  });

  it('never exposes the API key in results', async () => {
    const provider = makeProvider(async () => jsonResponse(200, successfulBody('{"summary":"s"}')));
    const result = await provider.generate('p', OPTS);
    assert.ok(!JSON.stringify(result).includes('test-key-do-not-log'));
  });

  it('never exposes the API key in error messages', async () => {
    const provider = makeProvider(async () => jsonResponse(401, { error: { message: 'key invalid' } }));
    await assert.rejects(
      () => provider.generate('p', OPTS),
      (err: AiProviderError) => {
        assert.ok(!err.message.includes('test-key-do-not-log'));
        return true;
      }
    );
  });
});

describe('Provider error classification helpers', () => {
  it('AiProviderError has a category and retryable flag', () => {
    const err = new AiProviderError('boom', { category: 'network' });
    assert.equal(err.category, 'network');
    assert.equal(err.retryable, true);
    assert.equal(isAiProviderError(err), true);
  });

  it('classifyGenericError maps AbortError/TypeError and leaves unknown as unknown', () => {
    assert.equal(classifyGenericError(new DOMException('aborted', 'AbortError')), 'timeout');
    assert.equal(classifyGenericError(new TypeError('failed')), 'network');
    assert.equal(classifyGenericError(new Error('weird')), 'unknown');
  });
});