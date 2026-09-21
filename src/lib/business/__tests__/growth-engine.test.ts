// Phase 4.5.3 — Growth engine tests.
// Pure tests over recorded-evidence classification and recommendations.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvidence,
  deriveLearningSignal,
  getMinRevenueForPromising,
  getMinRevenueForProven,
  getMinSampleVisitors,
  recommendGrowthAction,
  type GrowthInput,
  type PerformanceEvidence,
} from '../growth-engine';

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

const healthyRevenue: GrowthInput['revenue'] = {
  gross: 1000,
  net: 800,
  contributionProfit: 400,
  recordCount: 5,
};

function evidence(overrides: Partial<PerformanceEvidence> = {}): PerformanceEvidence {
  return {
    ageDays: 30,
    visitors: 250,
    revenue: 300,
    costs: 100,
    conversions: 6,
    experimentDecision: null,
    manuallyPaused: false,
    ...overrides,
  };
}

describe('evidence thresholds', () => {
  it('exposes configurable thresholds with conservative defaults', () => {
    withEnv('GROWTH_MIN_SAMPLE_VISITORS', undefined, () => {
      assert.equal(getMinSampleVisitors(), 100);
    });
    withEnv('GROWTH_MIN_REVENUE_USD', undefined, () => {
      assert.equal(getMinRevenueForPromising(), 50);
    });
    withEnv('GROWTH_MIN_REVENUE_PROVEN_USD', undefined, () => {
      assert.equal(getMinRevenueForProven(), 500);
    });
  });

  it('applies custom thresholds from env', () => {
    withEnv('GROWTH_MIN_SAMPLE_VISITORS', '55', () => {
      assert.equal(getMinSampleVisitors(), 55);
    });
  });
});

describe('winner / loser evidence classification', () => {
  it('never labels a one-weak-signal entity a winner (TESTING default)', () => {
    const result = classifyEvidence(evidence({ visitors: 20, revenue: 10, costs: 5 }));
    assert.equal(result.state, 'TESTING');
    assert.ok(result.reasons.length > 0);
  });

  it('marks UNDERPERFORMING with a sufficient unprofitable sample', () => {
    const result = classifyEvidence(evidence({ visitors: 200, revenue: 30, costs: 80 }));
    assert.equal(result.state, 'UNDERPERFORMING');
    assert.ok(result.reasons[0].includes('visitors'));
  });

  it('marks PROMISING above the promising revenue threshold with profitable economics', () => {
    const result = classifyEvidence(evidence({ revenue: 120, costs: 40 }));
    assert.equal(result.state, 'PROMISING');
  });

  it('marks PROVEN at sustained decisive evidence', () => {
    const result = classifyEvidence(evidence({ revenue: 900, costs: 100 }));
    assert.equal(result.state, 'PROVEN');
  });

  it('requires profitable economics even for a human SCALE decision', () => {
    const result = classifyEvidence(evidence({ revenue: 20, costs: 300, experimentDecision: 'SCALE' }));
    assert.notEqual(result.state, 'PROVEN');
  });

  it('honors human PAUSE/KILL over numeric signals', () => {
    const paused = classifyEvidence(evidence({ revenue: 900, experimentDecision: 'PAUSE' }));
    assert.equal(paused.state, 'PAUSED');

    const killed = classifyEvidence(evidence({ revenue: 900, experimentDecision: 'KILL' }));
    assert.equal(killed.state, 'PAUSED');

    const manual = classifyEvidence(evidence({ revenue: 900, manuallyPaused: true }));
    assert.equal(manual.state, 'PAUSED');
  });

  it('reports which thresholds were applied', () => {
    const result = classifyEvidence(evidence());
    assert.equal(result.thresholds.minVisitors, getMinSampleVisitors());
    assert.equal(result.thresholds.minRevenuePromising, getMinRevenueForPromising());
    assert.equal(result.thresholds.minRevenueProven, getMinRevenueForProven());
  });
});

describe('growth recommendations', () => {
  const baseInput: GrowthInput = {
    revenue: healthyRevenue,
    products: [],
    experiments: [],
    activeOpportunityCount: 1,
    estimatedAiCostUsd: 0.02,
  };

  it('recommends PAUSE for underperforming entities (data-supported)', () => {
    const input: GrowthInput = {
      ...baseInput,
      products: [
        { id: 'p1', label: 'Weak Widget', hasProduct: true, evidence: evidence({ visitors: 300, revenue: 10, costs: 90 }) },
      ],
    };
    const result = recommendGrowthAction(input);
    assert.equal(result.type, 'PAUSE');
    assert.equal(result.dataStatus, 'DATA_SUPPORTED');
    assert.equal(result.target, 'Weak Widget');
  });

  it('recommends NEW_OPPORTUNITY with INSUFFICIENT_DATA when the pipeline is empty', () => {
    const result = recommendGrowthAction({
      ...baseInput,
      revenue: { gross: 0, net: 0, contributionProfit: 0, recordCount: 0 },
      activeOpportunityCount: 0,
    });
    assert.equal(result.type, 'NEW_OPPORTUNITY');
    assert.equal(result.dataStatus, 'INSUFFICIENT_DATA');
  });

  it('recommends TEST (never a revenue prediction) when no revenue exists but pipeline is active', () => {
    const result = recommendGrowthAction({
      ...baseInput,
      revenue: { gross: 0, net: 0, contributionProfit: 0, recordCount: 0 },
    });
    assert.equal(result.type, 'TEST');
    assert.equal(result.dataStatus, 'INSUFFICIENT_DATA');
    assert.ok(result.reason.includes('nothing is predicted'));
  });

  it('recommends IMPROVE when contribution profit is not positive', () => {
    const result = recommendGrowthAction({
      ...baseInput,
      revenue: { gross: 500, net: 400, contributionProfit: -20, recordCount: 3 },
    });
    assert.equal(result.type, 'IMPROVE');
    assert.equal(result.dataStatus, 'DATA_SUPPORTED');
  });

  it('recommends REINVEST (human-gated) for PROVEN profitable products', () => {
    const input: GrowthInput = {
      ...baseInput,
      products: [
        { id: 'p2', label: 'Proven Product', hasProduct: true, evidence: evidence({ revenue: 1200, costs: 200 }) },
      ],
    };
    const result = recommendGrowthAction(input);
    assert.equal(result.type, 'REINVEST');
    assert.equal(result.dataStatus, 'DATA_SUPPORTED');
    assert.ok(result.suggestedAreas.length > 0);
    assert.ok(result.reason.includes('no automatic spend'));
  });

  it('recommends SCALE for promising profitable products', () => {
    const input: GrowthInput = {
      ...baseInput,
      products: [
        { id: 'p3', label: 'Promising Product', hasProduct: true, evidence: evidence({ revenue: 150, costs: 40 }) },
      ],
    };
    const result = recommendGrowthAction(input);
    assert.equal(result.type, 'SCALE');
    assert.equal(result.dataStatus, 'DATA_SUPPORTED');
  });

  it('never fabricates expected revenue in any recommendation', () => {
    const results = [
      recommendGrowthAction(baseInput),
      recommendGrowthAction({ ...baseInput, activeOpportunityCount: 0, revenue: { gross: 0, net: 0, contributionProfit: 0, recordCount: 0 } }),
    ];
    for (const result of results) {
      assert.ok(!/guarantee|will earn|predicted revenue of/i.test(result.reason));
    }
  });
});

describe('learning from outcomes', () => {
  it('derives SUCCESSFUL_PATTERN from a sufficient profitable sample', () => {
    const signal = deriveLearningSignal({
      entityKind: 'PRODUCT',
      entityId: 'p1',
      cost: 50,
      revenue: 200,
      conversionRate: 0.05,
      sampleSize: 400,
    });
    assert.equal(signal.status, 'SUFFICIENT_DATA');
    assert.equal(signal.signal, 'SUCCESSFUL_PATTERN');
  });

  it('derives FAILED_HYPOTHESIS from a zero-revenue sample with cost', () => {
    const signal = deriveLearningSignal({
      entityKind: 'EXPERIMENT',
      entityId: 'e1',
      cost: 80,
      revenue: 0,
      conversionRate: null,
      sampleSize: 150,
    });
    assert.equal(signal.status, 'SUFFICIENT_DATA');
    assert.equal(signal.signal, 'FAILED_HYPOTHESIS');
  });

  it('honors human-recorded experiment results', () => {
    const success = deriveLearningSignal({
      entityKind: 'EXPERIMENT', entityId: 'e2', cost: 10, revenue: 5, conversionRate: null, sampleSize: null, result: 'SUCCESS', hypothesis: 'A works better than B',
    });
    assert.equal(success.signal, 'SUCCESSFUL_PATTERN');

    const failure = deriveLearningSignal({
      entityKind: 'EXPERIMENT', entityId: 'e3', cost: 10, revenue: 50, conversionRate: null, sampleSize: null, result: 'FAILURE',
    });
    assert.equal(failure.signal, 'FAILED_HYPOTHESIS');
  });

  it('returns INSUFFICIENT_DATA rather than fabricating a lesson', () => {
    const signal = deriveLearningSignal({
      entityKind: 'PRODUCT', entityId: 'p9', cost: 0, revenue: 0, conversionRate: null, sampleSize: null,
    });
    assert.equal(signal.status, 'INSUFFICIENT_DATA');
    assert.equal(signal.signal, null);
    assert.ok(signal.reason.includes('without fabricating'));
  });

  it('classifies UNDERPERFORMING for unprofitable samples with revenue', () => {
    const signal = deriveLearningSignal({
      entityKind: 'PRODUCT', entityId: 'p4', cost: 90, revenue: 40, conversionRate: 0.01, sampleSize: 220,
    });
    assert.equal(signal.signal, 'UNDERPERFORMING');
  });
});
