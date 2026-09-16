// Offline unit tests for the generic AI generation orchestration layer.
// Runs with the deterministic mock provider — no key, no network.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateValidated,
  getTimeoutMs,
  getMaxRetries,
  identifyExecutionMode,
} from '../generate';
import type { AiJsonSchema } from '../provider';

const MOCK_SCHEMA: AiJsonSchema = {
  required: ['mock'],
  properties: { mock: 'boolean' },
};

const IMPOSSIBLE_SCHEMA: AiJsonSchema = {
  required: ['this_field_is_never_produced'],
};

describe('generateValidated (mock provider)', () => {
  it('succeeds when output satisfies the schema', async () => {
    const outcome = await generateValidated<{ mock: boolean }>(
      'test prompt',
      'test.purpose',
      MOCK_SCHEMA
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.value.mock, true);
      assert.equal(outcome.fallbackUsed, false);
      assert.equal(outcome.attempts, 1);
      assert.equal(outcome.usage.provider, 'mock');
      assert.ok(Number.isFinite(outcome.usage.estimatedCostUsd));
      assert.ok(outcome.usage.estimatedCostUsd >= 0);
    }
  });

  it('fails closed after bounded retries when output can never satisfy the schema', async () => {
    const outcome = await generateValidated<Record<string, unknown>>(
      'test prompt',
      'test.purpose',
      IMPOSSIBLE_SCHEMA
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.fallbackUsed, true);
      assert.ok(outcome.attempts >= 2, 'should have retried at least once');
      assert.ok(outcome.errors.length > 0);
      assert.ok(outcome.categories?.includes('invalid_response'));
    }
  });

  it('blocks requests whose estimated cost exceeds the daily budget', async () => {
    const previous = process.env.AI_DAILY_BUDGET_USD;
    process.env.AI_DAILY_BUDGET_USD = '0.0000001';
    try {
      const outcome = await generateValidated<Record<string, unknown>>(
        'test prompt',
        'test.purpose',
        MOCK_SCHEMA
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.ok(outcome.errors[0].includes('exceeds daily budget'));
        assert.equal(outcome.attempts, 0);
      }
    } finally {
      if (previous === undefined) delete process.env.AI_DAILY_BUDGET_USD;
      else process.env.AI_DAILY_BUDGET_USD = previous;
    }
  });
});

describe('openai provider', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = 'openai';
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER;
  });

  it('is explicitly unsupported — a loud config error, never a silent mock', async () => {
    await assert.rejects(
      () => generateValidated('p', 'test.purpose', MOCK_SCHEMA),
      /openai.*not enabled/
    );
  });
});

describe('execution mode and bounds', () => {
  afterEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MAX_RETRIES;
  });

  it('defaults to the offline mock provider', () => {
    const mode = identifyExecutionMode();
    assert.equal(mode.provider, 'mock');
    assert.equal(mode.isLive, false);
    assert.equal(mode.isMocked, true);
  });

  it('identifies gemini as live', () => {
    process.env.AI_PROVIDER = 'gemini';
    const mode = identifyExecutionMode();
    assert.equal(mode.isLive, true);
    assert.equal(mode.isMocked, false);
  });

  it('rejects unknown provider ids at resolution time', () => {
    process.env.AI_PROVIDER = 'not-a-provider';
    assert.throws(() => identifyExecutionMode(), /Invalid AI_PROVIDER/);
  });

  it('clamps retry bounds to a safe maximum', () => {
    process.env.AI_MAX_RETRIES = '999';
    assert.equal(getMaxRetries(), 5);
  });

  it('uses a positive default timeout', () => {
    assert.ok(getTimeoutMs() > 0);
  });
});
