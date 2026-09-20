// Phase 4.5.3 — Deterministic intelligent routing tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  determineNextAction,
  evaluateAiNecessity,
  type RoutingOpportunityState,
} from '../intelligent-routing';

function state(overrides: Partial<RoutingOpportunityState> = {}): RoutingOpportunityState {
  return {
    opportunityId: 'opp-1',
    halalStatus: 'HALAL',
    status: 'IDEA',
    hasResearchLog: false,
    hasValidationData: false,
    hasCompletedExperiment: false,
    hasPositiveExperiment: false,
    hasProduct: false,
    productStatus: null,
    hasPublishedProduct: false,
    hasRevenue: false,
    netRevenue: 0,
    contributionProfit: 0,
    revenueHealth: 'NO_DATA',
    ...overrides,
  };
}

describe('halal gates (never bypassed)', () => {
  it('routes NOT_ALLOWED to BLOCKED with no agent and no AI', () => {
    const decision = determineNextAction(state({ halalStatus: 'NOT_ALLOWED', hasResearchLog: true, hasRevenue: true }));
    assert.equal(decision.action, 'BLOCKED');
    assert.equal(decision.agent, null);
    assert.equal(decision.requiresAi, false);
    assert.ok(decision.rationale.includes('NOT_ALLOWED'));
  });

  it('routes REVIEW_REQUIRED to HUMAN_REVIEW with no autonomous execution', () => {
    const decision = determineNextAction(state({ halalStatus: 'REVIEW_REQUIRED' }));
    assert.equal(decision.action, 'HUMAN_REVIEW');
    assert.equal(decision.agent, null);
    assert.equal(decision.humanReviewRequired, true);
    assert.equal(decision.requiresAi, false);
  });

  it('halal gates dominate any lifecycle state (blocking beats revenue)', () => {
    const decision = determineNextAction(
      state({
        halalStatus: 'NOT_ALLOWED',
        hasResearchLog: true,
        hasValidationData: true,
        hasProduct: true,
        hasPublishedProduct: true,
        hasRevenue: true,
        revenueHealth: 'PROFITABLE',
      }),
    );
    assert.equal(decision.action, 'BLOCKED');
  });
});

describe('lifecycle routing', () => {
  it('starts at RESEARCH with no evidence', () => {
    const decision = determineNextAction(state());
    assert.equal(decision.action, 'RESEARCH');
    assert.equal(decision.agent, 'research');
    assert.equal(decision.requiresAi, true);
    assert.ok(decision.contextNeeds.includes('user_entered_data'));
  });

  it('moves to VALIDATION when research exists (consumes research context)', () => {
    const decision = determineNextAction(state({ hasResearchLog: true }));
    assert.equal(decision.action, 'VALIDATE');
    assert.equal(decision.agent, 'validation');
    assert.ok(decision.contextNeeds.includes('research_context'));
  });

  it('moves to BUILD_PRODUCT after validation (consumes research + validation context)', () => {
    const decision = determineNextAction(state({ hasResearchLog: true, hasValidationData: true }));
    assert.equal(decision.action, 'BUILD_PRODUCT');
    assert.equal(decision.agent, 'product');
    assert.ok(decision.contextNeeds.includes('research_context'));
    assert.ok(decision.contextNeeds.includes('validation_context'));
    assert.ok(decision.contextNeeds.includes('verified_data'));
  });

  it('routes a READY_FOR_PUBLISHING product to CONNECT_PUBLISHING (never fakes availability)', () => {
    const decision = determineNextAction(
      state({ hasResearchLog: true, hasValidationData: true, hasProduct: true, productStatus: 'READY_TO_DEPLOY' }),
    );
    assert.equal(decision.action, 'CONNECT_PUBLISHING');
    assert.equal(decision.agent, null);
    assert.equal(decision.requiresAi, false);
    assert.ok(/NOT_CONFIGURED|not connected|human approval/i.test(decision.rationale));
  });

  it('does not divert published or in-progress products through the publishing gate', () => {
    const building = determineNextAction(
      state({ hasResearchLog: true, hasValidationData: true, hasProduct: true, productStatus: 'BUILDING' }),
    );
    assert.notEqual(building.action, 'CONNECT_PUBLISHING');
    const published = determineNextAction(
      state({ hasResearchLog: true, hasValidationData: true, hasProduct: true, hasPublishedProduct: true, productStatus: 'PUBLISHED' }),
    );
    assert.notEqual(published.action, 'CONNECT_PUBLISHING');
  });

  it('requires a decisive experiment before growth actions', () => {
    const decision = determineNextAction(
      state({ hasResearchLog: true, hasValidationData: true, hasProduct: true }),
    );
    assert.equal(decision.action, 'RUN_EXPERIMENT');
    assert.equal(decision.requiresAi, false, 'experiment planning is deterministic');
  });

  it('routes to COLLECT_DATA when experiments completed but no revenue recorded', () => {
    const decision = determineNextAction(
      state({ hasResearchLog: true, hasValidationData: true, hasProduct: true, hasCompletedExperiment: true }),
    );
    assert.equal(decision.action, 'COLLECT_DATA');
    assert.equal(decision.requiresAi, false);
  });

  it('routes UNPROFITABLE revenue to REVIEW_REVENUE (never scale into losses)', () => {
    const decision = determineNextAction(
      state({
        hasResearchLog: true, hasValidationData: true, hasProduct: true,
        hasCompletedExperiment: true, hasRevenue: true, netRevenue: 300,
        contributionProfit: -50, revenueHealth: 'UNPROFITABLE', hasPublishedProduct: true,
      }),
    );
    assert.equal(decision.action, 'REVIEW_REVENUE');
    assert.equal(decision.agent, 'analytics');
    assert.equal(decision.requiresAi, false);
  });

  it('routes profitable published products to ANALYZE', () => {
    const decision = determineNextAction(
      state({
        hasResearchLog: true, hasValidationData: true, hasProduct: true,
        hasCompletedExperiment: true, hasRevenue: true, netRevenue: 800,
        contributionProfit: 300, revenueHealth: 'PROFITABLE', hasPublishedProduct: true,
      }),
    );
    assert.equal(decision.action, 'ANALYZE');
    assert.equal(decision.agent, 'analytics');
    assert.ok(decision.contextNeeds.includes('business_data'));
  });
});

describe('budget degradation', () => {
  it('marks BUDGET_LIMIT execution mode when budget is exhausted', () => {
    const decision = determineNextAction(state(), { remainingDailyBudgetUsd: 0, budgetExhausted: true });
    assert.equal(decision.executionMode, 'BUDGET_LIMIT');
  });

  it('keeps NORMAL execution mode with available budget', () => {
    const decision = determineNextAction(state(), { remainingDailyBudgetUsd: 1.5, budgetExhausted: false });
    assert.equal(decision.executionMode, 'NORMAL');
  });
});

describe('AI necessity evaluation', () => {
  it('prefers deterministic logic when the output is computable', () => {
    const decision = evaluateAiNecessity({
      action: 'ANALYZE',
      hasVerifiedAnswer: false,
      isDeterministicallyComputable: true,
      budgetAllowsAi: true,
    });
    assert.equal(decision.useAi, false);
    assert.equal(decision.fallback, 'DETERMINISTIC');
  });

  it('uses verified data instead of new AI inference when available', () => {
    const decision = evaluateAiNecessity({
      action: 'REVIEW_REVENUE',
      hasVerifiedAnswer: true,
      isDeterministicallyComputable: false,
      budgetAllowsAi: true,
    });
    assert.equal(decision.useAi, false);
    assert.equal(decision.fallback, 'DETERMINISTIC');
  });

  it('skips AI when budget policy blocks it', () => {
    const decision = evaluateAiNecessity({
      action: 'RESEARCH',
      hasVerifiedAnswer: false,
      isDeterministicallyComputable: false,
      budgetAllowsAi: false,
    });
    assert.equal(decision.useAi, false);
    assert.equal(decision.fallback, 'SKIP');
  });

  it('allows AI only for genuine judgment work under available budget', () => {
    const decision = evaluateAiNecessity({
      action: 'RESEARCH',
      hasVerifiedAnswer: false,
      isDeterministicallyComputable: false,
      budgetAllowsAi: true,
    });
    assert.equal(decision.useAi, true);
  });
});
