// Offline unit tests for the generic AI generation orchestration layer.
// Runs with the deterministic mock provider — no key, no network.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateValidated,
  getTimeoutMs,
  getMaxRetries,
  identifyExecutionMode,
  __resetEfficiencySnapshot,
  getEfficiencySnapshot,
} from '../generate';
import { __resetDedupWindow, __resetResultCache, __resetTokenLedger } from '../efficiency';
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
    // Unique prompt: the dedup window (Phase 4.5.3) would otherwise recognize
    // the identical request from the success test above and block it before
    // any retry could happen — which is correct production behavior, but this
    // test specifically exercises retry exhaustion.
    const outcome = await generateValidated<Record<string, unknown>>(
      'test prompt retry-exhaustion',
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

describe('Phase 4.5.3 — efficiency integration', () => {
  beforeEach(() => {
    __resetEfficiencySnapshot();
    __resetDedupWindow();
    __resetResultCache();
    __resetTokenLedger();
  });

  it('prevents an identical in-window request and accounts the saving', async () => {
    const first = await generateValidated<{ mock: boolean }>('dedup probe prompt', 'dedup.test.purpose', MOCK_SCHEMA);
    assert.equal(first.ok, true);

    const second = await generateValidated<Record<string, unknown>>('dedup probe prompt', 'dedup.test.purpose', MOCK_SCHEMA);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.blockedBy, 'dedup');
      assert.ok(second.errors[0].includes('Duplicate request prevented'));
    }
    const snapshot = getEfficiencySnapshot();
    assert.equal(snapshot.duplicateRequestsPrevented, 1);
    assert.ok(snapshot.dedupAvoidedInputTokens > 0);
  });

  it('serves a cached validated result for an explicit cacheKey (hit) and tracks misses', async () => {
    const first = await generateValidated<{ mock: boolean }>('cache probe prompt', 'cache.test.purpose', MOCK_SCHEMA, { cacheKey: 'test-cache-key' });
    assert.equal(first.ok, true);
    assert.notEqual(first.servedFromCache, true);

    let snapshot = getEfficiencySnapshot();
    assert.equal(snapshot.cacheMisses, 1);

    const second = await generateValidated<{ mock: boolean }>('cache probe prompt', 'cache.test.purpose', MOCK_SCHEMA, { cacheKey: 'test-cache-key' });
    assert.equal(second.ok, true);
    assert.equal(second.servedFromCache, true);
    assert.deepEqual(second.value, first.value);

    snapshot = getEfficiencySnapshot();
    assert.equal(snapshot.cacheHits, 1);
    assert.ok(snapshot.cacheAvoidedCostUsd > 0);
  });

  it('blocks calls when the daily token budget is exhausted', async () => {
    const previous = process.env.AI_DAILY_TOKEN_BUDGET;
    process.env.AI_DAILY_TOKEN_BUDGET = '10';
    try {
      const outcome = await generateValidated<Record<string, unknown>>('token budget probe', 'token.budget.purpose', MOCK_SCHEMA);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.blockedBy, 'token_budget');
        assert.equal(outcome.budgetKind, 'daily');
        assert.equal(outcome.attempts, 0, 'no provider call is attempted under an exhausted budget');
      }
    } finally {
      if (previous === undefined) delete process.env.AI_DAILY_TOKEN_BUDGET;
      else process.env.AI_DAILY_TOKEN_BUDGET = previous;
    }
  });

  it('the mock provider path records token usage into the ledger', async () => {
    const { getTokenLedgerTotals } = await import('../efficiency');
    await generateValidated<{ mock: boolean }>('ledger probe prompt', 'ledger.test.purpose', MOCK_SCHEMA);
    const totals = getTokenLedgerTotals();
    assert.ok(totals.totalTokens > 0);
    assert.ok(totals.byAgent['ledger'] > 0);
  });
});

describe('configured provider without credentials (operational failure)', () => {
  const previousKey = process.env.AI_PROVIDER_API_KEY;

  beforeEach(() => {
    process.env.AI_PROVIDER = 'gemini';
    delete process.env.AI_PROVIDER_API_KEY;
  });

  afterEach(() => {
    process.env.AI_PROVIDER = 'mock';
    if (previousKey === undefined) delete process.env.AI_PROVIDER_API_KEY;
    else process.env.AI_PROVIDER_API_KEY = previousKey;
  });

  it('fails closed to the caller (no throw) so deterministic fallback runs', async () => {
    const outcome = await generateValidated<Record<string, unknown>>(
      'test prompt',
      'test.purpose',
      MOCK_SCHEMA
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.fallbackUsed, true);
      assert.equal(outcome.attempts, 0, 'no provider call is attempted without credentials');
      assert.ok(outcome.categories?.includes('authentication'));
      assert.ok(outcome.errors[0].includes('AI_PROVIDER_API_KEY'));
      // No key material can leak through the error path.
      assert.ok(!/AIza[0-9A-Za-z_\-]{10,}/.test(outcome.errors.join(' ')));
    }
  });

  it('never presents the degraded outcome as live AI output', async () => {
    const outcome = await generateValidated<Record<string, unknown>>(
      'test prompt',
      'test.purpose',
      MOCK_SCHEMA
    );
    if (outcome.ok) {
      assert.fail('generation must not succeed without credentials');
      return;
    }
    // The outcome carries no value to mislabel: ok=false is the only shape.
    assert.equal('value' in outcome, false);
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
