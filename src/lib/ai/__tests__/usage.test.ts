// Phase 4.5.1 — AI Usage & Cost aggregation tests.
// Pure-module tests: no DB, no network, no AI. Hermetic and deterministic.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateUsage,
  aggregateUsageForRange,
  getDailyBudgetUsdSafe,
  isUsageTimeRange,
  rangeDayKeys,
  resolveUsageRange,
  type UsageLogRow,
} from '../usage';

// Fixed "now" so date math is deterministic across runs.
const NOW = new Date('2026-09-18T12:00:00.000Z');
const TODAY = '2026-09-18';

function row(overrides: Partial<UsageLogRow> = {}): UsageLogRow {
  return {
    agentType: 'research',
    action: 'execute_research',
    aiProvider: 'gemini',
    aiModel: 'gemini-2.5-flash',
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.001,
    fallbackUsed: false,
    purpose: 'research.findings',
    latencyMs: 200,
    success: true,
    createdAt: new Date('2026-09-18T08:00:00.000Z'),
    ...overrides,
  };
}

describe('usage aggregation (Phase 4.5.1)', () => {
  it('aggregates totals across rows', () => {
    const summary = aggregateUsage([row(), row({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.002 })], NOW);
    assert.equal(summary.summary.totalExecutions, 2);
    assert.equal(summary.summary.totalInputTokens, 300);
    assert.equal(summary.summary.totalOutputTokens, 130);
    assert.equal(summary.summary.estimatedTotalCostUsd, 0.003);
    assert.equal(summary.summary.aiExecutions, 2);
    assert.equal(summary.summary.deterministicExecutions, 0);
  });

  it('counts successful and failed executions from recorded flags', () => {
    const summary = aggregateUsage([
      row(),
      row({ success: true }),
      row({ success: false, fallbackUsed: true }),
      row({ success: null }), // legacy row without a flag
    ], NOW);
    assert.equal(summary.summary.successfulExecutions, 2);
    assert.equal(summary.summary.failedExecutions, 1);
    assert.equal(summary.summary.totalExecutions, 4);
  });

  it('counts fallback executions', () => {
    const summary = aggregateUsage([row(), row({ fallbackUsed: true }), row({ fallbackUsed: true })], NOW);
    assert.equal(summary.summary.fallbackExecutions, 2);
  });

  it('separates AI executions from deterministic/mock executions', () => {
    const summary = aggregateUsage([
      row(),
      row({ aiProvider: null, aiModel: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null }),
    ], NOW);
    assert.equal(summary.summary.aiExecutions, 1);
    assert.equal(summary.summary.deterministicExecutions, 1);
    assert.equal(summary.summary.totalInputTokens, 100, 'mock rows contribute no tokens');
    assert.equal(summary.summary.estimatedTotalCostUsd, 0.001);
  });

  it('reports zero usage honestly when there are no rows', () => {
    const summary = aggregateUsage([], NOW);
    assert.equal(summary.summary.totalExecutions, 0);
    assert.equal(summary.summary.totalInputTokens, 0);
    assert.equal(summary.summary.estimatedTotalCostUsd, 0);
    assert.equal(summary.summary.avgLatencyMs, null);
    assert.equal(summary.dataMode, 'NO_DATA');
    assert.deepEqual(summary.byProvider, []);
  });

  it('excludes non-finite numbers and surfaces anomaly counts instead of NaN', () => {
    const bad = {
      inputTokens: Number.NaN,
      outputTokens: Infinity,
      estimatedCostUsd: Number.NaN,
      latencyMs: -5,
    } as unknown as Partial<UsageLogRow>;
    const summary = aggregateUsage([row(bad), row()], NOW);
    assert.equal(summary.summary.totalInputTokens, 100, 'only the healthy row contributes');
    assert.equal(summary.summary.estimatedTotalCostUsd, 0.001);
    assert.ok(summary.anomalies.nonFiniteNumbersExcluded >= 3);
    assert.ok(Number.isFinite(summary.summary.totalInputTokens));
    assert.ok(Number.isFinite(summary.summary.estimatedTotalCostUsd));
  });

  it('averages latency across rows and tolerates null latency', () => {
    const summary = aggregateUsage([row({ latencyMs: 100 }), row({ latencyMs: 300 }), row({ latencyMs: null })], NOW);
    assert.equal(summary.summary.avgLatencyMs, 200);
  });
});

describe('usage grouping (Phase 4.5.1)', () => {
  it('groups by provider, including unknown for legacy rows', () => {
    const summary = aggregateUsage([
      row(),
      row({ aiProvider: 'mock' }),
      row({ aiProvider: null, aiModel: null }),
    ], NOW);
    const keys = summary.byProvider.map((g) => g.key);
    assert.deepEqual(keys, ['gemini', 'mock', 'unknown']);
    assert.equal(summary.byProvider[0].executions, 1);
  });

  it('groups by model with per-model token sums', () => {
    const summary = aggregateUsage([
      row({ aiModel: 'gemini-2.5-flash', inputTokens: 100 }),
      row({ aiModel: 'gemini-2.5-pro', inputTokens: 500 }),
      row({ aiModel: 'gemini-2.5-flash', inputTokens: 50 }),
    ], NOW);
    const flash = summary.byModel.find((g) => g.key === 'gemini-2.5-flash');
    const pro = summary.byModel.find((g) => g.key === 'gemini-2.5-pro');
    assert.equal(flash?.inputTokens, 150);
    assert.equal(pro?.inputTokens, 500);
    assert.equal(flash?.executions, 2);
  });

  it('groups by agent', () => {
    const summary = aggregateUsage([
      row({ agentType: 'research' }),
      row({ agentType: 'validation' }),
      row({ agentType: 'research' }),
    ], NOW);
    const research = summary.byAgent.find((g) => g.key === 'research');
    const validation = summary.byAgent.find((g) => g.key === 'validation');
    assert.equal(research?.executions, 2);
    assert.equal(validation?.executions, 1);
  });

  it('groups by purpose, unknown when purpose is missing', () => {
    const summary = aggregateUsage([
      row({ purpose: 'research.findings' }),
      row({ purpose: 'product.concept' }),
      row({ purpose: null }),
    ], NOW);
    const keys = summary.byPurpose.map((g) => g.key);
    assert.deepEqual(keys.sort(), ['product.concept', 'research.findings', 'unknown']);
  });
});

describe('date ranges (Phase 4.5.1)', () => {
  it('produces 7 daily keys for the 7d range (today + 6 back)', () => {
    const keys = rangeDayKeys('7d', NOW);
    assert.equal(keys.length, 7);
    assert.equal(keys[6], TODAY);
    assert.equal(keys[0], '2026-09-12');
  });

  it('produces 30 daily keys for the 30d range', () => {
    assert.equal(rangeDayKeys('30d', NOW).length, 30);
  });

  it('produces 1 daily key for today', () => {
    assert.deepEqual(rangeDayKeys('today', NOW), [TODAY]);
  });

  it('all-time has no bounded start', () => {
    const range = resolveUsageRange('all', NOW);
    assert.equal(range.startIso, null);
  });

  it('pads missing days with zero buckets for bounded ranges', () => {
    const onlyOld = [row({ createdAt: new Date('2026-09-13T10:00:00.000Z') })];
    const summary = aggregateUsageForRange(onlyOld, '7d', NOW);
    assert.equal(summary.daily.length, 7);
    const emptyDay = summary.daily.find((d) => d.date === '2026-09-17');
    assert.ok(emptyDay);
    assert.equal(emptyDay.executions, 0);
  });

  it('computes today spend and budget from the same row set', () => {
    const rows = [
      row({ estimatedCostUsd: 0.01 }),
      row({ estimatedCostUsd: 0.02, createdAt: new Date('2026-09-17T08:00:00.000Z') }),
    ];
    const summary = aggregateUsage(rows, NOW);
    assert.equal(summary.budget.todaySpendUsd, 0.01, 'only today rows count toward today spend');
  });
});

describe('daily budget calculation (Phase 4.5.1)', () => {
  it('returns null when no budget is configured', () => {
    const prev = process.env.AI_DAILY_BUDGET_USD;
    delete process.env.AI_DAILY_BUDGET_USD;
    try {
      assert.equal(getDailyBudgetUsdSafe(), null);
      const summary = aggregateUsage([row()], NOW);
      assert.equal(summary.budget.remainingUsd, null, 'unlimited budget reports null remaining, not 0');
      assert.equal(summary.budget.percentUsed, null);
    } finally {
      if (prev === undefined) delete process.env.AI_DAILY_BUDGET_USD;
      else process.env.AI_DAILY_BUDGET_USD = prev;
    }
  });

  it('computes remaining budget and percent used with a configured budget', () => {
    const prev = process.env.AI_DAILY_BUDGET_USD;
    process.env.AI_DAILY_BUDGET_USD = '1.00';
    try {
      const summary = aggregateUsage([row({ estimatedCostUsd: 0.25 })], NOW);
      assert.equal(summary.budget.dailyBudgetUsd, 1.0);
      assert.equal(summary.budget.remainingUsd, 0.75);
      assert.equal(summary.budget.percentUsed, 25);
      assert.equal(summary.budget.costBasis, 'ESTIMATED');
    } finally {
      if (prev === undefined) delete process.env.AI_DAILY_BUDGET_USD;
      else process.env.AI_DAILY_BUDGET_USD = prev;
    }
  });

  it('clamps remaining at zero when spend exceeds budget', () => {
    const prev = process.env.AI_DAILY_BUDGET_USD;
    process.env.AI_DAILY_BUDGET_USD = '0.001';
    try {
      const summary = aggregateUsage([row({ estimatedCostUsd: 0.5 })], NOW);
      assert.equal(summary.budget.remainingUsd, 0);
      assert.ok((summary.budget.percentUsed ?? 0) > 100);
    } finally {
      if (prev === undefined) delete process.env.AI_DAILY_BUDGET_USD;
      else process.env.AI_DAILY_BUDGET_USD = prev;
    }
  });

  it('treats invalid budget values as unconfigured', () => {
    const prev = process.env.AI_DAILY_BUDGET_USD;
    process.env.AI_DAILY_BUDGET_USD = 'not-a-number';
    try {
      assert.equal(getDailyBudgetUsdSafe(), null);
    } finally {
      if (prev === undefined) delete process.env.AI_DAILY_BUDGET_USD;
      else process.env.AI_DAILY_BUDGET_USD = prev;
    }
  });
});

describe('response safety contract (Phase 4.5.1)', () => {
  it('aggregation output contains only counters/labels — never payloads or env', () => {
    const summary = aggregateUsage([row()], NOW);
    const serialized = JSON.stringify(summary);
    // Prompt contents / env values must never appear in the aggregation shape.
    assert.ok(!serialized.includes('researchObjective'));
    assert.ok(!serialized.includes('AI_PROVIDER_API_KEY'));
    assert.ok(!serialized.includes('apiKey'));
    // The cost basis label is always explicit.
    assert.equal(summary.budget.costBasis, 'ESTIMATED');
  });

  it('validates the time-range allow-list', () => {
    for (const ok of ['today', '7d', '30d', 'all']) assert.ok(isUsageTimeRange(ok));
    for (const bad of ['7days', 'yesterday', '', null, 7, 'ALL; DROP TABLE']) {
      assert.equal(isUsageTimeRange(bad), false, `${String(bad)} must be rejected`);
    }
  });
});
