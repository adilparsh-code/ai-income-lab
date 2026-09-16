// Offline unit tests for the Phase 4.2.4 Ruflo lifecycle model (pure logic).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLifecycleStage,
  summarizePortfolio,
  LIFECYCLE_ORDER,
} from '../lifecycle';

function baseInput(overrides: Partial<Parameters<typeof deriveLifecycleStage>[0]> = {}) {
  return {
    opportunity: {
      id: 'opp-1',
      title: 'Test Opportunity',
      status: 'IDEA',
      halalStatus: 'HALAL',
      overallScore: 70,
    },
    experiments: 0,
    products: 0,
    revenues: 0,
    completedExperimentDecisions: 0,
    positiveExperimentDecisions: 0,
    publishedProducts: 0,
    hasResearchLog: false,
    hasValidationLog: false,
    ...overrides,
  };
}

describe('deriveLifecycleStage', () => {
  it('starts at RESEARCH when no evidence exists', () => {
    const view = deriveLifecycleStage(baseInput());
    assert.equal(view.currentStage, 'RESEARCH');
    assert.ok(view.rationale.includes('RESEARCH'));
  });

  it('advances to VALIDATE with experiments but no decisions', () => {
    const view = deriveLifecycleStage(baseInput({ experiments: 2 }));
    assert.equal(view.currentStage, 'VALIDATE');
    assert.equal(view.stages.find((s) => s.stage === 'VALIDATE')?.isCurrent, true);
  });

  it('moves to DECIDE when experiments completed without SCALE', () => {
    const view = deriveLifecycleStage(baseInput({
      experiments: 1,
      completedExperimentDecisions: 1,
    }));
    assert.equal(view.currentStage, 'DECIDE');
  });

  it('moves to BUILD after a SCALE decision', () => {
    const view = deriveLifecycleStage(baseInput({
      experiments: 1,
      completedExperimentDecisions: 1,
      positiveExperimentDecisions: 1,
    }));
    assert.equal(view.currentStage, 'BUILD');
  });

  it('moves to PUBLISH when a product exists but is unpublished', () => {
    const view = deriveLifecycleStage(baseInput({
      experiments: 1,
      completedExperimentDecisions: 1,
      positiveExperimentDecisions: 1,
      products: 1,
    }));
    assert.equal(view.currentStage, 'PUBLISH');
  });

  it('moves to MARKET when a product is published but no revenue', () => {
    const view = deriveLifecycleStage(baseInput({
      products: 1,
      publishedProducts: 1,
    }));
    assert.equal(view.currentStage, 'MARKET');
  });

  it('reaches MEASURE/IMPROVE once revenue exists', () => {
    const view = deriveLifecycleStage(baseInput({
      products: 1,
      publishedProducts: 1,
      revenues: 3,
    }));
    assert.equal(view.currentStage, 'IMPROVE');
    assert.equal(view.stages.find((s) => s.stage === 'MEASURE')?.hasEvidence, true);
  });

  it('hard-stops blocked opportunities at DISCOVER with no progression', () => {
    const view = deriveLifecycleStage(baseInput({
      opportunity: {
        id: 'opp-1',
        title: 'Blocked',
        status: 'IDEA',
        halalStatus: 'NOT_ALLOWED',
        overallScore: 90,
      },
      revenues: 5,
      products: 2,
    }));
    assert.equal(view.currentStage, 'DISCOVER');
    assert.ok(view.rationale.includes('NOT_ALLOWED'));
    const current = view.stages.find((s) => s.isCurrent);
    assert.ok(current?.missingEvidence.length ?? 0 > 0);
  });

  it('keeps REVIEW_REQUIRED opportunities moving but flags human review in rationale', () => {
    const view = deriveLifecycleStage(baseInput({
      opportunity: {
        id: 'opp-1',
        title: 'Review',
        status: 'IDEA',
        halalStatus: 'REVIEW_REQUIRED',
        overallScore: 60,
      },
    }));
    assert.equal(view.halalStatus, 'REVIEW_REQUIRED');
    assert.ok(view.rationale.includes('human'));
  });

  it('treats finished (REJECTED/PAUSED) opportunities as IMPROVE-stage', () => {
    const view = deriveLifecycleStage(baseInput({
      opportunity: {
        id: 'opp-1',
        title: 'Paused',
        status: 'PAUSED',
        halalStatus: 'HALAL',
        overallScore: 50,
      },
    }));
    assert.equal(view.currentStage, 'IMPROVE');
  });
});

describe('summarizePortfolio', () => {
  it('ranks opportunities by score and reports stage distribution', () => {
    const mk = (id: string, score: number, stage: 'VALIDATE' | 'BUILD') =>
      baseInput({
        opportunity: {
          id,
          title: id,
          status: stage === 'VALIDATE' ? 'IDEA' : 'VALIDATED',
          halalStatus: 'HALAL',
          overallScore: score,
        },
        experiments: stage === 'VALIDATE' ? 1 : 1,
        completedExperimentDecisions: stage === 'BUILD' ? 1 : 0,
        positiveExperimentDecisions: stage === 'BUILD' ? 1 : 0,
      });
    const summary = summarizePortfolio(
      [mk('low', 40, 'VALIDATE'), mk('high', 90, 'BUILD'), mk('mid', 60, 'VALIDATE')],
      { opportunities: 3, experiments: 3, products: 0, revenues: 0 }
    );
    assert.equal(summary.opportunities[0].opportunity.id, 'high');
    assert.equal(summary.opportunities.length, 3);
    const buildEntry = summary.stageDistribution.find((d) => d.stage === 'BUILD');
    const validateEntry = summary.stageDistribution.find((d) => d.stage === 'VALIDATE');
    assert.equal(buildEntry?.count, 1);
    assert.equal(validateEntry?.count, 2);
  });

  it('excludes blocked opportunities from the stage distribution', () => {
    const blocked = baseInput({
      opportunity: {
        id: 'blocked',
        title: 'Blocked',
        status: 'IDEA',
        halalStatus: 'NOT_ALLOWED',
        overallScore: 99,
      },
    });
    const ok = baseInput({
      opportunity: { id: 'ok', title: 'OK', status: 'IDEA', halalStatus: 'HALAL', overallScore: 50 },
    });
    const summary = summarizePortfolio([blocked, ok], {
      opportunities: 2, experiments: 0, products: 0, revenues: 0,
    });
    assert.equal(summary.stageDistribution.find((d) => d.stage === 'DISCOVER'), undefined);
    assert.equal(summary.stageDistribution.find((d) => d.stage === 'RESEARCH')?.count, 1);
    assert.equal(summary.opportunities[0].opportunity.id, 'blocked'); // still listed, flagged
  });

  it('exposes the full stage order', () => {
    assert.deepEqual(LIFECYCLE_ORDER, [
      'DISCOVER', 'RESEARCH', 'VALIDATE', 'DECIDE', 'BUILD', 'PUBLISH', 'MARKET', 'MEASURE', 'IMPROVE',
    ]);
  });
});
