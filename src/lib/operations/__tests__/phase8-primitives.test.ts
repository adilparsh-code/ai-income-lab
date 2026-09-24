import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreOpportunity } from '../scoring-engine';
import { runSimulation, decideLifecycle, SIMULATION_E2E_PATHS } from '../simulation';
import { classifyFailure, decideRecovery } from '../failure-recovery';
import { planNextLoopTransition } from '../loop-controller';
import type { IncomeLoopState } from '@/lib/income-engine/engine';

function state(overrides: Partial<IncomeLoopState> = {}): IncomeLoopState {
  return { opportunity: { id: 'opp', title: 'Test', status: 'IDEA', halalStatus: 'HALAL', overallScore: 50 }, halalGate: { status: 'HALAL', blocked: false, reviewRequired: false, reason: null }, currentStage: 'RESEARCH', stageIndex: 1, stages: [], advanceBlocker: null, productId: null, metrics: { experiments: 0, positiveDecisions: 0, completedDecisions: 0, products: 0, publishedProducts: 0, trafficEvents: 0, revenueRecords: 0, netRevenue: 0, learningsRecorded: 0 }, dataMode: 'NO_DATA', generatedAt: new Date().toISOString(), ...overrides };
}

describe('Phase 8 operations primitives', () => {
  it('scores verified evidence above AI inference and explains every dimension', () => {
    const dims = (type: 'VERIFIED_DATA' | 'AI_INFERENCE') => ({ demand: { value: 80, evidenceType: type, source: 'test' }, competition: { value: 50, evidenceType: type, source: 'test' }, productionEffort: { value: 60, evidenceType: type, source: 'test' }, estimatedCost: { value: 70, evidenceType: type, source: 'test' }, monetization: { value: 80, evidenceType: type, source: 'test' }, evidenceStrength: { value: 80, evidenceType: type, source: 'test' }, risk: { value: 70, evidenceType: type, source: 'test' }, halalCompatibility: { value: 100, evidenceType: type, source: 'test' }, executionComplexity: { value: 70, evidenceType: type, source: 'test' } });
    const verified = scoreOpportunity({ dimensions: dims('VERIFIED_DATA'), halalStatus: 'HALAL' });
    const inferred = scoreOpportunity({ dimensions: dims('AI_INFERENCE'), halalStatus: 'HALAL' });
    assert.ok(verified.score > inferred.score);
    assert.equal(verified.explanations.length, 9);
    assert.ok(verified.warnings.length === 0);
    assert.ok(inferred.warnings.some((w) => w.includes('AI_INFERENCE')));
  });
  it('blocks prohibited and reviews ambiguous opportunities', () => {
    const base = { demand: { value: 50, evidenceType: 'AI_INFERENCE' as const, source: 'x' } } as never;
    assert.equal(scoreOpportunity({ dimensions: base, halalStatus: 'NOT_ALLOWED' }).decision, 'BLOCKED');
    assert.equal(scoreOpportunity({ dimensions: base, halalStatus: 'REVIEW_REQUIRED' }).decision, 'HUMAN_REVIEW');
  });
  it('simulates repeatably and labels all figures as simulated', () => {
    const result = runSimulation({ seed: 42, visitors: 10000, conversionRate: 0.024, priceUsd: 20, costPerVisitorUsd: 0.005, fixedCostUsd: 23 });
    const again = runSimulation({ seed: 42, visitors: 10000, conversionRate: 0.024, priceUsd: 20, costPerVisitorUsd: 0.005, fixedCostUsd: 23 });
    assert.deepEqual(result, again);
    assert.equal(result.mode, 'SIMULATED');
    assert.ok(result.revenueUsd > 0 && result.profitUsd > 0);
    assert.match(result.note, /No real/);
  });
  it('never lets simulated evidence authorize scale or kill', () => {
    assert.equal(decideLifecycle({ profitUsd: 999, conversionRate: 1, evidenceType: 'SIMULATED' }).decision, 'HUMAN_REVIEW');
    assert.equal(decideLifecycle({ profitUsd: -1, conversionRate: 0, evidenceType: 'VERIFIED_DATA' }).decision, 'KILL');
    assert.equal(decideLifecycle({ profitUsd: 10, conversionRate: 0.03, evidenceType: 'VERIFIED_DATA' }).decision, 'SCALE');
    assert.equal(decideLifecycle({ profitUsd: -1, conversionRate: 0.03, evidenceType: 'VERIFIED_DATA' }).decision, 'ITERATE');
  });
  it('classifies and bounds retries without retrying safety or configuration failures', () => {
    assert.equal(classifyFailure({ message: 'timeout' }), 'TIMEOUT');
    assert.equal(classifyFailure({ message: 'unauthorized credential' }), 'AUTHENTICATION');
    assert.equal(classifyFailure({ message: 'halal NOT_ALLOWED' }), 'BUSINESS_RULE_REJECTION');
    const scheduled = decideRecovery('TRANSIENT', 0);
    assert.equal(scheduled.state, 'RETRY_SCHEDULED');
    assert.ok(scheduled.nextRetryAt);
    assert.equal(decideRecovery('TRANSIENT', 2).state, 'DEAD_LETTER');
    assert.equal(decideRecovery('AUTHENTICATION', 0).retryable, false);
    assert.equal(decideRecovery('HUMAN_REVIEW_REQUIRED', 0).state, 'HUMAN_REVIEW');
  });
  it('plans one safe next transition and refuses blocked/review states', () => {
    const plan = planNextLoopTransition(state());
    assert.equal(plan.from, 'DISCOVER');
    assert.equal(plan.to, 'RESEARCH');
    assert.equal(plan.executionStatus, 'COMPLETED');
    const blocked = planNextLoopTransition(state({ halalGate: { status: 'NOT_ALLOWED', blocked: true, reviewRequired: false, reason: 'blocked' } }));
    assert.equal(blocked.executionStatus, 'BLOCKED');
    const review = planNextLoopTransition(state({ halalGate: { status: 'REVIEW_REQUIRED', blocked: false, reviewRequired: true, reason: 'review' } }));
    assert.equal(review.executionStatus, 'HUMAN_REVIEW');
  });
  it('defines the 15 required simulation paths', () => assert.equal(SIMULATION_E2E_PATHS.length, 15));
});
