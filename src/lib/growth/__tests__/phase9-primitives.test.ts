// Phase 9 — pure primitive tests (no DB, no network, no AI).
// Health rules, budget caps, lifecycle bounds, decision engine, attribution,
// funnel analytics, reinvestment, allocation validation, learning validation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHealth, computePortfolioScore } from '../health';
import { canSpend, isExpired, validateExperimentRequest, BUDGET_LIMITS } from '../budget';
import { completionVerdict, decideLifecycle, nextAttempt } from '../lifecycle';
import { decideGrowth } from '../decision-engine';
import { attributeChannels, attributeExperiment, computeFunnelAnalytics, evaluateExperiment } from '../attribution';
import { recommendReinvestment, validateAllocation } from '../reinvestment';
import { validateLearningInput } from '../learning';
import {
  MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY,
  MAX_EXPERIMENT_BUDGET_USD,
  MAX_EXPERIMENT_DURATION_DAYS,
  MAX_MONTHLY_BUDGET_USD,
  MIN_VISITORS_FOR_COMPARISON,
} from '../types';

const NOW = new Date('2026-09-25T00:00:00Z');

function healthInput(overrides: Partial<Parameters<typeof computeHealth>[0]> = {}) {
  return {
    halalStatus: 'HALAL',
    opportunityStatus: 'PUBLISHED',
    stopped: false,
    visitors: 100,
    conversions: 5,
    grossRevenueUsd: 50,
    netRevenueUsd: 50,
    costsUsd: 0,
    activeExperiments: 0,
    lastActivityAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
    now: NOW,
    ...overrides,
  };
}

describe('9.7 opportunity health (deterministic)', () => {
  it('R1: NOT_ALLOWED → BLOCKED with score 0', () => {
    const r = computeHealth(healthInput({ halalStatus: 'NOT_ALLOWED' }));
    assert.equal(r.state, 'BLOCKED');
    assert.equal(r.score, 0);
    assert.ok(r.rules[0].includes('R1'));
  });

  it('R2: explicit stop → STOPPED', () => {
    const r = computeHealth(healthInput({ stopped: true }));
    assert.equal(r.state, 'STOPPED');
    assert.ok(r.rules[0].includes('R2'));
  });

  it('R3: REVIEW_REQUIRED gates growth behind human review', () => {
    const r = computeHealth(healthInput({ halalStatus: 'REVIEW_REQUIRED' }));
    assert.equal(r.state, 'NEEDS_DATA');
    assert.ok(r.rules[0].includes('R3'));
  });

  it('R4: zero-data → NEEDS_DATA (nothing fabricated)', () => {
    const r = computeHealth(healthInput({ visitors: 0, conversions: 0 }));
    assert.equal(r.state, 'NEEDS_DATA');
    assert.ok(r.rules[0].includes('R4'));
  });

  it('R5: net loss or zero conversions with traffic → UNDERPERFORMING', () => {
    const loss = computeHealth(healthInput({ netRevenueUsd: 50, costsUsd: 80 }));
    assert.equal(loss.state, 'UNDERPERFORMING');
    const noConv = computeHealth(healthInput({ conversions: 0 }));
    assert.equal(noConv.state, 'UNDERPERFORMING');
  });

  it('R6: stale activity → WATCH', () => {
    const r = computeHealth(healthInput({ lastActivityAt: new Date(NOW.getTime() - 20 * 86_400_000).toISOString() }));
    assert.equal(r.state, 'WATCH');
    assert.ok(r.rules[0].includes('R6'));
  });

  it('R7: conversions with non-negative profit → HEALTHY with UP trend', () => {
    const r = computeHealth(healthInput({}));
    assert.equal(r.state, 'HEALTHY');
    assert.equal(r.trend, 'UP');
    assert.equal(r.confidence, 'HIGH');
  });

  it('health is deterministic: same input → same output', () => {
    const a = computeHealth(healthInput({}));
    const b = computeHealth(healthInput({}));
    assert.deepEqual(a, b);
  });

  it('portfolio score is bounded 0..100 and explainable', () => {
    const health = computeHealth(healthInput({}));
    const s = computePortfolioScore({ health, experimentCount: 5, completedExperimentCount: 5, validatedLearningCount: 5, netRevenueUsd: 10 });
    assert.ok(s.score > health.score);
    assert.ok(s.score <= 100);
    assert.ok(s.breakdown.length >= 2);
  });
});

describe('9.6 experiment budget manager (hard caps)', () => {
  const baseRequest = {
    opportunityId: 'opp-1',
    experimentType: 'LANDING_PAGE',
    hypothesis: 'A new headline lifts conversions',
    metric: 'CONVERSION_RATE',
    targetValue: 0.06,
    requestedBudgetUsd: 10,
    requestedDurationDays: 7,
    correlationId: 'corr-1',
  };

  it('rejects over-cap budget, over-cap duration, unknown type/metric, bad target', () => {
    const overBudget = validateExperimentRequest({ ...baseRequest, requestedBudgetUsd: MAX_EXPERIMENT_BUDGET_USD + 1 }, { allocation: null, activeExperimentCount: 0 });
    assert.equal(overBudget.ok, false);
    const overDuration = validateExperimentRequest({ ...baseRequest, requestedDurationDays: MAX_EXPERIMENT_DURATION_DAYS + 1 }, { allocation: null, activeExperimentCount: 0 });
    assert.equal(overDuration.ok, false);
    const badType = validateExperimentRequest({ ...baseRequest, experimentType: 'GAMBLING_SPEND' }, { allocation: null, activeExperimentCount: 0 });
    assert.equal(badType.ok, false);
    const badTarget = validateExperimentRequest({ ...baseRequest, targetValue: -1 }, { allocation: null, activeExperimentCount: 0 });
    assert.equal(badTarget.ok, false);
  });

  it('fail-closed: no allocation → budget forced to $0', () => {
    const v = validateExperimentRequest(baseRequest, { allocation: null, activeExperimentCount: 0 });
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.budgetUsd, 0);
      assert.ok(v.notes.some((n) => /fail-closed/i.test(n)));
    }
  });

  it('clamps to per-experiment cap and remaining monthly budget; refuses when paused/exhausted/over-limit', () => {
    const allocation = { monthlyBudgetUsd: 20, spentThisMonthUsd: 5, perExperimentCapUsd: 4, maxActiveExperiments: 2, paused: false };
    const clamped = validateExperimentRequest(baseRequest, { allocation, activeExperimentCount: 0 });
    assert.ok(clamped.ok);
    if (clamped.ok) {
      assert.equal(clamped.budgetUsd, 4);
      assert.ok(clamped.notes.some((n) => /per-experiment cap/i.test(n)));
    }

    const paused = validateExperimentRequest(baseRequest, { allocation: { ...allocation, paused: true }, activeExperimentCount: 0 });
    assert.equal(paused.ok, false);

    const exhausted = validateExperimentRequest(baseRequest, { allocation: { ...allocation, spentThisMonthUsd: 20 }, activeExperimentCount: 0 });
    assert.equal(exhausted.ok, false);

    const overActive = validateExperimentRequest(baseRequest, { allocation, activeExperimentCount: 2 });
    assert.equal(overActive.ok, false);
  });

  it('refuses an allocation above the hard system caps', () => {
    const v = validateAllocation({ monthlyBudgetUsd: MAX_MONTHLY_BUDGET_USD + 1, perExperimentCapUsd: 5, maxActiveExperiments: 1 });
    assert.equal(v.ok, false);
    const v2 = validateAllocation({ monthlyBudgetUsd: 50, perExperimentCapUsd: 5, maxActiveExperiments: MAX_ACTIVE_EXPERIMENTS_PER_OPPORTUNITY + 1 });
    assert.equal(v2.ok, false);
    const ok = validateAllocation({ monthlyBudgetUsd: 50, perExperimentCapUsd: 10, maxActiveExperiments: 2 });
    assert.ok(ok.ok);
  });

  it('canSpend stops at experiment and monthly budgets; isExpired is exact', () => {
    assert.equal(canSpend({ spentUsd: 10, budgetUsd: 10, monthlySpentUsd: 0, monthlyBudgetUsd: 100 }).allowed, false);
    assert.equal(canSpend({ spentUsd: 5, budgetUsd: 10, monthlySpentUsd: 100, monthlyBudgetUsd: 100 }).allowed, false);
    assert.equal(canSpend({ spentUsd: 5, budgetUsd: 10, monthlySpentUsd: 10, monthlyBudgetUsd: 100 }).allowed, true);
    assert.equal(isExpired(new Date(NOW.getTime() - 1), NOW), true);
    assert.equal(isExpired(new Date(NOW.getTime() + 1), NOW), false);
  });

  it('budget limits are the documented hard caps', () => {
    assert.equal(BUDGET_LIMITS.maxExperimentBudgetUsd, 25);
    assert.equal(BUDGET_LIMITS.maxExperimentDurationDays, 30);
    assert.equal(BUDGET_LIMITS.maxMonthlyBudgetUsd, 100);
    assert.equal(BUDGET_LIMITS.maxActiveExperiments, 3);
  });
});

describe('9.11 experiment lifecycle + stop-loss', () => {
  const base = {
    status: 'ACTIVE' as const,
    executionAttempts: 0,
    failureCount: 0,
    spentUsd: 0,
    budgetUsd: 20,
    endsAt: new Date(NOW.getTime() + 7 * 86_400_000),
    stopLossThreshold: 20,
    measuredValueUsd: 0,
    halalStatus: 'HALAL',
  };

  it('halal gates dominate: NOT_ALLOWED blocks, REVIEW_REQUIRED pauses for human', () => {
    assert.equal(decideLifecycle({ ...base, halalStatus: 'NOT_ALLOWED' }, NOW).action, 'BLOCK_HALAL');
    assert.equal(decideLifecycle({ ...base, halalStatus: 'REVIEW_REQUIRED' }, NOW).action, 'PAUSE_HUMAN_REVIEW');
  });

  it('attempt limit is bounded and refuses further execution', () => {
    const d = decideLifecycle({ ...base, executionAttempts: 3 }, NOW);
    assert.equal(d.action, 'REFUSE_ATTEMPT_LIMIT');
    assert.ok(!d.nextStatus || d.nextStatus === 'ACTIVE');
  });

  it('failure threshold stops the experiment', () => {
    const d = decideLifecycle({ ...base, failureCount: 2 }, NOW);
    assert.equal(d.action, 'STOP_FAILURE_THRESHOLD');
    assert.equal(d.nextStatus, 'STOPPED');
  });

  it('budget exhaustion, expiry, and stop-loss stop the experiment', () => {
    assert.equal(decideLifecycle({ ...base, spentUsd: 20 }, NOW).action, 'STOP_BUDGET');
    assert.equal(decideLifecycle({ ...base, endsAt: new Date(NOW.getTime() - 1) }, NOW).action, 'STOP_EXPIRED');
    // Stop-loss must be exercised without also exhausting the budget: the
    // documented rule order checks budget exhaustion (rule 5) before
    // stop-loss (rule 7), so an over-budget state legitimately returns
    // STOP_BUDGET first. Raise the budget to isolate the stop-loss rule.
    const stopLoss = decideLifecycle(
      { ...base, spentUsd: 25, budgetUsd: 100, measuredValueUsd: 0, stopLossThreshold: 20 },
      NOW,
    );
    assert.equal(stopLoss.action, 'STOP_STOP_LOSS');
  });

  it('target reached → COMPLETE; within bounds → KEEP_ACTIVE', () => {
    assert.equal(decideLifecycle(base, NOW).action, 'KEEP_ACTIVE');
    assert.equal(completionVerdict({ targetValue: 10, measuredValue: 10 }), 'TARGET_REACHED');
    assert.equal(completionVerdict({ targetValue: 10, measuredValue: 5 }), 'TARGET_MISSED');
    assert.equal(completionVerdict({ targetValue: 10, measuredValue: null }), 'INCONCLUSIVE');
  });

  it('nextAttempt never exceeds the hard cap', () => {
    assert.equal(nextAttempt(0).allowed, true);
    assert.equal(nextAttempt(2).allowed, true);
    assert.equal(nextAttempt(2).attempts, 3);
    assert.equal(nextAttempt(3).allowed, false);
  });
});

describe('9.8 growth decision engine (bounded)', () => {
  const base = {
    health: 'HEALTHY' as const,
    visitors: 200,
    conversions: 20,
    netRevenueUsd: 300,
    costsUsd: 40,
    activeExperiments: 0,
    completedExperiments: 2,
    validatedLearnings: 1,
    invalidatedLearnings: 0,
    remainingMonthlyBudgetUsd: 50,
    halalStatus: 'HALAL',
  };

  it('human decision is authoritative over the engine', () => {
    const d = decideGrowth({ ...base, humanDecision: 'PAUSE' });
    assert.equal(d.decision, 'PAUSE');
    assert.equal(d.evidenceType, 'HUMAN_DECISION');
  });

  it('NOT_ALLOWED → STOP; REVIEW_REQUIRED → NEEDS_HUMAN_REVIEW', () => {
    assert.equal(decideGrowth({ ...base, halalStatus: 'NOT_ALLOWED' }).decision, 'STOP');
    assert.equal(decideGrowth({ ...base, halalStatus: 'REVIEW_REQUIRED' }).decision, 'NEEDS_HUMAN_REVIEW');
  });

  it('NEEDS_DATA → CONTINUE with zero spend authorized', () => {
    const d = decideGrowth({ ...base, health: 'NEEDS_DATA', visitors: 3 });
    assert.equal(d.decision, 'CONTINUE');
    assert.equal(d.spendIncreasing, false);
  });

  it('negative profit → PAUSE (no further spend)', () => {
    const d = decideGrowth({ ...base, costsUsd: 400 });
    assert.equal(d.decision, 'PAUSE');
    assert.equal(d.spendIncreasing, false);
  });

  it('healthy + validated learning + budget → SCALE_WITHIN_BUDGET (bounded, spend-increasing)', () => {
    const d = decideGrowth(base);
    assert.equal(d.decision, 'SCALE_WITHIN_BUDGET');
    assert.equal(d.spendIncreasing, true);
    assert.ok(d.reason.includes('remaining allocation budget'));
  });

  it('healthy but no budget → not scale', () => {
    const d = decideGrowth({ ...base, remainingMonthlyBudgetUsd: 0 });
    assert.notEqual(d.decision, 'SCALE_WITHIN_BUDGET');
  });

  it('completed experiments without validated learning → ITERATE', () => {
    const d = decideGrowth({ ...base, validatedLearnings: 0, health: 'WATCH' });
    assert.equal(d.decision, 'ITERATE');
  });

  it('deterministic: identical input → identical output', () => {
    assert.deepEqual(decideGrowth(base), decideGrowth(base));
  });
});

describe('9.4/9.5 attribution + funnel analytics (recorded data only)', () => {
  function rows(n: number, source: string, eventType: string, amountUsd: number | null = null, experimentId: string | null = null) {
    return Array.from({ length: n }, (_, i) => ({
      utmSource: source,
      utmMedium: 'cpc',
      utmCampaign: 'launch',
      utmContent: null as string | null,
      sessionId: `${source}-s${i}`,
      eventType,
      amountUsd,
      occurredAt: NOW,
      experimentId,
    }));
  }

  it('attributes visitors/purchases/revenue per channel with null rates under threshold', () => {
    const data = [...rows(35, 'google', 'VISITOR'), ...rows(2, 'google', 'PURCHASE', 29), ...rows(10, 'bing', 'VISITOR')];
    const channels = attributeChannels(data);
    assert.equal(channels.length, 2);
    const google = channels.find((c) => c.source === 'google')!;
    assert.equal(google.visitors, 35);
    assert.equal(google.purchases, 2);
    assert.equal(google.revenueUsd, 58);
    assert.equal(typeof google.conversionRate, 'number');
    const bing = channels.find((c) => c.source === 'bing')!;
    assert.equal(bing.conversionRate, null); // 10 visitors < threshold → INSUFFICIENT
    assert.equal(channels[0].source, 'google'); // sorted by revenue desc
  });

  it('experiment attribution only credits events carrying experimentId', () => {
    const data = [
      ...rows(3, 'google', 'PURCHASE', 10, 'exp-1'),
      ...rows(2, 'google', 'PURCHASE', 5, null),
    ];
    const result = attributeExperiment(data);
    assert.equal(result.attributed.length, 1);
    assert.equal(result.attributed[0].experimentId, 'exp-1');
    assert.equal(result.attributed[0].conversions, 3);
    assert.equal(result.attributed[0].revenueUsd, 30);
    assert.equal(result.unattributedConversions, 2);
  });

  it('funnel analytics label INSUFFICIENT_DATA under the visitor threshold', () => {
    const thin = computeFunnelAnalytics([...rows(10, 'google', 'VISITOR'), ...rows(1, 'google', 'PURCHASE', 9)]);
    assert.equal(thin.evidenceStatus, 'INSUFFICIENT_DATA');
    assert.equal(thin.overallConversionRate, null);
    assert.ok(thin.explanation.includes('INSUFFICIENT_DATA'));

    const rich = computeFunnelAnalytics([
      ...rows(MIN_VISITORS_FOR_COMPARISON, 'google', 'VISITOR'),
      ...rows(30, 'google', 'PRODUCT_VIEW'),
      ...rows(20, 'google', 'CTA_CLICK'),
      ...rows(10, 'google', 'CHECKOUT_STARTED'),
      ...rows(6, 'google', 'PURCHASE', 19),
    ]);
    assert.equal(rich.evidenceStatus, 'SUPPORTED');
    assert.equal(rich.overallConversionRate, 6 / MIN_VISITORS_FOR_COMPARISON);
    assert.ok(rich.revenuePerVisitorUsd !== null);
  });

  it('experiment evaluation is deterministic and never fabricates lift', () => {
    const inconclusive = evaluateExperiment({ metric: 'CONVERSION_RATE', baselineValue: 0.04, variantVisitors: 10, variantConversions: 2, variantValueUsd: 0 });
    assert.equal(inconclusive.result, 'INCONCLUSIVE');
    assert.equal(inconclusive.measuredValue, null);

    const validated = evaluateExperiment({ metric: 'CONVERSION_RATE', baselineValue: 0.04, variantVisitors: 100, variantConversions: 8, variantValueUsd: 0 });
    assert.equal(validated.result, 'VALIDATED');
    assert.equal(validated.relativeLift, 1.0);

    const invalidated = evaluateExperiment({ metric: 'CONVERSION_RATE', baselineValue: 0.05, variantVisitors: 100, variantConversions: 2, variantValueUsd: 0 });
    assert.equal(invalidated.result, 'INVALIDATED');
  });
});

describe('9.12 reinvestment recommendations (auditable)', () => {
  const base = {
    opportunityId: 'opp-1',
    health: 'UNDERPERFORMING',
    netRevenueUsd: 10,
    costsUsd: 2,
    visitors: 100,
    conversions: 1,
    remainingMonthlyBudgetUsd: 20,
    validatedLearnings: 0,
    invalidatedLearnings: 0,
    suggestedExperimentType: 'CTA',
    suggestedMetric: 'CONVERSION_RATE',
    suggestedTargetValue: 0.05,
    requestedBudgetUsd: 10,
    expectedInformationGain: 'proves whether CTA copy drives conversion',
    stopCondition: 'budget exhausted, duration elapsed, or stop-loss hit',
  };

  it('blocked/stopped/negative-profit opportunities never receive spend', () => {
    assert.equal(recommendReinvestment({ ...base, health: 'BLOCKED' }).recommended, false);
    assert.equal(recommendReinvestment({ ...base, health: 'STOPPED' }).recommended, false);
    const losing = recommendReinvestment({ ...base, costsUsd: 50 });
    assert.equal(losing.recommended, false);
    assert.equal(losing.decision, 'PAUSE');
    assert.equal(losing.maximumSpendUsd, 0);
  });

  it('UNDERPERFORMING → bounded ITERATE recommendation with max spend and stop condition', () => {
    const r = recommendReinvestment(base);
    assert.equal(r.recommended, true);
    assert.equal(r.decision, 'ITERATE');
    assert.equal(r.maximumSpendUsd, 10);
    assert.ok(r.evidence.length >= 5);
    assert.ok(r.stopCondition.length > 0);
  });

  it('HEALTHY with validated learning → SCALE_WITHIN_BUDGET clamped to remaining budget', () => {
    const r = recommendReinvestment({ ...base, health: 'HEALTHY', validatedLearnings: 2, requestedBudgetUsd: 50 });
    assert.equal(r.decision, 'SCALE_WITHIN_BUDGET');
    assert.equal(r.maximumSpendUsd, 20); // clamped to remaining monthly budget
  });

  it('no remaining budget → $0 recommendation, never overspend', () => {
    const r = recommendReinvestment({ ...base, remainingMonthlyBudgetUsd: 0 });
    assert.equal(r.recommended, false);
    assert.equal(r.maximumSpendUsd, 0);
  });

  it('NEEDS_DATA → evidence-collection only', () => {
    const r = recommendReinvestment({ ...base, health: 'NEEDS_DATA', visitors: 3 });
    assert.equal(r.recommended, false);
    assert.equal(r.decision, 'CONTINUE');
  });
});

describe('9.10 learning memory validation', () => {
  it('rejects missing hypothesis/decision and out-of-range confidence', () => {
    assert.ok(validateLearningInput({ hypothesis: '', result: 'VALIDATED', decision: 'x' }).length > 0);
    assert.ok(validateLearningInput({ hypothesis: 'h', result: 'VALIDATED', decision: '' }).length > 0);
    assert.ok(validateLearningInput({ hypothesis: 'h', result: 'MAYBE' as never, decision: 'd' }).length > 0);
    assert.ok(validateLearningInput({ hypothesis: 'h', result: 'VALIDATED', decision: 'd', confidence: 1.5 }).length > 0);
    assert.ok(validateLearningInput({ hypothesis: 'h', result: 'INCONCLUSIVE', decision: 'd' }).length === 0);
  });
});
