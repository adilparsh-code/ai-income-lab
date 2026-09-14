// Phase 4.2.1 - Provider resolution tests
// Verifies: mock resolves by default, mock works without key,
// unknown provider fails safely, real provider does NOT silently become mock.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderId, isRealProvider } from '../provider';
import { getProvider, getMaxRetries, getTimeoutMs, estimateTokens } from '../generate';

describe('AI Provider Resolution (Phase 4.2.1)', () => {
  describe('resolveProviderId', () => {
    const original = process.env.AI_PROVIDER;

    it('defaults to mock when AI_PROVIDER is unset', () => {
      delete process.env.AI_PROVIDER;
      assert.equal(resolveProviderId(), 'mock');
    });

    it('defaults to mock when AI_PROVIDER is empty', () => {
      process.env.AI_PROVIDER = '';
      assert.equal(resolveProviderId(), 'mock');
    });

    it('defaults to mock when AI_PROVIDER is whitespace', () => {
      process.env.AI_PROVIDER = '   ';
      assert.equal(resolveProviderId(), 'mock');
    });

    it('recognizes gemini', () => {
      process.env.AI_PROVIDER = 'gemini';
      assert.equal(resolveProviderId(), 'gemini');
    });

    it('recognizes openai', () => {
      process.env.AI_PROVIDER = 'openai';
      assert.equal(resolveProviderId(), 'openai');
    });

    it('throws on unknown provider', () => {
      process.env.AI_PROVIDER = 'claude';
      assert.throws(
        () => resolveProviderId(),
        /Invalid AI_PROVIDER/
      );
    });

    after(() => {
      if (original === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = original;
    });
  });

  describe('isRealProvider', () => {
    it('identifies gemini as real', () => {
      assert.equal(isRealProvider('gemini'), true);
    });
    it('identifies openai as real', () => {
      assert.equal(isRealProvider('openai'), true);
    });
    it('identifies mock as not real', () => {
      assert.equal(isRealProvider('mock'), false);
    });
  });

  describe('getProvider (mock by default)', () => {
    const original = process.env.AI_PROVIDER;
    const originalKey = process.env.AI_PROVIDER_API_KEY;

    it('mock provider resolves with no API key', () => {
      process.env.AI_PROVIDER = 'mock';
      delete process.env.AI_PROVIDER_API_KEY;
      const provider = getProvider();
      assert.equal(provider.id, 'mock');
    });

    it('mock provider generates deterministic output', async () => {
      process.env.AI_PROVIDER = 'mock';
      delete process.env.AI_PROVIDER_API_KEY;
      const provider = getProvider();
      const result = await provider.generate('test prompt', {
        model: 'mock-default',
        maxOutputTokens: 100,
        temperature: 0.3,
        timeoutMs: 5000,
        jsonSchema: { required: ['mock'] },
        purpose: 'test',
      });
      assert.equal(result.provider, 'mock');
      assert.ok(result.inputTokens > 0, 'inputTokens should be > 0');
      assert.ok(result.outputTokens > 0, 'outputTokens should be > 0');
    });

    it('mock provider is deterministic (same input => same output)', async () => {
      process.env.AI_PROVIDER = 'mock';
      delete process.env.AI_PROVIDER_API_KEY;
      const provider = getProvider();
      const opts = {
        model: 'mock-default', maxOutputTokens: 100, temperature: 0.3,
        timeoutMs: 5000, jsonSchema: { required: [] }, purpose: 'test',
      };
      const r1 = await provider.generate('same prompt', opts);
      const r2 = await provider.generate('same prompt', opts);
      assert.equal(r1.text, r2.text);
    });

    after(() => {
      if (original === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = original;
      if (originalKey === undefined) delete process.env.AI_PROVIDER_API_KEY;
      else process.env.AI_PROVIDER_API_KEY = originalKey;
    });
  });

  describe('real provider resolution (gemini live, openai not-enabled)', () => {
    const original = process.env.AI_PROVIDER;
    const originalKey = process.env.AI_PROVIDER_API_KEY;

    it('gemini without API key throws explicit config error', () => {
      process.env.AI_PROVIDER = 'gemini';
      delete process.env.AI_PROVIDER_API_KEY;
      assert.throws(() => getProvider(), /required but not set/i);
    });

    it('gemini WITH API key resolves a real provider (not mock)', () => {
      process.env.AI_PROVIDER = 'gemini';
      process.env.AI_PROVIDER_API_KEY = 'fake-key-for-testing';
      const provider = getProvider();
      assert.equal(provider.id, 'gemini');
      assert.notEqual(provider.id, 'mock');
    });

    it('gemini provider avoids returning mock', () => {
      process.env.AI_PROVIDER = 'gemini';
      process.env.AI_PROVIDER_API_KEY = 'fake-key-for-testing';
      const provider = getProvider();
      assert.equal(provider.id, 'gemini');
    });

    it('openai WITH API key throws capability error (not mock)', () => {
      process.env.AI_PROVIDER = 'openai';
      process.env.AI_PROVIDER_API_KEY = 'fake-key-for-testing';
      assert.throws(
        () => getProvider(),
        /not enabled yet/i
      );
    });

    it('gemini provider advertises as a real provider', () => {
      process.env.AI_PROVIDER = 'gemini';
      process.env.AI_PROVIDER_API_KEY = 'fake-key-for-testing';
      const provider = getProvider();
      assert.notEqual(provider.id, 'mock');
      assert.equal(isRealProvider(provider.id), true);
    });

    after(() => {
      if (original === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = original;
      if (originalKey === undefined) delete process.env.AI_PROVIDER_API_KEY;
      else process.env.AI_PROVIDER_API_KEY = originalKey;
    });
  });

  describe('timeout and retry configuration', () => {
    const originalTimeout = process.env.AI_TIMEOUT_MS;
    const originalRetries = process.env.AI_MAX_RETRIES;

    it('getTimeoutMs defaults to 25000', () => {
      delete process.env.AI_TIMEOUT_MS;
      assert.equal(getTimeoutMs(), 25000);
    });

    it('getTimeoutMs reads from env', () => {
      process.env.AI_TIMEOUT_MS = '10000';
      assert.equal(getTimeoutMs(), 10000);
    });

    it('getMaxRetries defaults to 2', () => {
      delete process.env.AI_MAX_RETRIES;
      assert.equal(getMaxRetries(), 2);
    });

    it('getMaxRetries reads from env', () => {
      process.env.AI_MAX_RETRIES = '5';
      assert.equal(getMaxRetries(), 5);
    });

    it('getMaxRetries caps at 5', () => {
      process.env.AI_MAX_RETRIES = '100';
      assert.equal(getMaxRetries(), 5);
    });

    after(() => {
      if (originalTimeout === undefined) delete process.env.AI_TIMEOUT_MS;
      else process.env.AI_TIMEOUT_MS = originalTimeout;
      if (originalRetries === undefined) delete process.env.AI_MAX_RETRIES;
      else process.env.AI_MAX_RETRIES = originalRetries;
    });
  });

  describe('estimateTokens', () => {
    it('estimates tokens from text length', () => {
      assert.equal(estimateTokens('hello world'), 3); // ceil(11/4) = 3
    });
    it('returns 0 for empty string', () => {
      assert.equal(estimateTokens(''), 0);
    });
    });
});

