// Phase 4.5.3 — Agent Treasury tests.
// Pure accounting tests: no DB, no network, no AI, no money movement.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  areTreasuryRatesConsistent,
  commitReservation,
  computeRevenueWaterfall,
  deriveTreasury,
  emptyTreasury,
  evaluateReinvestment,
  getAiOperatingBudgetRate,
  getBusinessReserveRate,
  getGrowthReinvestmentRate,
  getOwnerAllocationRate,
  getReinvestmentMarginThreshold,
  recordSpend,
  releaseReservation,
  reserveBudget,
} from '../agent-treasury';

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

describe('treasury policy configuration', () => {
  it('exposes configurable rates with conservative defaults', () => {
    withEnv('TREASURY_OWNER_ALLOCATION_RATE', undefined, () => {
      assert.equal(getOwnerAllocationRate(), 0.3);
    });
    withEnv('TREASURY_BUSINESS_RESERVE_RATE', undefined, () => {
      assert.equal(getBusinessReserveRate(), 0.5);
    });
    withEnv('TREASURY_AI_OPERATING_BUDGET_RATE', undefined, () => {
      assert.equal(getAiOperatingBudgetRate(), 0.1);
    });
    withEnv('TREASURY_GROWTH_REINVESTMENT_RATE', undefined, () => {
      assert.equal(getGrowthReinvestmentRate(), 0.1);
    });
    withEnv('TREASURY_REINVESTMENT_MARGIN_THRESHOLD', undefined, () => {
      assert.equal(getReinvestmentMarginThreshold(), 0.15);
    });
  });

  it('rejects invalid (non-fraction) env values with fallbacks', () => {
    withEnv('TREASURY_OWNER_ALLOCATION_RATE', '2.5', () => {
      assert.equal(getOwnerAllocationRate(), 0.3);
    });
  });

  it('default rates are consistent (sum to 1)', () => {
    assert.equal(areTreasuryRatesConsistent(), true);
  });
});

describe('treasury state accounting', () => {
  it('derives remaining/utilization without negative fantasies', () => {
    const state = emptyTreasury();
    state.allocatedBudget = 100;
    state.spentBudget = 40;
    state.reservedBudget = 20;
    const derived = deriveTreasury(state);
    assert.equal(derived.remainingBudget, 40);
    assert.equal(derived.overCommitted, 0);
    assert.equal(derived.utilizationPercent, 40);
  });

  it('reports over-commit honestly (never hides it)', () => {
    const state = emptyTreasury();
    state.allocatedBudget = 50;
    state.spentBudget = 70;
    const derived = deriveTreasury(state);
    assert.equal(derived.remainingBudget, 0);
    assert.equal(derived.overCommitted, 20);
  });

  it('reserves only within the remaining budget', () => {
    const state = emptyTreasury();
    state.allocatedBudget = 100;
    const ok = reserveBudget(state, 30);
    assert.equal(ok.ok, true);
    assert.equal(state.reservedBudget, 30);
    assert.equal(deriveTreasury(state).remainingBudget, 70);

    const tooBig = reserveBudget(state, 999);
    assert.equal(tooBig.ok, false);
    assert.ok(tooBig.reason.includes('Insufficient budget'));
    assert.equal(state.reservedBudget, 30, 'failed reservation must not mutate state');
  });

  it('commits reservations into spend and releases without spending', () => {
    const state = emptyTreasury();
    state.allocatedBudget = 100;
    reserveBudget(state, 40);

    const released = releaseReservation(state, 10);
    assert.equal(released.ok, true);
    assert.equal(state.reservedBudget, 30);

    const committed = commitReservation(state, 30);
    assert.equal(committed.ok, true);
    assert.equal(state.reservedBudget, 0);
    assert.equal(state.spentBudget, 30);
    assert.equal(deriveTreasury(state).remainingBudget, 70);
  });

  it('refuses to commit more than was reserved', () => {
    const state = emptyTreasury();
    state.allocatedBudget = 100;
    reserveBudget(state, 10);
    const result = commitReservation(state, 50);
    assert.equal(result.ok, false);
    assert.equal(state.spentBudget, 0);
  });

  it('records spend directly for estimated AgentLog costs', () => {
    const state = emptyTreasury();
    state.allocatedBudget = 10;
    const result = recordSpend(state, 0.0042);
    assert.equal(result.ok, true);
    assert.equal(state.spentBudget, 0.0042);
  });

  it('rejects zero/negative/NaN accounting operations', () => {
    const state = emptyTreasury();
    assert.equal(recordSpend(state, 0).ok, false);
    assert.equal(recordSpend(state, -5).ok, false);
    assert.equal(recordSpend(state, Number.NaN).ok, false);
    assert.equal(reserveBudget(state, -1).ok, false);
  });
});

describe('revenue waterfall', () => {
  it('splits net revenue across policy buckets', () => {
    const waterfall = computeRevenueWaterfall({ grossRevenue: 1000, operatingCost: 200 });
    assert.equal(waterfall.dataStatus, 'OK');
    assert.equal(waterfall.netRevenue, 800);
    assert.equal(waterfall.ownerAllocation, 240); // 30%
    assert.equal(waterfall.businessReserve, 400); // 50%
    assert.equal(waterfall.aiOperatingBudget, 80); // 10%
    assert.equal(waterfall.growthReinvestment, 80); // remainder
    assert.equal(
      waterfall.ownerAllocation + waterfall.businessReserve + waterfall.aiOperatingBudget + waterfall.growthReinvestment,
      waterfall.netRevenue,
    );
  });

  it('applies custom configured rates', () => {
    withEnv('TREASURY_OWNER_ALLOCATION_RATE', '0.25', () => {
      withEnv('TREASURY_BUSINESS_RESERVE_RATE', '0.25', () => {
        withEnv('TREASURY_AI_OPERATING_BUDGET_RATE', '0.25', () => {
          withEnv('TREASURY_GROWTH_REINVESTMENT_RATE', '0.25', () => {
            const waterfall = computeRevenueWaterfall({ grossRevenue: 400, operatingCost: 0 });
            assert.equal(waterfall.ownerAllocation, 100);
            assert.equal(waterfall.businessReserve, 100);
            assert.equal(waterfall.aiOperatingBudget, 100);
            assert.equal(waterfall.growthReinvestment, 100);
          });
        });
      });
    });
  });

  it('reports INSUFFICIENT_DATA honestly with zero buckets when no revenue exists', () => {
    const waterfall = computeRevenueWaterfall({ grossRevenue: 0, operatingCost: 10 });
    assert.equal(waterfall.dataStatus, 'INSUFFICIENT_DATA');
    assert.equal(waterfall.netRevenue, 0);
    assert.equal(waterfall.ownerAllocation, 0);
    assert.equal(waterfall.growthReinvestment, 0);
  });

  it('never produces a negative net revenue', () => {
    const waterfall = computeRevenueWaterfall({ grossRevenue: 100, operatingCost: 500 });
    assert.equal(waterfall.netRevenue, 0);
    assert.equal(waterfall.dataStatus, 'OK');
  });
});

describe('reinvestment recommendation', () => {
  const strongEvidence = {
    contributionMarginPercent: 0.4,
    netRevenue: 800,
    experiments: [{ id: 'e1', revenue: 300, budget: 100, decision: 'SCALE' }],
    productsWithRevenue: 1,
    activeOpportunityCount: 2,
  };

  it('recommends reinvestment only when all policy gates pass', () => {
    const result = evaluateReinvestment(strongEvidence);
    assert.equal(result.recommend, true);
    assert.equal(result.dataStatus, 'DATA_SUPPORTED');
    assert.ok(result.suggestedAreas.length > 0);
    assert.equal(result.requiresHumanApproval, true);
    assert.equal(result.automaticTransfer, false);
    assert.equal(result.gates.marginThresholdMet, true);
    assert.equal(result.gates.netRevenuePositive, true);
    assert.equal(result.gates.supportingEvidence, true);
  });

  it('refuses with INSUFFICIENT_DATA when margin is unknown', () => {
    const result = evaluateReinvestment({ ...strongEvidence, contributionMarginPercent: null });
    assert.equal(result.recommend, false);
    assert.equal(result.dataStatus, 'INSUFFICIENT_DATA');
    assert.equal(result.suggestedAreas.length, 0);
  });

  it('refuses when margin is below the configured threshold', () => {
    withEnv('TREASURY_REINVESTMENT_MARGIN_THRESHOLD', '0.5', () => {
      const result = evaluateReinvestment(strongEvidence);
      assert.equal(result.recommend, false);
      assert.equal(result.gates.marginThresholdMet, false);
      assert.ok(result.rationale.includes('below the configured reinvestment threshold'));
    });
  });

  it('refuses when net revenue is not positive', () => {
    const result = evaluateReinvestment({ ...strongEvidence, netRevenue: 0 });
    assert.equal(result.recommend, false);
    assert.equal(result.dataStatus, 'INSUFFICIENT_DATA');
  });

  it('refuses when no supporting signal exists (no experiment/product/pipeline)', () => {
    const result = evaluateReinvestment({
      contributionMarginPercent: 0.4,
      netRevenue: 800,
      experiments: [],
      productsWithRevenue: 0,
      activeOpportunityCount: 0,
    });
    assert.equal(result.recommend, false);
    assert.equal(result.gates.supportingEvidence, false);
  });

  it('NEVER moves money automatically (hard invariant)', () => {
    const result = evaluateReinvestment(strongEvidence);
    assert.equal(result.automaticTransfer, false);
    assert.equal(result.requiresHumanApproval, true);
  });
});
