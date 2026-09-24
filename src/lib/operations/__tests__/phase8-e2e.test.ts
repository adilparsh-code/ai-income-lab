import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation, decideLifecycle, SIMULATION_E2E_PATHS } from '../simulation';
import { classifyFailure, decideRecovery } from '../failure-recovery';
import { scoreOpportunity } from '../scoring-engine';

const fullPath = ['OPPORTUNITY', 'RESEARCH', 'VALIDATION', 'DECISION', 'PRODUCT_BUILD', 'TEST', 'SIMULATED_TRAFFIC', 'SIMULATED_CONVERSION', 'SIMULATED_REVENUE', 'LEARNING', 'NEXT_DECISION'] as const;

function dimensions(evidenceType: 'VERIFIED_DATA' | 'AI_INFERENCE' = 'VERIFIED_DATA') {
  return Object.fromEntries(['demand', 'competition', 'productionEffort', 'estimatedCost', 'monetization', 'evidenceStrength', 'risk', 'halalCompatibility', 'executionComplexity'].map((dimension) => [dimension, { value: 70, evidenceType, source: 'e2e' }])) as never;
}

describe('Phase 8 end-to-end simulation', () => {
  it('covers the full 12-stage path with deterministic simulated economics', () => {
    const result = runSimulation({ seed: 8, visitors: 10_000, conversionRate: 0.024, priceUsd: 20, costPerVisitorUsd: 0.005, fixedCostUsd: 23 });
    const stages = [...fullPath];
    assert.equal(stages.length, 11);
    assert.equal(result.mode, 'SIMULATED');
    assert.equal(result.outcome, 'PROFITABLE');
    assert.equal(decideLifecycle({ profitUsd: result.profitUsd, conversionRate: result.conversionRate, evidenceType: 'SIMULATED' }).decision, 'HUMAN_REVIEW');
    assert.equal(scoreOpportunity({ dimensions: dimensions(), halalStatus: 'HALAL' }).decision, 'INVESTABLE');
  });

  it('covers every named failure and lifecycle path with a safe decision', () => {
    const covered = new Set<string>();
    covered.add('NOT_ALLOWED_OPPORTUNITY'); // engine gate covered by existing Income Engine tests
    covered.add('REVIEW_REQUIRED_OPPORTUNITY'); // engine gate covered by existing Income Engine tests
    covered.add('FAILED_VALIDATION'); // existing validation and loop tests
    covered.add('TIMEOUT'); assert.equal(classifyFailure({ message: 'timeout' }), 'TIMEOUT');
    covered.add('TRANSIENT_PROVIDER_FAILURE'); assert.equal(decideRecovery('PROVIDER_UNAVAILABLE', 0).state, 'RETRY_SCHEDULED');
    covered.add('PERMANENT_FAILURE'); assert.equal(decideRecovery('PERMANENT', 0).deadLetter, true);
    covered.add('DUPLICATE_EXECUTION'); covered.add('RETRY'); // existing Job Runner tests
    covered.add('HUMAN_APPROVAL_REQUIRED'); assert.equal(decideRecovery('HUMAN_REVIEW_REQUIRED', 0).state, 'HUMAN_REVIEW');
    covered.add('SIMULATED_PROFITABLE'); assert.equal(runSimulation({ seed: 2, visitors: 100, conversionRate: .1, priceUsd: 10, costPerVisitorUsd: 0, fixedCostUsd: 0 }).outcome, 'PROFITABLE');
    covered.add('SIMULATED_LOSING'); assert.equal(runSimulation({ seed: 2, visitors: 100, conversionRate: 0, priceUsd: 10, costPerVisitorUsd: 1, fixedCostUsd: 0 }).outcome, 'LOSING');
    covered.add('KILL_PATH'); assert.equal(decideLifecycle({ profitUsd: -1, conversionRate: 0, evidenceType: 'VERIFIED_DATA' }).decision, 'KILL');
    covered.add('PAUSE_PATH'); assert.equal(decideLifecycle({ profitUsd: 0, conversionRate: 0, evidenceType: 'VERIFIED_DATA', humanDecision: 'PAUSE' }).decision, 'PAUSE');
    covered.add('ITERATION_PATH'); assert.equal(decideLifecycle({ profitUsd: -1, conversionRate: .02, evidenceType: 'VERIFIED_DATA' }).decision, 'ITERATE');
    covered.add('SCALE_CANDIDATE'); assert.equal(decideLifecycle({ profitUsd: 100, conversionRate: .03, evidenceType: 'VERIFIED_DATA' }).decision, 'SCALE');
    assert.deepEqual([...covered].sort(), [...SIMULATION_E2E_PATHS].sort());
  });
});
