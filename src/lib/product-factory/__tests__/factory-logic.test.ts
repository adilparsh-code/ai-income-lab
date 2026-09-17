// Offline unit tests for the Product Factory pure logic (factory-logic.ts).
// No DB, no network, no AI provider — hermetic by construction.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFactoryRunView,
  looksLikeFactoryRun,
  type FactoryRunLike,
} from '../factory-logic';
import type { PipelineStepSummary } from '@/lib/ruflo/pipeline-logic';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function step(overrides: Partial<PipelineStepSummary> & { stage: PipelineStepSummary['stage'] }): PipelineStepSummary {
  return {
    executed: true,
    success: true,
    note: '',
    evidenceType: 'AI_INFERENCE',
    fallbackUsed: false,
    durationMs: 10,
    ...overrides,
  };
}

function baseRun(overrides: Partial<FactoryRunLike> = {}): FactoryRunLike {
  return {
    status: 'COMPLETED',
    objective: 'Design a product for: test opportunity',
    opportunityId: 'opp-1',
    humanReviewRequired: false,
    reasoning: 'Bounded pipeline finished: RESEARCH → VALIDATION → PRODUCT.',
    steps: [],
    findings: {
      missingEvidence: [],
      nextActions: [],
      provenanceCounts: {},
      aiTotals: { liveSteps: 0, fallbackSteps: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    },
    ...overrides,
  };
}

const MOCK_RESEARCH_OUTPUT = {
  sources: [
    {
      url: 'https://example.com/a',
      domain: 'example.com',
      title: 'Verified page',
      evidenceType: 'VERIFIED_DATA',
      retrievedAt: '2026-09-17T10:00:00.000Z',
      excerpt: 'Fetched page text',
      httpStatus: 200,
      contentType: 'text/html',
      contentLength: 1024,
    },
    {
      url: 'https://example.com/b',
      domain: 'example.com',
      title: 'Discovery lead',
      evidenceType: 'SEARCH_DISCOVERY',
      retrievedAt: '2026-09-17T10:00:00.000Z',
      snippet: 'Search snippet only',
    },
    {
      url: 'not-a-url',
      // Invalid/unknown provenance — must be dropped, never relabelled.
      evidenceType: 'AI_INFERENCE',
    },
  ],
  sourceResearch: {
    status: 'OK',
    searchProviderId: 'searxng',
    servedFrom: 'live',
    discoveryCount: 1,
    verifiedCount: 1,
    reasoning: 'Discovered 2 source(s).',
    ranAt: '2026-09-17T10:00:00.000Z',
  },
};

const MOCK_VALIDATION_OUTPUT = {
  recommendation: 'NEEDS_VALIDATION',
  confidence: 0.55,
  assumptions: ['Assumption: demand exists'],
  prioritizedRisks: [{ risk: 'Demand risk', severity: 'HIGH', likelihood: 0.6 }],
  validationTests: [{ name: 'Survey', method: 'SURVEY', description: 'Test demand' }],
  successCriteria: ['10 survey responses'],
  failureCriteria: ['<2 responses'],
  evidenceRequirements: ['Survey response data'],
};

const MOCK_PRODUCT_OUTPUT = {
  productConcept: {
    productNameHypothesis: 'Homeschool Planner',
    oneLineDescription: 'A printable planner.',
    customer: 'Homeschool parents',
    problem: 'Planning is messy',
    proposedSolution: 'Structured PDF planner',
    coreValueProposition: 'Save planning time',
    differentiationHypothesis: 'Focused format',
    productFormat: 'printable pdf',
    primaryUseCase: 'Weekly planning',
    evidenceType: 'AI_INFERENCE',
  },
  mvpFeatures: [
    { name: 'Core planner', description: 'Main planner', priority: 'ESSENTIAL' },
  ],
  buildPhases: [
    { phase: 1, name: 'Foundation', tasks: ['Setup'], dependencies: [], expectedOutput: 'Repo ready', risk: 'Delays' },
  ],
  monetizationModel: 'ONE_TIME_PURCHASE',
  monetizationRationale: 'Hypothesis rationale',
  pricingHypothesis: 'TBD',
  monetizationAssumptions: ['Willingness to pay'],
  monetizationRisks: ['Price rejection'],
  evidenceNeeded: ['Willingness-to-pay survey'],
  distributionChannels: ['Organic search'],
  contentStrategy: 'Educational content',
  landingPageConcept: 'Single CTA page',
  conversionPath: ['Visit', 'Purchase'],
  risks: ['Demand risk'],
  assumptions: ['Market exists'],
  confidence: 0.5,
};

function fullRun(): FactoryRunLike {
  return baseRun({
    steps: [
      step({ stage: 'RESEARCH', output: MOCK_RESEARCH_OUTPUT, capabilityStatus: 'MOCKED' }),
      step({ stage: 'VALIDATION', output: MOCK_VALIDATION_OUTPUT, capabilityStatus: 'MOCKED' }),
      step({ stage: 'PRODUCT', output: MOCK_PRODUCT_OUTPUT, capabilityStatus: 'MOCKED' }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Provenance separation + no-fabrication
// ---------------------------------------------------------------------------

describe('buildFactoryRunView: evidence provenance', () => {
  const view = buildFactoryRunView(fullRun());

  it('keeps VERIFIED_DATA and SEARCH_DISCOVERY separate', () => {
    const verified = view.evidence.sources.filter((s) => s.evidenceType === 'VERIFIED_DATA');
    const discovery = view.evidence.sources.filter((s) => s.evidenceType === 'SEARCH_DISCOVERY');
    assert.equal(verified.length, 1);
    assert.equal(discovery.length, 1);
    assert.equal(view.provenance.sourceCounts.VERIFIED_DATA, 1);
    assert.equal(view.provenance.sourceCounts.SEARCH_DISCOVERY, 1);
  });

  it('preserves fetch metadata on verified sources only', () => {
    const verified = view.evidence.sources.find((s) => s.evidenceType === 'VERIFIED_DATA');
    const discovery = view.evidence.sources.find((s) => s.evidenceType === 'SEARCH_DISCOVERY');
    assert.equal(verified?.httpStatus, 200);
    assert.equal(verified?.contentLength, 1024);
    assert.equal(discovery?.httpStatus, undefined);
    assert.equal(discovery?.excerpt, undefined);
    assert.equal(discovery?.snippet, 'Search snippet only');
  });

  it('drops items with unknown provenance instead of relabelling them', () => {
    assert.equal(view.evidence.sources.length, 2);
    assert.ok(view.evidence.sources.every((s) => s.evidenceType === 'VERIFIED_DATA' || s.evidenceType === 'SEARCH_DISCOVERY'));
  });

  it('never upgrades AI or discovery content into VERIFIED_DATA', () => {
    for (const source of view.evidence.sources) {
      if (source.evidenceType === 'SEARCH_DISCOVERY') {
        assert.equal(source.excerpt, undefined);
        assert.equal(source.httpStatus, undefined);
      }
    }
    // Product concept stays whatever the agent labelled it (AI_INFERENCE).
    assert.equal(view.product.concept?.evidenceType, 'AI_INFERENCE');
  });

  it('reports the research report verbatim without inventing counts', () => {
    assert.equal(view.evidence.report?.status, 'OK');
    assert.equal(view.evidence.report?.searchProviderId, 'searxng');
    assert.equal(view.evidence.report?.servedFrom, 'live');
  });
});

describe('buildFactoryRunView: no fabricated sections', () => {
  it('marks product sections absent when the PRODUCT step did not run', () => {
    const view = buildFactoryRunView(
      baseRun({
        status: 'FAILED',
        reasoning: 'Research failed.',
        steps: [step({ stage: 'RESEARCH', success: false, output: { error: 'fetch failed' } })],
      }),
    );
    assert.equal(view.product.present, false);
    assert.equal(view.product.concept, null);
    assert.equal(view.product.monetization, null);
    assert.equal(view.product.distribution, null);
    assert.equal(view.evidence.sources.length, 0);
    assert.equal(view.evidence.report, null);
    const states = Object.fromEntries(view.workflow.map((w) => [w.key, w.state]));
    assert.equal(states['CONCEPT'], 'PENDING');
    assert.equal(states['MVP'], 'PENDING');
    assert.equal(states['MONETIZATION'], 'PENDING');
  });

  it('reports empty validation as null rather than inventing a plan', () => {
    const view = buildFactoryRunView(baseRun({ steps: [] }));
    assert.equal(view.validation, null);
  });

  it('does not invent missing-evidence items for a complete run with evidence', () => {
    const view = buildFactoryRunView(fullRun());
    // The product's own evidenceNeeded entries are preserved verbatim;
    // nothing else is fabricated.
    assert.ok(view.missingEvidence.includes('Willingness-to-pay survey'));
    assert.ok(!view.missingEvidence.some((m) => m.includes('fabricated')));
  });
});

// ---------------------------------------------------------------------------
// Missing-evidence rules
// ---------------------------------------------------------------------------

describe('buildFactoryRunView: missing evidence', () => {
  it('states explicitly when research never ran', () => {
    const view = buildFactoryRunView(baseRun({ steps: [], status: 'FAILED' }));
    assert.ok(view.missingEvidence.some((m) => m.includes('Research has not run')));
  });

  it('flags discovery-only chains as having no verified data', () => {
    const view = buildFactoryRunView(
      baseRun({
        steps: [
          step({
            stage: 'RESEARCH',
            output: {
              sources: [MOCK_RESEARCH_OUTPUT.sources[1]],
            },
          }),
        ],
      }),
    );
    assert.ok(
      view.missingEvidence.some((m) => m.includes('No VERIFIED_DATA sources')),
    );
  });

  it('surfaces NOT_CONFIGURED research honestly', () => {
    const view = buildFactoryRunView(
      baseRun({
        steps: [
          step({
            stage: 'RESEARCH',
            output: {
              sources: [],
              sourceResearch: { status: 'NOT_CONFIGURED', servedFrom: 'none', reasoning: 'no provider' },
            },
          }),
        ],
      }),
    );
    assert.ok(view.missingEvidence.some((m) => m.includes('not configured')));
  });

  it('merges persisted run findings without duplication', () => {
    const view = buildFactoryRunView(
      baseRun({
        steps: [step({ stage: 'RESEARCH', output: MOCK_RESEARCH_OUTPUT })],
        findings: {
          missingEvidence: ['Willingness-to-pay survey'],
          nextActions: ['Run validation test: Survey'],
          provenanceCounts: {},
          aiTotals: { liveSteps: 0, fallbackSteps: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        },
      }),
    );
    const occurrences = view.missingEvidence.filter((m) => m === 'Willingness-to-pay survey').length;
    assert.equal(occurrences, 1);
    assert.ok(view.nextActions.includes('Run validation test: Survey'));
  });

  it('does not report missing-evidence notes for a hard-blocked run beyond the block itself', () => {
    const view = buildFactoryRunView(baseRun({ status: 'BLOCKED', steps: [] }));
    assert.ok(!view.missingEvidence.some((m) => m.includes('Research has not run')));
    assert.ok(view.missingEvidence.some((m) => m.includes('blocked by halal compliance')));
  });
});

// ---------------------------------------------------------------------------
// Data-mode marking
// ---------------------------------------------------------------------------

describe('buildFactoryRunView: data mode', () => {
  it('marks deterministic runs as MOCKED', () => {
    const view = buildFactoryRunView(fullRun());
    assert.equal(view.dataMode, 'MOCKED');
  });

  it('marks runs with a live (non-fallback) step as LIVE', () => {
    const view = buildFactoryRunView(
      baseRun({
        steps: [
          step({ stage: 'RESEARCH', output: MOCK_RESEARCH_OUTPUT, capabilityStatus: 'LIVE' }),
          step({ stage: 'VALIDATION', output: MOCK_VALIDATION_OUTPUT, capabilityStatus: 'LIVE' }),
          step({ stage: 'PRODUCT', output: MOCK_PRODUCT_OUTPUT, capabilityStatus: 'LIVE' }),
        ],
      }),
    );
    assert.equal(view.dataMode, 'LIVE');
  });

  it('does not call a run LIVE when its live step fell back', () => {
    const view = buildFactoryRunView(
      baseRun({
        steps: [
          step({ stage: 'RESEARCH', output: MOCK_RESEARCH_OUTPUT, capabilityStatus: 'LIVE', fallbackUsed: true }),
        ],
      }),
    );
    assert.equal(view.dataMode, 'MOCKED');
  });

  it('marks runs with no executed steps as PLANNED', () => {
    const view = buildFactoryRunView(baseRun({ steps: [], status: 'BLOCKED' }));
    assert.equal(view.dataMode, 'PLANNED');
  });
});

// ---------------------------------------------------------------------------
// Workflow states: halal blocking, review, failure, pending
// ---------------------------------------------------------------------------

describe('buildFactoryRunView: halal blocking', () => {
  const view = buildFactoryRunView(baseRun({ status: 'BLOCKED', steps: [] }));

  it('marks every step BLOCKED with zero execution', () => {
    assert.ok(view.workflow.every((w) => w.state === 'BLOCKED'));
  });

  it('explains that nothing ran', () => {
    assert.ok(view.workflow.every((w) => w.detail?.includes('Blocked by halal compliance')));
  });

  it('reports no product and no evidence', () => {
    assert.equal(view.product.present, false);
    assert.equal(view.evidence.sources.length, 0);
  });
});

describe('buildFactoryRunView: human review pause', () => {
  const view = buildFactoryRunView(baseRun({ status: 'HUMAN_REVIEW', steps: [] }));

  it('marks steps PENDING (paused, not failed)', () => {
    assert.ok(view.workflow.every((w) => w.state === 'PENDING'));
  });

  it('surfaces the review flag', () => {
    assert.equal(view.humanReviewRequired, true);
  });
});

describe('buildFactoryRunView: partial failure propagation', () => {
  const view = buildFactoryRunView(
    baseRun({
      status: 'PARTIAL',
      steps: [
        step({ stage: 'RESEARCH', output: MOCK_RESEARCH_OUTPUT }),
        step({ stage: 'VALIDATION', success: false, output: {}, note: 'validation failed' }),
      ],
    }),
  );

  it('marks the failed stage FAILED and downstream stages PENDING', () => {
    const states = Object.fromEntries(view.workflow.map((w) => [w.key, w.state]));
    assert.equal(states['EVIDENCE'], 'READY');
    assert.equal(states['VALIDATION'], 'FAILED');
    assert.equal(states['CONCEPT'], 'PENDING');
  });
});

// ---------------------------------------------------------------------------
// Malformed / hostile inputs (no crashes, no invention)
// ---------------------------------------------------------------------------

describe('buildFactoryRunView: malformed inputs', () => {
  it('handles a run with missing steps and findings', () => {
    const view = buildFactoryRunView({ status: 'COMPLETED', objective: 'x' });
    assert.equal(view.status, 'COMPLETED');
    assert.equal(view.product.present, false);
    assert.equal(view.dataMode, 'PLANNED');
  });

  it('ignores non-object step outputs', () => {
    const view = buildFactoryRunView(
      baseRun({
        steps: [
          step({ stage: 'RESEARCH', output: 'not-an-object' as unknown as Record<string, unknown> }),
          step({ stage: 'VALIDATION', output: 42 as unknown as Record<string, unknown> }),
        ],
      }),
    );
    assert.equal(view.evidence.sources.length, 0);
    assert.equal(view.validation, null);
  });

  it('coerces malformed product fields to explicit placeholders, not invented facts', () => {
    const view = buildFactoryRunView(
      baseRun({
        steps: [step({ stage: 'PRODUCT', output: { productConcept: { productNameHypothesis: '' } } })],
      }),
    );
    assert.equal(view.product.present, false);
  });
});

// ---------------------------------------------------------------------------
// Persisted-run classification
// ---------------------------------------------------------------------------

describe('looksLikeFactoryRun', () => {
  it('accepts a run whose executed stages are all factory stages', () => {
    assert.equal(
      looksLikeFactoryRun({
        steps: [
          { stage: 'RESEARCH', executed: true },
          { stage: 'VALIDATION', executed: true },
          { stage: 'PRODUCT', executed: true },
        ],
      }),
      true,
    );
  });

  it('rejects full pipeline runs containing EXPERIMENT/TRACKING', () => {
    assert.equal(
      looksLikeFactoryRun({
        steps: [
          { stage: 'RESEARCH', executed: true },
          { stage: 'EXPERIMENT', executed: true },
        ],
      }),
      false,
    );
  });

  it('rejects corrupt payloads', () => {
    assert.equal(looksLikeFactoryRun(null), false);
    assert.equal(looksLikeFactoryRun('nope'), false);
    assert.equal(looksLikeFactoryRun({}), false);
    assert.equal(looksLikeFactoryRun({ steps: 'not-an-array' }), false);
    assert.equal(looksLikeFactoryRun({ steps: [] }), false);
  });
});
