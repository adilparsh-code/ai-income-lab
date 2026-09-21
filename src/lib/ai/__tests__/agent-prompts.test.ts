// Offline unit tests for the Phase 4.2.3 provider-agnostic prompts,
// schemas, and defensive normalization. No DB, no network, no provider.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VALIDATION_AI_SCHEMA,
  PRODUCT_AI_SCHEMA,
  normalizeValidationAiOutput,
  normalizeProductAiOutput,
  buildValidationPrompt,
  buildProductPrompt,
  buildMockValidationOutput,
  buildMockProductOutput,
} from '../agent-prompts';
import { parseAndValidate } from '../schemas';

describe('validation schema + normalization', () => {
  it('mock validation output passes its own schema', () => {
    const mock = buildMockValidationOutput({
      validationObjective: 'test objective',
      opportunityExists: false,
    });
    const result = parseAndValidate(JSON.stringify(mock), VALIDATION_AI_SCHEMA);
    assert.equal(result.valid, true);
  });

  it('normalizes malformed AI output without fabricating data', () => {
    const normalized = normalizeValidationAiOutput({
      assumptions: 'not-an-array',
      risks: [{ risk: 'real risk', severity: 'EXTREME', likelihood: 42 }],
      tests: [{ name: '' }],
      experimentRecommendations: 'junk',
      successCriteria: [null, 123, 'valid criterion'],
      recommendation: 'SOMETHING_ELSE',
      confidence: 9.9,
    });
    assert.deepEqual(normalized.assumptions, []);
    assert.equal(normalized.risks.length, 1);
    assert.equal(normalized.risks[0].severity, 'MEDIUM'); // degraded default
    assert.equal(normalized.risks[0].likelihood, 1); // clamped into 0..1
    assert.equal(normalized.tests.length, 1);
    assert.equal(normalized.tests[0].method, 'MANUAL_RESEARCH'); // safe fallback
    assert.deepEqual(normalized.experimentRecommendations, []);
    assert.deepEqual(normalized.successCriteria, ['valid criterion']);
    assert.equal(normalized.recommendation, 'NEEDS_VALIDATION'); // safe default
    assert.equal(normalized.confidence, 1); // clamped into 0..1
  });

  it('keeps halal safety language in the prompt', () => {
    const prompt = buildValidationPrompt({
      validationObjective: 'test',
      halalConsiderations: [],
    });
    assert.ok(prompt.includes('halal'));
    assert.ok(prompt.includes('Do not invent market statistics'));
    assert.ok(prompt.includes('Return JSON only'));
  });
});

describe('product schema + normalization', () => {
  it('mock product output passes its own schema', () => {
    const mock = buildMockProductOutput({
      productObjective: 'test objective',
      productType: 'DIGITAL_PRODUCT',
    });
    const result = parseAndValidate(JSON.stringify(mock), PRODUCT_AI_SCHEMA);
    assert.equal(result.valid, true);
  });

  it('normalizes malformed AI output without inventing prices or markets', () => {
    const normalized = normalizeProductAiOutput({
      productConcept: { productNameHypothesis: '' },
      mvpFeatures: [{ name: 'Feature', priority: 'ULTRA' }],
      buildPhases: [{ phase: -3, name: 'Phase', tasks: 'not-array' }],
      monetizationModel: '',
      pricingHypothesis: 12345,
      confidence: -1,
    });
    assert.equal(normalized.productConcept.productNameHypothesis, 'Unnamed product concept');
    assert.equal(normalized.mvpFeatures[0].priority, 'IMPORTANT'); // degraded default
    assert.equal(normalized.buildPhases[0].phase, 1); // clamped
    assert.deepEqual(normalized.buildPhases[0].tasks, []); // coerced safely
    assert.equal(normalized.monetizationModel, 'ONE_TIME_PURCHASE'); // safe default
    assert.ok(normalized.pricingHypothesis.includes('TBD')); // no fabricated price
    assert.equal(normalized.confidence, 0); // clamped into 0..1
  });

  it('keeps anti-fabrication + halal language in the prompt', () => {
    const prompt = buildProductPrompt({
      productObjective: 'test',
      productType: 'SAAS',
      halalConsiderations: [],
    });
    assert.ok(prompt.includes('halal'));
    assert.ok(prompt.includes('Do not invent market statistics'));
    assert.ok(prompt.includes('Never state a market-verified price'));
  });
});

describe('mock output labelling', () => {
  it('labels mock validation output as MOCKED and deterministic', () => {
    const mock = buildMockValidationOutput({
      validationObjective: 'x',
      keyAssumptions: ['user assumption'],
      opportunityExists: true,
    });
    assert.ok(mock.tests.every((t) => t.name.includes('[MOCKED]')));
    assert.ok(mock.assumptions.includes('user assumption')); // user input preserved
    assert.equal(mock.recommendation, 'NEEDS_VALIDATION');
  });

  it('labels mock product output as MOCKED', () => {
    const mock = buildMockProductOutput({
      productObjective: 'build a widget',
      productType: 'TEMPLATE',
    });
    assert.ok(mock.productConcept.productNameHypothesis.includes('[MOCKED]'));
    assert.ok(mock.pricingHypothesis.includes('No revenue claims'));
  });
});
