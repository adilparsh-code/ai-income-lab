// Phase 4.2.1 - Model policy & cost control tests
// Verifies: cost estimator works, budget guard works, token/temperature clamping.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getModelPolicy,
  clampMaxOutputTokens,
  clampTemperature,
  estimateCostUsd,
  getDailyBudgetUsd,
  AGENT_PURPOSES,
} from '../models';
import type { AiPurpose } from '../models';

describe('AI Model Policy (Phase 4.2.1)', () => {
  describe('getModelPolicy', () => {
    it('returns gemini as default provider', () => {
      const policy = getModelPolicy('research.findings');
      assert.equal(policy.provider, 'gemini');
    });

    it('returns gemini-2.5-flash as default model', () => {
      const policy = getModelPolicy('research.findings');
      assert.equal(policy.model, 'gemini-2.5-flash');
    });

    it('returns purpose-specific token limits', () => {
      assert.equal(getModelPolicy('research.findings').maxOutputTokens, 1500);
      assert.equal(getModelPolicy('validation.tests').maxOutputTokens, 1200);
      assert.equal(getModelPolicy('product.concept').maxOutputTokens, 2000);
    });

    it('returns purpose-specific temperatures', () => {
      assert.equal(getModelPolicy('research.findings').temperature, 0.7);
      assert.equal(getModelPolicy('analytics.narrative').temperature, 0.2);
    });

    it('supports model name override via env', () => {
      const original = process.env.AI_MODEL_RESEARCH;
      process.env.AI_MODEL_RESEARCH = 'gemini-2.5-pro';
      try {
        const policy = getModelPolicy('research.findings');
        assert.equal(policy.model, 'gemini-2.5-pro');
        assert.equal(policy.provider, 'gemini');
      } finally {
        if (original === undefined) delete process.env.AI_MODEL_RESEARCH;
        else process.env.AI_MODEL_RESEARCH = original;
      }
    });

    it('returns policies for all purposes', () => {
      for (const purpose of ['research.findings', 'validation.tests', 'product.concept', 'analytics.narrative', 'business-manager.rationale'] as AiPurpose[]) {
        const policy = getModelPolicy(purpose);
        assert.ok(policy.provider, `provider should be set for ${purpose}`);
        assert.ok(policy.model, `model should be set for ${purpose}`);
      }
    });
  });

  describe('clampMaxOutputTokens', () => {
    it('clamps to minimum 100', () => {
      assert.equal(clampMaxOutputTokens(50), 100);
    });
    it('clamps to maximum 4000', () => {
      assert.equal(clampMaxOutputTokens(5000), 4000);
    });
    it('returns value in range unchanged', () => {
      assert.equal(clampMaxOutputTokens(1000), 1000);
    });
    it('falls back to 1000 for NaN', () => {
      assert.equal(clampMaxOutputTokens(NaN), 1000);
    });
  });

  describe('clampTemperature', () => {
    it('clamps negative to 0', () => {
      assert.equal(clampTemperature(-0.5), 0);
    });
    it('clamps above 1 to 1', () => {
      assert.equal(clampTemperature(1.5), 1);
    });
    it('returns value in range unchanged', () => {
      assert.equal(clampTemperature(0.5), 0.5);
    });
    it('falls back to 0.3 for NaN', () => {
      assert.equal(clampTemperature(NaN), 0.3);
    });
  });

  describe('estimateCostUsd', () => {
    it('estimates cost using known model price table', () => {
      // gemini-2.5-flash: input 0.3/million, output 2.5/million
      const cost = estimateCostUsd('gemini-2.5-flash', 100000, 50000);
      // (100000/1e6)*0.3 + (50000/1e6)*2.5 = 0.03 + 0.125 = 0.155
      assert.equal(cost, 0.155);
    });

    it('estimates cost for gpt-4o-mini', () => {
      // gpt-4o-mini: input 0.15/million, output 0.6/million
      const cost = estimateCostUsd('gpt-4o-mini', 500000, 100000);
      // (500000/1e6)*0.15 + (100000/1e6)*0.6 = 0.075 + 0.06 = 0.135
      assert.equal(cost, 0.135);
    });

    it('uses conservative fallback for unknown models', () => {
      // Unknown model => fallback price 1.0/4.0
      const cost = estimateCostUsd('unknown-model', 100000, 100000);
      // (100000/1e6)*1.0 + (100000/1e6)*4.0 = 0.1 + 0.4 = 0.5
      assert.equal(cost, 0.5);
    });

    it('returns 0 for non-finite token counts when both are invalid', () => {
      assert.equal(estimateCostUsd('gemini-2.5-flash', NaN, NaN), 0);
      assert.equal(estimateCostUsd('gemini-2.5-flash', Infinity, Infinity), 0);
    });

    it('zeros out only the invalid token count, keeps the valid one', () => {
      // inputTokens=NaN -> 0, outputTokens=1000 -> valid
      const cost = estimateCostUsd('gemini-2.5-flash', NaN, 1000);
      // (0/1e6)*0.3 + (1000/1e6)*2.5 = 0.0025
      assert.equal(cost, 0.0025);
    });
  });

  describe('getDailyBudgetUsd', () => {
    const original = process.env.AI_DAILY_BUDGET_USD;

    it('defaults to 2.00', () => {
      delete process.env.AI_DAILY_BUDGET_USD;
      assert.equal(getDailyBudgetUsd(), 2.0);
    });

    it('reads from env', () => {
      process.env.AI_DAILY_BUDGET_USD = '5.50';
      assert.equal(getDailyBudgetUsd(), 5.5);
    });

    it('falls back to 2.0 for invalid values', () => {
      process.env.AI_DAILY_BUDGET_USD = 'not-a-number';
      assert.equal(getDailyBudgetUsd(), 2.0);
    });

    after(() => {
      if (original === undefined) delete process.env.AI_DAILY_BUDGET_USD;
      else process.env.AI_DAILY_BUDGET_USD = original;
    });
  });

  describe('AGENT_PURPOSES', () => {
    it('has a purpose for each agent type', () => {
      assert.ok(AGENT_PURPOSES.research);
      assert.ok(AGENT_PURPOSES.validation);
      assert.ok(AGENT_PURPOSES.product);
      assert.ok(AGENT_PURPOSES.analytics);
      assert.ok(AGENT_PURPOSES['business-manager']);
    });
  });
});

