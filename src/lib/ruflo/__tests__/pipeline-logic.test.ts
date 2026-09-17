// Offline unit tests for the Phase 5 pipeline logic (pure module).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_ORDER,
  selectExperimentPlan,
  computeStageProgress,
  aggregateRunStatus,
  collectFindings,
  classifyRunProvenance,
  type PipelineStepSummary,
} from '../pipeline-logic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(overrides: Partial<PipelineStepSummary> = {}): PipelineStepSummary {
  return {
    stage: 'RESEARCH',
    executed: true,
    success: true,
    note: 'ok',
    evidenceType: 'AI_INFERENCE',
    fallbackUsed: false,
    durationMs: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// selectExperimentPlan
// ---------------------------------------------------------------------------

describe('selectExperimentPlan', () => {
  it('returns [] for null/undefined/empty input', () => {
    assert.deepEqual(selectExperimentPlan(null), []);
    assert.deepEqual(selectExperimentPlan(undefined), []);
    assert.deepEqual(selectExperimentPlan({}), []);
  });

  it('prefers experimentRecommendations and sorts by priority', () => {
    const plan = selectExperimentPlan({
      experimentRecommendations: [
        { experimentName: 'B', hypothesis: 'h2', priority: 2 },
        { experimentName: 'A', hypothesis: 'h1', priority: 1 },
      ],
      validationTests: [{ name: 'should be ignored' }],
    });
    assert.equal(plan.length, 2);
    assert.equal(plan[0].name, 'A');
    assert.equal(plan[1].name, 'B');
    assert.ok(plan.every((e) => e.source === 'VALIDATION_EXPERIMENT'));
    assert.ok(plan.every((e) => e.status === 'PLANNED'));
  });

  it('falls back to validationTests when no recommendations exist', () => {
    const plan = selectExperimentPlan({
      validationTests: [
        { name: 'Test A', method: 'SURVEY', estimatedEffort: 'LOW', priority: 2 },
        { name: 'Test B', method: 'INTERVIEW', estimatedEffort: 'HIGH', priority: 1 },
      ],
    });
    assert.equal(plan.length, 2);
    assert.ok(plan.every((e) => e.source === 'VALIDATION_TEST'));
    assert.equal(plan[0].name, 'Test B');
    // Tests carry no thresholds — they must stay null, never invented.
    assert.equal(plan[0].metric, null);
    assert.equal(plan[0].successThreshold, null);
    assert.equal(plan[0].failureThreshold, null);
  });

  it('caps the plan at maxExperiments', () => {
    const plan = selectExperimentPlan({
      experimentRecommendations: [1, 2, 3, 4, 5].map((i) => ({
        experimentName: `E${i}`,
        priority: i,
      })),
    }, 3);
    assert.equal(plan.length, 3);
    assert.deepEqual(plan.map((e) => e.name), ['E1', 'E2', 'E3']);
  });

  it('passes thresholds through verbatim and keeps missing ones null', () => {
    const plan = selectExperimentPlan({
      experimentRecommendations: [
        { experimentName: 'With', metric: 'CTR', successThreshold: 0.05, failureThreshold: 0.01 },
        { experimentName: 'Without' },
      ],
    });
    assert.equal(plan[0].metric, 'CTR');
    assert.equal(plan[0].successThreshold, 0.05);
    assert.equal(plan[0].failureThreshold, 0.01);
    assert.equal(plan[1].metric, null);
    assert.equal(plan[1].successThreshold, null);
    assert.equal(plan[1].failureThreshold, null);
  });

  it('defaults invalid effort/priority safely and skips non-object entries', () => {
    const plan = selectExperimentPlan({
      experimentRecommendations: [
        'not-an-object',
        { experimentName: 'Valid', estimatedEffort: 'whenever', priority: -3 },
      ],
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].effort, 'MEDIUM');
    assert.equal(plan[0].priority, 1); // clamped to >= 1
  });
});

// ---------------------------------------------------------------------------
// computeStageProgress
// ---------------------------------------------------------------------------

describe('computeStageProgress', () => {
  it('marks every stage SUCCEEDED when all executed successfully', () => {
    const steps = PIPELINE_ORDER.map((stage) => step({ stage }));
    const progress = computeStageProgress(steps);
    assert.equal(progress.length, 5);
    assert.ok(progress.every((p) => p.state === 'SUCCEEDED'));
  });

  it('marks a failed executed stage FAILED and later stages PENDING (fail-closed)', () => {
    const progress = computeStageProgress([
      step({ stage: 'RESEARCH', success: true }),
      step({ stage: 'VALIDATION', success: false, note: 'boom' }),
    ]);
    assert.equal(progress[0].state, 'SUCCEEDED');
    assert.equal(progress[1].state, 'FAILED');
    assert.equal(progress[1].note, 'boom');
    assert.ok(progress.slice(2).every((p) => p.state === 'PENDING'));
  });

  it('marks unexecuted stages between executed ones SKIPPED', () => {
    const progress = computeStageProgress([
      step({ stage: 'RESEARCH' }),
      step({ stage: 'PRODUCT' }),
    ]);
    assert.equal(progress[1].state, 'SKIPPED'); // VALIDATION never ran
    assert.equal(progress[2].state, 'SUCCEEDED'); // PRODUCT ran
    assert.ok(progress.slice(3).every((p) => p.state === 'PENDING'));
  });

  it('returns all PENDING for no executed steps', () => {
    const progress = computeStageProgress([]);
    assert.ok(progress.every((p) => p.state === 'PENDING'));
  });
});

// ---------------------------------------------------------------------------
// aggregateRunStatus
// ---------------------------------------------------------------------------

describe('aggregateRunStatus', () => {
  const ok = (stage: PipelineStepSummary['stage']) => step({ stage });

  it('BLOCKED wins over everything else', () => {
    assert.equal(
      aggregateRunStatus([ok('RESEARCH')], { blocked: true, humanReviewRequired: true }),
      'BLOCKED',
    );
  });

  it('HUMAN_REVIEW comes before failure analysis', () => {
    assert.equal(
      aggregateRunStatus([ok('RESEARCH')], { blocked: false, humanReviewRequired: true }),
      'HUMAN_REVIEW',
    );
  });

  it('FAILED when nothing executed', () => {
    assert.equal(aggregateRunStatus([], { blocked: false, humanReviewRequired: false }), 'FAILED');
  });

  it('COMPLETED when every executed step succeeded', () => {
    assert.equal(
      aggregateRunStatus([ok('RESEARCH'), ok('VALIDATION')], { blocked: false, humanReviewRequired: false }),
      'COMPLETED',
    );
  });

  it('PARTIAL when some executed steps failed', () => {
    assert.equal(
      aggregateRunStatus(
        [ok('RESEARCH'), step({ stage: 'VALIDATION', success: false })],
        { blocked: false, humanReviewRequired: false },
      ),
      'PARTIAL',
    );
  });

  it('FAILED when every executed step failed', () => {
    assert.equal(
      aggregateRunStatus(
        [step({ stage: 'RESEARCH', success: false })],
        { blocked: false, humanReviewRequired: false },
      ),
      'FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// collectFindings
// ---------------------------------------------------------------------------

describe('collectFindings', () => {
  it('collects risks from prioritized and plain shapes with severity suffixes', () => {
    const findings = collectFindings([
      step({
        stage: 'VALIDATION',
        output: {
          prioritizedRisks: [
            { risk: 'Demand risk', severity: 'HIGH' },
            { risk: 'Demand risk', severity: 'HIGH' }, // duplicate — deduped
          ],
        },
      }),
      step({
        stage: 'PRODUCT',
        output: { risks: ['Build risk', { risk: 'Pricing risk', severity: 'medium' }] },
      }),
    ]);
    assert.deepEqual(findings.risks, [
      'Demand risk [HIGH]',
      'Build risk',
      'Pricing risk [MEDIUM]',
    ]);
  });

  it('collects assumptions, missing evidence, and analytics warnings without fabricating', () => {
    const findings = collectFindings([
      step({
        stage: 'VALIDATION',
        output: {
          assumptions: ['Users want this'],
          evidenceRequirements: ['Interview notes'],
        },
      }),
      step({
        stage: 'PRODUCT',
        output: { assumptions: ['Users want this'], evidenceNeeded: ['WTP survey'] },
      }),
      step({
        stage: 'TRACKING',
        output: { dataSummary: { insufficientDataWarnings: ['No revenue records'] } },
      }),
    ]);
    assert.deepEqual(findings.assumptions, ['Users want this']);
    assert.deepEqual(findings.missingEvidence, ['Interview notes', 'WTP survey', 'No revenue records']);
  });

  it('derives next actions per stage from actual outputs only', () => {
    const findings = collectFindings([
      step({
        stage: 'VALIDATION',
        output: { validationTests: [{ name: 'Landing page test' }] },
      }),
      step({
        stage: 'PRODUCT',
        output: {
          mvpFeatures: [
            { name: 'Auth', priority: 'IMPORTANT' },
            { name: 'Core flow', priority: 'ESSENTIAL' },
          ],
        },
      }),
      step({
        stage: 'EXPERIMENT',
        output: { experimentPlan: [{ name: 'Price test' }] },
      }),
      step({
        stage: 'TRACKING',
        output: { nextBestActions: [{ action: 'Record revenue for product X' }] },
      }),
    ]);
    assert.deepEqual(findings.nextActions, [
      'Run validation test: Landing page test',
      'Build MVP feature: Core flow',
      'Run experiment: Price test',
      'Record revenue for product X',
    ]);
  });

  it('rolls up provenance counts and AI usage totals', () => {
    const findings = collectFindings([
      step({
        stage: 'RESEARCH',
        evidenceType: 'AI_INFERENCE',
        output: { evidence: [{ type: 'AI_INFERENCE' }, { type: 'USER_ENTERED' }] },
        aiUsage: {
          provider: 'gemini', model: 'gemini-1', inputTokens: 100, outputTokens: 50,
          estimatedCostUsd: 0.001, latencyMs: 10,
        },
      }),
      step({ stage: 'VALIDATION', evidenceType: 'AI_INFERENCE', fallbackUsed: true }),
    ]);
    assert.equal(findings.provenanceCounts['AI_INFERENCE'], 3); // 2 step + 1 evidence
    assert.equal(findings.provenanceCounts['USER_ENTERED'], 1);
    assert.equal(findings.aiTotals.liveSteps, 1);
    assert.equal(findings.aiTotals.fallbackSteps, 1);
    assert.equal(findings.aiTotals.inputTokens, 100);
    assert.equal(findings.aiTotals.outputTokens, 50);
    assert.equal(findings.aiTotals.estimatedCostUsd, 0.001);
  });

  it('caps each finding category at 8 entries', () => {
    const findings = collectFindings([
      step({
        stage: 'PRODUCT',
        output: { risks: Array.from({ length: 20 }, (_, i) => `Risk ${i + 1}`) },
      }),
    ]);
    assert.equal(findings.risks.length, 8);
    assert.equal(findings.risks[7], 'Risk 8');
  });
});

// ---------------------------------------------------------------------------
// classifyRunProvenance
// ---------------------------------------------------------------------------

describe('classifyRunProvenance', () => {
  it('AI_INFERENCE when nothing executed', () => {
    assert.equal(classifyRunProvenance([]), 'AI_INFERENCE');
  });

  it('MOCKED when every executed step is mocked/fallback', () => {
    assert.equal(
      classifyRunProvenance([
        step({ stage: 'RESEARCH', capabilityStatus: 'MOCKED' }),
        step({ stage: 'VALIDATION', capabilityStatus: 'LIVE', fallbackUsed: true }),
      ]),
      'MOCKED',
    );
  });

  it('VERIFIED_DATA only when every executed step reports VERIFIED_DATA', () => {
    assert.equal(
      classifyRunProvenance([
        step({ stage: 'RESEARCH', evidenceType: 'VERIFIED_DATA' }),
        step({ stage: 'VALIDATION', evidenceType: 'VERIFIED_DATA' }),
      ]),
      'VERIFIED_DATA',
    );
    assert.equal(
      classifyRunProvenance([
        step({ stage: 'RESEARCH', evidenceType: 'VERIFIED_DATA' }),
        step({ stage: 'VALIDATION', evidenceType: 'AI_INFERENCE' }),
      ]),
      'AI_INFERENCE',
    );
  });
});
