// Phase 6 — Intelligence core tests (pure): routing-state mapping, conflict
// positions, handoff consumption, and the no-AI-override invariants. All
// fixtures are constructed in-memory; no DB, no network, no AI.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routingStateFromContext, buildIntelligenceView } from '../intelligence';
import { buildHandoff } from '../coordination';
import type { AgentContext, ContextSlice } from '../agent-context';

const EMPTY_SLICE: ContextSlice = {
  summary: 'not on file',
  evidenceType: 'AI_INFERENCE',
  sourceRef: null,
  recordedAt: null,
};

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    opportunity: {
      id: 'opp-1',
      title: 'Test opportunity',
      status: 'RESEARCHED',
      halalStatus: 'HALAL',
      overallScore: 80,
      problem: 'a problem',
      targetAudience: 'testers',
    },
    research: EMPTY_SLICE,
    validation: EMPTY_SLICE,
    product: { slice: EMPTY_SLICE, statuses: [] },
    experiments: { slice: EMPTY_SLICE, total: 0, completedDecisions: [], positiveDecisions: 0 },
    analytics: EMPTY_SLICE,
    revenue: { slice: EMPTY_SLICE, recordCount: 0, netTotal: 0 },
    traffic: { slice: EMPTY_SLICE, eventCount: 0, latestEventType: null, latestEventAt: null },
    businessMemory: [],
    previousDecisions: [],
    handoffs: [],
    provenance: { verified: 0, userEntered: 0, aiInference: 0, mocked: 0 },
    missingEvidence: [],
    humanReviewState: { required: false, reason: null, latestApprovalAction: null, latestApprovalAt: null },
    evidenceStrength: { strength: 'MISSING', basis: 'test' },
    assembledAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('routing state derived from context', () => {
  it('maps a fresh opportunity to RESEARCH', () => {
    const state = routingStateFromContext(makeContext());
    assert.equal(state.halalStatus, 'HALAL');
    assert.equal(state.hasResearchLog, false);
    assert.equal(state.hasValidationData, false);
    assert.equal(state.hasProduct, false);
    assert.equal(state.revenueHealth, 'NO_DATA');
  });

  it('passes halal status through untouched (gates stay authoritative)', () => {
    const blocked = routingStateFromContext(
      makeContext({ opportunity: { id: 'o', title: 't', status: 'IDEA', halalStatus: 'NOT_ALLOWED', overallScore: 90, problem: null, targetAudience: null } }),
    );
    assert.equal(blocked.halalStatus, 'NOT_ALLOWED');
    const review = routingStateFromContext(
      makeContext({ opportunity: { id: 'o', title: 't', status: 'IDEA', halalStatus: 'REVIEW_REQUIRED', overallScore: 90, problem: null, targetAudience: null } }),
    );
    assert.equal(review.halalStatus, 'REVIEW_REQUIRED');
  });

  it('derives revenue health from recorded revenue', () => {
    const positive = routingStateFromContext(
      makeContext({ revenue: { slice: EMPTY_SLICE, recordCount: 2, netTotal: 150 } }),
    );
    assert.equal(positive.revenueHealth, 'PROFITABLE');
    const zero = routingStateFromContext(
      makeContext({ revenue: { slice: EMPTY_SLICE, recordCount: 1, netTotal: 0 } }),
    );
    assert.equal(zero.revenueHealth, 'NON_POSITIVE_NET');
  });
});

describe('deterministic routing through the existing router', () => {
  it('NOT_ALLOWED routes to BLOCKED with no agent and no AI', () => {
    const view = buildIntelligenceView(
      makeContext({ opportunity: { id: 'o', title: 't', status: 'IDEA', halalStatus: 'NOT_ALLOWED', overallScore: 99, problem: null, targetAudience: null } }),
    );
    assert.equal(view.nextStep.action, 'BLOCKED');
    assert.equal(view.nextStep.agent, null);
    assert.equal(view.nextStep.requiresAi, false);
    assert.equal(view.nextStep.humanApprovalRequired, false);
  });

  it('REVIEW_REQUIRED routes to HUMAN_REVIEW with no autonomous execution', () => {
    const view = buildIntelligenceView(
      makeContext({ opportunity: { id: 'o', title: 't', status: 'IDEA', halalStatus: 'REVIEW_REQUIRED', overallScore: 99, problem: null, targetAudience: null } }),
    );
    assert.equal(view.nextStep.action, 'HUMAN_REVIEW');
    assert.equal(view.nextStep.humanApprovalRequired, true);
    assert.equal(view.nextStep.agent, null);
  });

  it('no research routes to the research agent', () => {
    const view = buildIntelligenceView(makeContext());
    assert.equal(view.nextStep.action, 'RESEARCH');
    assert.equal(view.nextStep.agent, 'research');
    assert.equal(view.nextStep.requiresAi, true);
  });

  it('research on file without validation routes to validation', () => {
    const view = buildIntelligenceView(
      makeContext({
        research: { summary: 'Research recorded (AI_INFERENCE)', evidenceType: 'AI_INFERENCE', sourceRef: 'AgentLog:r1', recordedAt: '2026-01-01T00:00:00Z' },
      }),
    );
    assert.equal(view.nextStep.action, 'VALIDATE');
    assert.equal(view.nextStep.agent, 'validation');
  });
});

describe('conflict detection over recorded positions', () => {
  it('detects research-vs-analytics conflict and demands human review on unverified signals', () => {
    // Zero-revenue record is VERIFIED_DATA from the DB but the assessor sees
    // POSITIVE (research PROMISING) vs NEGATIVE (analytics POOR_RESULTS)
    // signals with no user/verified position — safe action is human review.
    const view = buildIntelligenceView(
      makeContext({
        research: {
          summary: 'Research recorded (AI_INFERENCE, PROMISING): optimistic findings.',
          evidenceType: 'AI_INFERENCE',
          sourceRef: 'AgentLog:r1',
          recordedAt: '2026-01-01T00:00:00Z',
        },
        experiments: {
          slice: { summary: '1 experiment recorded.', evidenceType: 'VERIFIED_DATA', sourceRef: 'Experiment:e1', recordedAt: '2026-01-01T00:00:00Z' },
          total: 1,
          completedDecisions: [],
          positiveDecisions: 0,
        },
      }),
    );
    assert.equal(view.conflicts.hasConflict, true);
    // Verified experiment data outranks AI optimism: the assessor proceeds on
    // the VERIFIED (negative) position instead of deferring to AI inference —
    // recorded data has higher authority, and the safe action is NOT an
    // execution path.
    assert.equal(view.conflicts.safeAction, 'PROCEED_ON_VERIFIED');
    assert.equal(view.conflicts.preferredPosition?.agent, 'analytics');
    assert.equal(view.conflicts.preferredPosition?.signal, 'POOR_RESULTS');
    assert.equal(view.nextStep.humanApprovalRequired, false);
    assert.notEqual(view.nextStep.action, 'BUILD_PRODUCT');
  });

  it('conflicts between unverified signals demand human review', () => {
    const view = buildIntelligenceView(
      makeContext({
        research: {
          summary: 'Research recorded (AI_INFERENCE, PROMISING).',
          evidenceType: 'AI_INFERENCE',
          sourceRef: 'AgentLog:r1',
          recordedAt: '2026-01-01T00:00:00Z',
        },
        validation: {
          summary: 'Validation recorded (AI_INFERENCE, WEAK_SIGNAL).',
          evidenceType: 'AI_INFERENCE',
          sourceRef: 'AgentLog:v1',
          recordedAt: '2026-01-02T00:00:00Z',
        },
      }),
    );
    assert.equal(view.conflicts.hasConflict, true);
    assert.equal(view.conflicts.safeAction, 'REQUEST_HUMAN_REVIEW');
    assert.equal(view.nextStep.humanApprovalRequired, true);
  });

  it('CONFLICTING evidence strength forces human review even when routing is optimistic', () => {
    const view = buildIntelligenceView(
      makeContext({
        research: {
          summary: 'Research recorded (AI_INFERENCE, PROMISING).',
          evidenceType: 'AI_INFERENCE',
          sourceRef: 'AgentLog:r1',
          recordedAt: '2026-01-01T00:00:00Z',
        },
        validation: {
          summary: 'Validation recorded (AI_INFERENCE, PROMISING).',
          evidenceType: 'AI_INFERENCE',
          sourceRef: 'AgentLog:v1',
          recordedAt: '2026-01-02T00:00:00Z',
        },
        product: { slice: EMPTY_SLICE, statuses: [{ id: 'p1', name: 'Product', status: 'DRAFT' }] },
        evidenceStrength: { strength: 'CONFLICTING', basis: 'test basis' },
      }),
    );
    assert.equal(view.nextStep.humanApprovalRequired, true);
  });

  it('verified revenue outranks weaker AI signals', () => {
    const view = buildIntelligenceView(
      makeContext({
        research: {
          summary: 'Research recorded (AI_INFERENCE, PROMISING).',
          evidenceType: 'AI_INFERENCE',
          sourceRef: 'AgentLog:r1',
          recordedAt: '2026-01-01T00:00:00Z',
        },
        revenue: { slice: EMPTY_SLICE, recordCount: 1, netTotal: 500 },
      }),
    );
    const analyticsPosition = view.conflicts.considered.find((p) => p.agent === 'analytics');
    assert.ok(analyticsPosition);
    assert.equal(analyticsPosition.signal, 'PROVEN');
    assert.equal(analyticsPosition.evidenceType, 'VERIFIED_DATA');
  });

  it('BLOCKED halal status dominates all other positions', () => {
    const view = buildIntelligenceView(
      makeContext({
        opportunity: { id: 'o', title: 't', status: 'IDEA', halalStatus: 'NOT_ALLOWED', overallScore: 50, problem: null, targetAudience: null },
        research: {
          summary: 'Research recorded (AI_INFERENCE, PROMISING).',
          evidenceType: 'AI_INFERENCE',
          sourceRef: 'AgentLog:r1',
          recordedAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    assert.equal(view.conflicts.hasConflict, true);
    assert.equal(view.nextStep.action, 'BLOCKED');
  });
});

describe('handoff contracts', () => {
  it('accepts and preserves bounded upstream handoffs in the context', () => {
    const handoff = buildHandoff({
      sourceAgent: 'research',
      sourceExecutionId: 'log-1',
      sourceRef: 'AgentLog:log-1',
      evidenceType: 'AI_INFERENCE',
      relevantFacts: ['fact'],
      hypotheses: ['hypothesis'],
      unresolvedQuestions: ['unknown'],
      recommendedNextStep: 'validate next',
    });
    const ctx = makeContext({ handoffs: [handoff] });
    assert.equal(ctx.handoffs.length, 1);
    assert.equal(ctx.handoffs[0].sourceAgent, 'research');
    assert.equal(ctx.handoffs[0].recommendedNextStep, 'validate next');
  });
});

describe('no fabricated intelligence', () => {
  it('produces no agent position when nothing is recorded', () => {
    const view = buildIntelligenceView(makeContext());
    assert.equal(view.conflicts.considered.length, 0);
    assert.equal(view.conflicts.hasConflict, false);
  });

  it('never requires AI for blocked or review paths', () => {
    for (const halal of ['NOT_ALLOWED', 'REVIEW_REQUIRED'] as const) {
      const view = buildIntelligenceView(
        makeContext({ opportunity: { id: 'o', title: 't', status: 'IDEA', halalStatus: halal, overallScore: 10, problem: null, targetAudience: null } }),
      );
      assert.equal(view.nextStep.requiresAi, false);
    }
  });
});
