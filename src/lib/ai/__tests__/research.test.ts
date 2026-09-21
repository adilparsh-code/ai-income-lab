// Phase 4.2.2 — Research Agent generation-layer tests.
// Verifies the provider-agnostic research helpers: schema, prompt, mapper,
// deterministic mock output, and the halal safety gate. Fully offline.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema, parseAndValidate } from '../schemas';
import {
  RESEARCH_SCHEMA,
  buildResearchPrompt,
  buildResearchResult,
  buildMockResearchOutput,
  evaluateHalalGate,
} from '../research';
import type { ResearchAiOutput } from '../research';

const VALID_OUTPUT: ResearchAiOutput = {
  summary: 'A niche opportunity for teacher printables.',
  demandSignals: ['Teachers search for ready-made worksheets.'],
  audienceHypotheses: ['Busy primary-school teachers.'],
  painPoints: ['No time to design worksheets.'],
  competitionObservations: ['Several existing marketplaces.'],
  monetizationOpportunities: ['Paid printable packs.'],
  risks: ['Content quality expectations are high.'],
  assumptions: ['Teachers pay for convenience.'],
  validationQuestions: ['Would a teacher buy a 10-pack for $9?'],
  nextAction: 'Validate with a landing page.',
};

describe('Research schema (Phase 4.2.2)', () => {
  it('accepts a complete valid research output', () => {
    const result = validateAgainstSchema(VALID_OUTPUT, RESEARCH_SCHEMA);
    assert.equal(result.valid, true);
  });

  it('rejects when a required field is missing', () => {
    const { summary: _summaryPicked, ...withoutSummary } = VALID_OUTPUT;
    // Silence lint; `_summaryPicked` is intentionally discarded to remove the field.
    void _summaryPicked;
    const result = validateAgainstSchema(withoutSummary, RESEARCH_SCHEMA);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /summary/.test(e)));
  });

  it('rejects when an array field is the wrong type', () => {
    const bad = { ...VALID_OUTPUT, demandSignals: 'not-an-array' };
    const result = validateAgainstSchema(bad, RESEARCH_SCHEMA);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /demandSignals/.test(e)));
  });

  it('rejects malformed JSON through parseAndValidate', () => {
    const result = parseAndValidate('{not json', RESEARCH_SCHEMA);
    assert.equal(result.valid, false);
  });

  it('accepts a valid research JSON document through parseAndValidate', () => {
    const result = parseAndValidate(JSON.stringify(VALID_OUTPUT), RESEARCH_SCHEMA);
    assert.equal(result.valid, true);
  });
});
describe('buildResearchPrompt', () => {
  it('includes the objective and market category', () => {
    const prompt = buildResearchPrompt({
      researchObjective: 'Find a kids education niche',
      marketCategory: 'Educational Content',
      halalConsiderations: [],
    });
    assert.ok(prompt.includes('Find a kids education niche'));
    assert.ok(prompt.includes('Educational Content'));
  });

  it('includes the halal screening instruction', () => {
    const prompt = buildResearchPrompt({
      researchObjective: 'research',
      halalConsiderations: [],
    });
    assert.ok(prompt.toLowerCase().includes('impermissible'));
    assert.ok(prompt.toLowerCase().includes('gambling'));
  });

  it('includes pre-existing halal considerations and opportunity context', () => {
    const prompt = buildResearchPrompt({
      researchObjective: 'research',
      halalConsiderations: ['Human review required for this topic.'],
      opportunity: { id: 'o1', title: 'My Idea', halalStatus: 'REVIEW_REQUIRED' },
    });
    assert.ok(prompt.includes('Human review required for this topic.'));
    assert.ok(prompt.includes('My Idea'));
    assert.ok(prompt.includes('REVIEW_REQUIRED'));
  });
});

describe('buildResearchResult', () => {
  it('maps validated AI output into a normalized ResearchResult', () => {
    const result = buildResearchResult({
      researchObjective: 'kids education',
      research: VALID_OUTPUT,
      halalConsiderations: ['Screening: ok'],
      overallConfidence: 0.5,
      capabilityStatus: 'LIVE',
      isMocked: false,
    });
    assert.equal(result.researchObjective, 'kids education');
    assert.equal(result.capabilityStatus, 'LIVE');
    assert.equal(result.overallConfidence, 0.5);
    assert.deepEqual(result.risks, VALID_OUTPUT.risks);
    assert.deepEqual(result.competitors, VALID_OUTPUT.competitionObservations);
    assert.deepEqual(result.demandIndicators, VALID_OUTPUT.demandSignals);
    assert.deepEqual(result.monetizationObservations, VALID_OUTPUT.monetizationOpportunities);
    assert.ok(result.findings.some((f) => f.content === VALID_OUTPUT.summary));
    assert.ok(result.findings.some((f) => f.content.includes(VALID_OUTPUT.audienceHypotheses[0])));
    assert.ok(result.findings.some((f) => f.content.includes(VALID_OUTPUT.painPoints[0])));
    assert.equal(
      result.signals.length,
      VALID_OUTPUT.demandSignals.length +
        VALID_OUTPUT.risks.length +
        VALID_OUTPUT.monetizationOpportunities.length +
        VALID_OUTPUT.competitionObservations.length
    );
  });

  it('marks live mode signals as not mocked', () => {
    const result = buildResearchResult({
      researchObjective: 'x',
      research: VALID_OUTPUT,
      halalConsiderations: [],
      overallConfidence: 0.5,
      capabilityStatus: 'LIVE',
      isMocked: false,
    });
    assert.ok(result.signals.length > 0);
    assert.equal(result.signals.every((s) => s.isMocked === false), true);
  });

  it('never emits VERIFIED_DATA (all evidence is AI_INFERENCE)', () => {
    const result = buildResearchResult({
      researchObjective: 'x',
      research: VALID_OUTPUT,
      halalConsiderations: [],
      overallConfidence: 0.5,
      capabilityStatus: 'LIVE',
      isMocked: false,
    });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('VERIFIED_DATA'));
    assert.ok(result.findings.every((f) => f.evidenceType === 'AI_INFERENCE'));
    assert.ok(result.signals.every((s) => s.evidenceType === 'AI_INFERENCE'));
  });
});

describe('buildMockResearchOutput', () => {
  it('produces schema-valid, deterministic output', () => {
    const a = buildMockResearchOutput({ researchObjective: 'niche', marketCategory: 'Education' });
    const b = buildMockResearchOutput({ researchObjective: 'niche', marketCategory: 'Education' });
    assert.deepEqual(a, b);
    assert.equal(validateAgainstSchema(a, RESEARCH_SCHEMA).valid, true);
    assert.ok(a.summary.includes('[MOCKED]'));
  });
});

describe('evaluateHalalGate', () => {
  it('passes a clearly halal topic', () => {
    assert.equal(evaluateHalalGate({ researchObjective: 'Research low-carb recipe ebook market' }).status, 'OK');
  });
  it('blocks a NOT_ALLOWED topic (gambling)', () => {
    assert.equal(evaluateHalalGate({ researchObjective: 'Market for online gambling site' }).status, 'BLOCKED');
  });
  it('requires review for a REVIEW_REQUIRED topic (crypto trading)', () => {
    assert.equal(evaluateHalalGate({ researchObjective: 'Crypto trading signal service' }).status, 'REVIEW');
  });
  it('blocks when the linked opportunity is NOT_ALLOWED', () => {
    assert.equal(evaluateHalalGate({ researchObjective: 'benign topic', opportunityHalalStatus: 'NOT_ALLOWED' }).status, 'BLOCKED');
  });
  it('requires review when the linked opportunity is REVIEW_REQUIRED', () => {
    assert.equal(evaluateHalalGate({ researchObjective: 'benign topic', opportunityHalalStatus: 'REVIEW_REQUIRED' }).status, 'REVIEW');
  });
});