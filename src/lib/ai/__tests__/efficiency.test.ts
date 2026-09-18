// Phase 4.5.3 — AI efficiency engine tests.
// Pure-module tests: no DB, no network, no AI. Hermetic and deterministic.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountCacheHit,
  accountCacheMiss,
  accountDuplicatePrevented,
  buildRequestSignature,
  checkDuplicate,
  checkTokenBudgets,
  compressContext,
  emptySnapshot,
  estimateCompressedTokens,
  getAgentDailyTokenBudget,
  getCacheTtlSeconds,
  getDailyTokenBudget,
  getDedupWindowSeconds,
  getMonthlyTokenBudget,
  getPurposeDailyTokenBudget,
  hashSignature,
  lookupCache,
  recordTokenUsage,
  snapshotTotals,
  storeCache,
  __resetDedupWindow,
  __resetResultCache,
  __resetTokenLedger,
} from '../efficiency';

const NOW = new Date('2026-09-18T12:00:00.000Z');

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe('token budgets (Phase 4.5.3)', () => {
  beforeEach(() => {
    __resetTokenLedger();
  });

  it('allows calls when no budgets are configured', () => {
    withEnv('AI_DAILY_TOKEN_BUDGET', undefined, () => {
      // Within the per-request cap (default 24k) so only the absence of
      // configured budgets is exercised.
      const decision = checkTokenBudgets({ estimatedTotalTokens: 10_000, agent: 'research', purpose: 'research.findings', now: NOW });
      assert.equal(decision.allowed, true);
      assert.equal(decision.budgetKind, null);
    });
  });

  it('blocks a request that exceeds the per-request budget', () => {
    withEnv('AI_MAX_REQUEST_INPUT_TOKENS', '100', () => {
      const decision = checkTokenBudgets({ estimatedTotalTokens: 500, agent: 'research', purpose: 'research.findings', now: NOW });
      assert.equal(decision.allowed, false);
      assert.equal(decision.budgetKind, 'request');
      assert.ok(decision.reason?.includes('compress or split'));
    });
  });

  it('blocks calls once the daily token budget is exhausted', () => {
    withEnv('AI_DAILY_TOKEN_BUDGET', '500', () => {
      recordTokenUsage({ agent: 'research', purpose: 'research.findings', inputTokens: 300, outputTokens: 100, at: NOW });
      const decision = checkTokenBudgets({ estimatedTotalTokens: 200, agent: 'research', purpose: 'research.findings', now: NOW });
      assert.equal(decision.allowed, false);
      assert.equal(decision.budgetKind, 'daily');
      assert.ok(decision.reason?.includes('Daily token budget reached'));
    });
  });

  it('enforces the monthly token budget', () => {
    withEnv('AI_MONTHLY_TOKEN_BUDGET', '100', () => {
      const decision = checkTokenBudgets({ estimatedTotalTokens: 101, agent: 'research', purpose: 'research.findings', now: NOW });
      assert.equal(decision.allowed, false);
      assert.equal(decision.budgetKind, 'monthly');
    });
  });

  it('enforces per-agent daily budgets', () => {
    withEnv('AI_TOKEN_BUDGET_AGENT_RESEARCH', '200', () => {
      recordTokenUsage({ agent: 'research', purpose: 'research.findings', inputTokens: 150, outputTokens: 40, at: NOW });
      const blocked = checkTokenBudgets({ estimatedTotalTokens: 50, agent: 'research', purpose: 'research.findings', now: NOW });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.budgetKind, 'agent');

      const otherAgent = checkTokenBudgets({ estimatedTotalTokens: 50, agent: 'validation', purpose: 'validation.tests', now: NOW });
      assert.equal(otherAgent.allowed, true);
    });
  });

  it('enforces per-purpose daily budgets', () => {
    withEnv('AI_TOKEN_BUDGET_PURPOSE_PRODUCT_CONCEPT', '100', () => {
      recordTokenUsage({ agent: 'product', purpose: 'product.concept', inputTokens: 80, outputTokens: 15, at: NOW });
      const blocked = checkTokenBudgets({ estimatedTotalTokens: 50, agent: 'product', purpose: 'product.concept', now: NOW });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.budgetKind, 'purpose');
    });
  });

  it('rolls the ledger over at UTC day boundaries', () => {
    withEnv('AI_DAILY_TOKEN_BUDGET', '200', () => {
      recordTokenUsage({ agent: 'research', purpose: 'research.findings', inputTokens: 150, outputTokens: 50, at: NOW });
      const nextDay = new Date('2026-09-19T00:00:01.000Z');
      const decision = checkTokenBudgets({ estimatedTotalTokens: 100, agent: 'research', purpose: 'research.findings', now: nextDay });
      assert.equal(decision.allowed, true);
    });
  });

  it('reads agent/purpose/daily/monthly budget config from env', () => {
    withEnv('AI_TOKEN_BUDGET_AGENT_BUSINESS_MANAGER', '1234', () => {
      assert.equal(getAgentDailyTokenBudget('business-manager'), 1234);
    });
    withEnv('AI_TOKEN_BUDGET_PURPOSE_RESEARCH_FINDINGS', '555', () => {
      assert.equal(getPurposeDailyTokenBudget('research.findings'), 555);
    });
    withEnv('AI_DAILY_TOKEN_BUDGET', '999', () => {
      assert.equal(getDailyTokenBudget(), 999);
    });
    withEnv('AI_MONTHLY_TOKEN_BUDGET', '88', () => {
      assert.equal(getMonthlyTokenBudget(), 88);
    });
  });
});

describe('request deduplication (Phase 4.5.3)', () => {
  beforeEach(() => {
    __resetDedupWindow();
  });

  it('detects identical signatures inside the window', () => {
    const signature = buildRequestSignature({ provider: 'gemini', model: 'm', purpose: 'p', prompt: 'same prompt' });
    const first = checkDuplicate(signature, NOW);
    assert.equal(first.duplicate, false);
    first.record(signature, 100, 0.001, NOW);

    const second = checkDuplicate(signature, new Date(NOW.getTime() + 5000));
    assert.equal(second.duplicate, true);
  });

  it('stops detecting after the window elapses', () => {
    withEnv('AI_DEDUP_WINDOW_SECONDS', '60', () => {
      assert.equal(getDedupWindowSeconds(), 60);
      const signature = buildRequestSignature({ provider: 'gemini', model: 'm', purpose: 'p', prompt: 'p2' });
      const first = checkDuplicate(signature, NOW);
      first.record(signature, 100, 0.001, NOW);

      const later = checkDuplicate(signature, new Date(NOW.getTime() + 61_000));
      assert.equal(later.duplicate, false);
    });
  });

  it('treats different prompts/options as different requests', () => {
    const a = buildRequestSignature({ provider: 'gemini', model: 'm', purpose: 'p', prompt: 'prompt-a' });
    const b = buildRequestSignature({ provider: 'gemini', model: 'm', purpose: 'p', prompt: 'prompt-b' });
    const c = buildRequestSignature({ provider: 'gemini', model: 'm', purpose: 'p', prompt: 'prompt-a', temperature: 0.9 });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it('hashSignature is deterministic and bounded', () => {
    assert.equal(hashSignature('hello'), hashSignature('hello'));
    assert.equal(hashSignature('hello').length, 8);
    assert.notEqual(hashSignature('hello'), hashSignature('hellp'));
  });

  it('accounts prevented duplicates into the snapshot', () => {
    const snapshot = emptySnapshot();
    accountDuplicatePrevented(snapshot, { inputTokens: 500, costUsd: 0.002 });
    assert.equal(snapshot.duplicateRequestsPrevented, 1);
    assert.equal(snapshot.dedupAvoidedInputTokens, 500);
    assert.equal(snapshot.dedupAvoidedCostUsd, 0.002);
  });
});

describe('result cache (Phase 4.5.3)', () => {
  beforeEach(() => {
    __resetResultCache();
  });

  it('misses on an empty cache then hits after store', () => {
    const lookup1 = lookupCache<{ v: number }>('k1', NOW);
    assert.equal(lookup1.hit, false);

    storeCache({ cacheKey: 'k1', value: { v: 42 }, inputTokens: 10, costUsd: 0.0001, now: NOW });
    const lookup2 = lookupCache<{ v: number }>('k1', new Date(NOW.getTime() + 1000));
    assert.equal(lookup2.hit, true);
    assert.equal(lookup2.value?.v, 42);
  });

  it('never serves expired entries (freshness)', () => {
    withEnv('AI_CACHE_TTL_SECONDS', '60', () => {
      assert.equal(getCacheTtlSeconds(), 60);
      storeCache({ cacheKey: 'k2', value: 'stale', inputTokens: 10, costUsd: 0.0001, now: NOW });
      const expired = lookupCache('k2', new Date(NOW.getTime() + 61_000));
      assert.equal(expired.hit, false);
    });
  });

  it('accounts hits and misses for savings estimates', () => {
    const snapshot = emptySnapshot();
    accountCacheMiss(snapshot);
    accountCacheHit(snapshot, { inputTokens: 300, costUsd: 0.001 });
    const totals = snapshotTotals(snapshot);
    assert.equal(totals.cacheHits, 1);
    assert.equal(totals.cacheMisses, 1);
    assert.equal(totals.cacheHitRate, 50);
    assert.equal(totals.cacheAvoidedInputTokens, 300);
    assert.equal(totals.totalAvoidedCostUsd, 0.001);
  });
});

describe('context compression (Phase 4.5.3)', () => {
  it('compresses a large context into a bounded block', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      label: `item-${i}`,
      text: `Fact number ${i}: `.padEnd(200, 'x'),
      evidenceType: 'AI_INFERENCE',
    }));
    const compressed = compressContext(items, 2000);
    assert.ok(compressed.compressedChars <= 2000, 'compressed block respects the budget');
    assert.ok(compressed.originalChars > compressed.compressedChars);
    assert.ok(compressed.droppedItems > 0, 'least-relevant items are dropped');
    assert.ok(compressed.text.includes('[AI_INFERENCE]'));
  });

  it('preserves provenance labels and priority order', () => {
    const compressed = compressContext(
      [
        { label: 'verified fact', text: 'First priority', evidenceType: 'VERIFIED_DATA' },
        { label: 'ai guess', text: 'Second priority', evidenceType: 'AI_INFERENCE' },
      ],
      5000,
    );
    const verifiedPos = compressed.text.indexOf('VERIFIED_DATA');
    const aiPos = compressed.text.indexOf('AI_INFERENCE');
    assert.ok(verifiedPos !== -1 && aiPos !== -1);
    assert.ok(verifiedPos < aiPos, 'priority order preserved');
    assert.equal(compressed.droppedItems, 0);
  });

  it('token estimate is roughly chars/4', () => {
    const compressed = compressContext([{ label: 'a', text: 'x'.repeat(400), evidenceType: 'AI_INFERENCE' }], 5000);
    const tokens = estimateCompressedTokens(compressed);
    assert.ok(tokens >= Math.floor(compressed.compressedChars / 4));
  });
});
