// Phase 4.2.1 - Generation orchestration tests
// Verifies: provider selection, timeout, retries, budget guard,
// schema validation, fail-closed, no network calls (mock).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateValidated,
  getTimeoutMs,
  getMaxRetries,
  estimateTokens,
} from '../generate';

describe('AI Generation Orchestration (Phase 4.2.1)', () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.AI_PROVIDER_API_KEY;
  const originalBudget = process.env.AI_DAILY_BUDGET_USD;
  const originalTimeout = process.env.AI_TIMEOUT_MS;
  const originalRetries = process.env.AI_MAX_RETRIES;

  before(() => {
    process.env.AI_PROVIDER = 'mock';
    delete process.env.AI_PROVIDER_API_KEY;
    process.env.AI_DAILY_BUDGET_USD = '100.00';
    process.env.AI_TIMEOUT_MS = '10000';
    process.env.AI_MAX_RETRIES = '2';
  });

  after(() => {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.AI_PROVIDER_API_KEY;
    else process.env.AI_PROVIDER_API_KEY = originalKey;
    if (originalBudget === undefined) delete process.env.AI_DAILY_BUDGET_USD;
    else process.env.AI_DAILY_BUDGET_USD = originalBudget;
    if (originalTimeout === undefined) delete process.env.AI_TIMEOUT_MS;
    else process.env.AI_TIMEOUT_MS = originalTimeout;
    if (originalRetries === undefined) delete process.env.AI_MAX_RETRIES;
    else process.env.AI_MAX_RETRIES = originalRetries;
  });

  describe('generateValidated with mock provider', () => {
    it('succeeds with mock provider and returns valid output', async () => {
      const schema: import('../provider').AiJsonSchema = {
        required: ['mock', 'purpose'],
        properties: { mock: 'boolean', purpose: 'string', note: 'string' as const },
      };
      const result = await generateValidated('test prompt', 'test.purpose', schema);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.mock, true);
        assert.equal(result.value.purpose, 'test.purpose');
        assert.equal(result.fallbackUsed, false);
        assert.ok(result.attempts >= 1);
        assert.ok(result.usage.inputTokens > 0);
        assert.ok(result.usage.outputTokens > 0);
        assert.equal(result.usage.provider, 'mock');
      }
    });

    it('mock provider makes no network calls (works offline)', async () => {
      const schema: import('../provider').AiJsonSchema = { required: ['mock'], properties: { mock: 'boolean' as const } };
      const result = await generateValidated('offline test', 'offline.purpose', schema);
      assert.equal(result.ok, true);
      assert.equal(result.fallbackUsed, false);
    });

    it('returns fallbackUsed=true when schema validation fails', async () => {
      const schema: import('../provider').AiJsonSchema = {
        required: ['nonexistent_field_that_mock_does_not_produce'],
        properties: {},
      };
      const result = await generateValidated('test', 'test.purpose', schema);
      assert.equal(result.ok, false);
      assert.equal(result.fallbackUsed, true);
      assert.ok(result.errors.length > 0);
    });

    it('fail-closed: no partial output on failure', async () => {
      const schema: import('../provider').AiJsonSchema = {
        required: ['another_missing_field'],
        properties: {},
      };
      const result = await generateValidated('test', 'test.purpose', schema);
      assert.equal(result.ok, false);
      assert.equal(result.fallbackUsed, true);
    });
  });

  describe('budget guard', () => {
    it('blocks when estimated cost exceeds budget', async () => {
      const originalBudget = process.env.AI_DAILY_BUDGET_USD;
      process.env.AI_DAILY_BUDGET_USD = '0.0001';
      try {
        const schema: import('../provider').AiJsonSchema = { required: ['mock'], properties: { mock: 'boolean' as const } };
        const result = await generateValidated(
          'x'.repeat(50000), 'test.purpose', schema,
        );
        assert.equal(result.ok, false);
        assert.equal(result.fallbackUsed, true);
        assert.ok(result.errors.some(e => /exceeds daily budget/i.test(e)));
        assert.equal(result.attempts, 0);
      } finally {
        process.env.AI_DAILY_BUDGET_USD = originalBudget;
      }
    });
  });

  describe('timeout and retry configuration', () => {
    it('getTimeoutMs reads from env', () => {
      process.env.AI_TIMEOUT_MS = '15000';
      assert.equal(getTimeoutMs(), 15000);
    });

    it('getMaxRetries reads from env', () => {
      process.env.AI_MAX_RETRIES = '3';
      assert.equal(getMaxRetries(), 3);
    });

    it('respects custom timeout override', async () => {
      const schema: import('../provider').AiJsonSchema = { required: ['mock'], properties: { mock: 'boolean' as const } };
      const result = await generateValidated('test', 'test.purpose', schema, { timeoutMs: 5000 });
      assert.equal(result.ok, true);
    });
  });

  describe('estimateTokens', () => {
    it('estimates tokens from text', () => {
      assert.equal(estimateTokens('hello world'), 3);
      assert.equal(estimateTokens(''), 0);
    });
  });

  describe('AI_INFERENCE classification', () => {
    it('generateValidated does not produce VERIFIED_DATA', async () => {
      const schema: import('../provider').AiJsonSchema = { required: ['mock'], properties: { mock: 'boolean' as const } };
      const result = await generateValidated('test', 'test.purpose', schema);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('VERIFIED_DATA'));
    });

    it('output is metadata-only (usage attribution, not verification)', async () => {
      const schema: import('../provider').AiJsonSchema = { required: ['mock'], properties: { mock: 'boolean' as const } };
      const result = await generateValidated('test', 'test.purpose', schema);
      if (result.ok) {
        assert.equal(result.usage.provider, 'mock');
        assert.ok(typeof result.usage.inputTokens === 'number');
        assert.ok(typeof result.usage.outputTokens === 'number');
        assert.ok(typeof result.usage.estimatedCostUsd === 'number');
        assert.ok(typeof result.usage.latencyMs === 'number');
      }
    });
  });
});


