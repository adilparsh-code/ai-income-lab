// Phase 4.5.3 — ROI-aware model router tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateModelEvidence,
  assessComplexity,
  selectModel,
  __modelCandidates,
} from '../model-router';

describe('complexity assessment', () => {
  it('classifies simple tasks as tier 1', () => {
    const result = assessComplexity({
      purpose: 'analytics.narrative',
      estimatedInputTokens: 200,
      outputFieldCount: 3,
      objective: 'summarize numbers',
    });
    assert.equal(result.complexity, 'SIMPLE');
    assert.equal(result.requiredTier, 1);
    assert.ok(result.reasons.length > 0);
  });

  it('classifies strategic purposes as complex (tier 2)', () => {
    const result = assessComplexity({
      purpose: 'product.concept',
      estimatedInputTokens: 300,
      outputFieldCount: 3,
      objective: 'create product concept',
    });
    assert.equal(result.complexity, 'COMPLEX');
    assert.equal(result.requiredTier, 2);
    assert.ok(result.reasons.some((r) => r.includes('strategic')));
  });

  it('classifies large structured outputs as complex', () => {
    const result = assessComplexity({
      purpose: 'research.findings',
      estimatedInputTokens: 200,
      outputFieldCount: 12,
      objective: 'extract many fields',
    });
    assert.equal(result.complexity, 'COMPLEX');
    assert.equal(result.requiredTier, 2);
  });

  it('classifies moderate tasks as tier 1', () => {
    const result = assessComplexity({
      purpose: 'research.findings',
      estimatedInputTokens: 2000,
      outputFieldCount: 6,
      objective: 'structured extraction with medium context',
    });
    assert.equal(result.complexity, 'MODERATE');
    assert.equal(result.requiredTier, 1);
  });
});

describe('internal evidence aggregation', () => {
  it('returns NO evidence when nothing is recorded (never invents quality)', () => {
    const evidence = aggregateModelEvidence([], 'gemini-2.5-flash', 'research.findings');
    assert.equal(evidence.attempts, 0);
    assert.equal(evidence.successRate, null);
  });

  it('aggregates success rates from internal outcomes', () => {
    const evidence = aggregateModelEvidence(
      [
        { model: 'gemini-2.5-flash', purpose: 'research.findings', success: true },
        { model: 'gemini-2.5-flash', purpose: 'research.findings', success: false },
        { model: 'gpt-4o-mini', purpose: 'research.findings', success: true }, // different model ignored
      ],
      'gemini-2.5-flash',
      'research.findings',
    );
    assert.equal(evidence.attempts, 2);
    assert.equal(evidence.successes, 1);
    assert.equal(evidence.successRate, 0.5);
  });
});

describe('model selection', () => {
  it('selects a tier-1 candidate for simple tasks when policy allows it', () => {
    const selection = selectModel({
      signals: { purpose: 'analytics.narrative', estimatedInputTokens: 200, outputFieldCount: 2, objective: 'classify' },
      allowedModels: ['gemini-2.5-flash', 'gpt-4o-mini'],
      plannedOutputTokens: 300,
      history: [],
    });
    assert.equal(selection.model, 'gpt-4o-mini');
    assert.equal(selection.tier, 1);
    assert.equal(selection.evidenceStatus, 'NO_EVIDENCE');
    assert.ok(selection.estimatedCostUsd >= 0);
  });

  it('keeps the default policy model when no tiered candidate matches', () => {
    const selection = selectModel({
      signals: { purpose: 'product.concept', estimatedInputTokens: 500, outputFieldCount: 2, objective: 'strategy' },
      allowedModels: ['unknown-model'],
      plannedOutputTokens: 300,
    });
    assert.equal(selection.model, 'default-policy-model');
    assert.equal(selection.evidenceStatus, 'NO_EVIDENCE');
  });

  it('prefers cheaper candidates and reports estimated cost', () => {
    const selection = selectModel({
      signals: { purpose: 'validation.tests', estimatedInputTokens: 1000, outputFieldCount: 5, objective: 'tests' },
      allowedModels: ['gemini-2.5-flash', 'gpt-4o-mini'],
      plannedOutputTokens: 500,
    });
    assert.equal(selection.model, 'gpt-4o-mini');
    const expected = (1000 / 1_000_000) * 0.15 + (500 / 1_000_000) * 0.6;
    assert.equal(selection.estimatedCostUsd, Math.round(expected * 1_000_000) / 1_000_000);
  });

  it('excludes models with recorded 0% success (>= 2 attempts) and says so', () => {
    const selection = selectModel({
      signals: { purpose: 'validation.tests', estimatedInputTokens: 1000, outputFieldCount: 5, objective: 'tests' },
      allowedModels: ['gemini-2.5-flash', 'gpt-4o-mini'],
      plannedOutputTokens: 500,
      history: [
        { model: 'gpt-4o-mini', purpose: 'validation.tests', success: false },
        { model: 'gpt-4o-mini', purpose: 'validation.tests', success: false },
        { model: 'gemini-2.5-flash', purpose: 'validation.tests', success: true },
      ],
    });
    assert.equal(selection.model, 'gemini-2.5-flash');
    assert.ok(selection.reasons.some((r) => r.includes('Internal evidence')));
  });

  it('does NOT penalize models with no evidence (absence is not failure)', () => {
    const selection = selectModel({
      signals: { purpose: 'validation.tests', estimatedInputTokens: 1000, outputFieldCount: 5, objective: 'tests' },
      allowedModels: ['gemini-2.5-flash', 'gpt-4o-mini'],
      plannedOutputTokens: 500,
      history: [{ model: 'gemini-2.5-flash', purpose: 'other.purpose', success: false }],
    });
    assert.equal(selection.model, 'gpt-4o-mini');
  });

  it('exposes the candidate table for policy review', () => {
    const candidates = __modelCandidates();
    assert.ok(candidates.length >= 2);
    const tiers = new Set(candidates.map((c) => c.tier));
    assert.ok(tiers.has(1) && tiers.has(2));
  });
});
