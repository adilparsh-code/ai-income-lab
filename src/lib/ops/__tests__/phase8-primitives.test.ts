// Phase 8 — pure primitive tests (no DB, no network, no AI).
// Covers scoring provenance, lifecycle decisions, paper-income simulation,
// failure classification / bounded retries, and loop-guard logic.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreOpportunity } from '../scoring';
import { cannotBypass, decideLifecycle, humanOverridesAi } from '../decision-engine';
import { assertNotRealRevenue, runPaperSimulation, seedToInt, SIMULATION_LABEL, SIMULATION_MODE } from '../simulation';
import {
  applyRecovery,
  backoffMs,
  classifyFailure,
  isRetryableFailureClass,
  planRecovery,
} from '../failure-recovery';
import { wouldLoopInfinitely } from '../loop';
import { isVerifiedMemory, validateMemoryInput } from '../memory';
import { validateMissionSpec } from '../missions';
import { evidenceRank } from '../types';
import type { LoopTransitionRecord } from '../types';

describe('8C opportunity scoring', () => {
  it('NOT_ALLOWED scores 0 and is not investable', () => {
    const result = scoreOpportunity({
      demand: { value: 90, evidence: 'AI_INFERENCE' },
      competition: { value: 80, evidence: 'AI_INFERENCE' },
      effort: { value: 10, evidence: 'AI_INFERENCE' },
      cost: { value: 10, evidence: 'AI_INFERENCE' },
      monetization: { value: 90, evidence: 'AI_INFERENCE' },
      evidenceStrength: { value: 90, evidence: 'AI_INFERENCE' },
      risk: { value: 10, evidence: 'AI_INFERENCE' },
      halalCompatibility: { value: 100, evidence: 'VERIFIED_DATA' },
      executionComplexity: { value: 10, evidence: 'AI_INFERENCE' },
      halalStatus: 'NOT_ALLOWED',
    });
    assert.equal(result.overall, 0);
    assert.equal(result.investable, false);
  });

  it('verified evidence outranks AI inference by construction', () => {
    assert.ok(evidenceRank('VERIFIED_DATA') > evidenceRank('AI_INFERENCE'));
    assert.ok(evidenceRank('VERIFIED_DATA') > evidenceRank('SEARCH_DISCOVERY'));
    assert.ok(evidenceRank('HUMAN_DECISION') > evidenceRank('AI_INFERENCE'));
    const verified = scoreOpportunity({
      demand: { value: 80, evidence: 'VERIFIED_DATA' },
      competition: { value: 70, evidence: 'VERIFIED_DATA' },
      effort: { value: 40, evidence: 'VERIFIED_DATA' },
      cost: { value: 30, evidence: 'VERIFIED_DATA' },
      monetization: { value: 75, evidence: 'VERIFIED_DATA' },
      evidenceStrength: { value: 80, evidence: 'VERIFIED_DATA' },
      risk: { value: 20, evidence: 'VERIFIED_DATA' },
      halalCompatibility: { value: 100, evidence: 'VERIFIED_DATA' },
      executionComplexity: { value: 30, evidence: 'VERIFIED_DATA' },
      halalStatus: 'HALAL',
    });
    const inferred = scoreOpportunity({
      demand: { value: 80, evidence: 'AI_INFERENCE' },
      competition: { value: 70, evidence: 'AI_INFERENCE' },
      effort: { value: 40, evidence: 'AI_INFERENCE' },
      cost: { value: 30, evidence: 'AI_INFERENCE' },
      monetization: { value: 75, evidence: 'AI_INFERENCE' },
      evidenceStrength: { value: 80, evidence: 'AI_INFERENCE' },
      risk: { value: 20, evidence: 'AI_INFERENCE' },
      halalCompatibility: { value: 100, evidence: 'AI_INFERENCE' },
      executionComplexity: { value: 30, evidence: 'AI_INFERENCE' },
      halalStatus: 'HALAL',
    });
    assert.ok(verified.overall > inferred.overall, 'verified score must beat identical AI-inferred scores');
    assert.equal(verified.verifiedOutranksInference, true);
    assert.match(verified.explanation, /Dominant evidence/);
  });

  it('every score is explainable with factor provenance', () => {
    const result = scoreOpportunity({
      demand: { value: 50, evidence: 'SEARCH_DISCOVERY' },
      competition: { value: 50, evidence: 'AI_INFERENCE' },
      effort: { value: 50, evidence: 'HUMAN_DECISION' },
      cost: { value: 50, evidence: 'VERIFIED_DATA' },
      monetization: { value: 50, evidence: 'VERIFIED_DATA' },
      evidenceStrength: { value: 50, evidence: 'SEARCH_DISCOVERY' },
      risk: { value: 50, evidence: 'AI_INFERENCE' },
      halalCompatibility: { value: 90, evidence: 'VERIFIED_DATA' },
      executionComplexity: { value: 50, evidence: 'AI_INFERENCE' },
      halalStatus: 'REVIEW_REQUIRED',
    });
    assert.ok(result.explanation.length > 20);
    assert.ok(result.factors.every((f) => f.evidence && typeof f.raw === 'number'));
    assert.ok(result.warnings.some((w) => /REVIEW_REQUIRED/.test(w)));
  });
});

describe('8E lifecycle decision engine', () => {
  it('repeated failed validation → KILL', () => {
    const d = decideLifecycle({
      failedValidationCount: 3, positiveValidationCount: 0, completedDecisionCount: 3,
      netRevenue: 0, trafficEvents: 0, conversionEvents: 0, costsUsd: 0,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
    });
    assert.equal(d.decision, 'KILL');
  });

  it('weak recoverable signal → ITERATE', () => {
    const d = decideLifecycle({
      failedValidationCount: 1, positiveValidationCount: 0, completedDecisionCount: 1,
      netRevenue: 0, trafficEvents: 0, conversionEvents: 0, costsUsd: 0,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
    });
    assert.equal(d.decision, 'ITERATE');
  });

  it('promising signal → CONTINUE', () => {
    const d = decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 1, completedDecisionCount: 1,
      netRevenue: 0, trafficEvents: 0, conversionEvents: 0, costsUsd: 0,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
    });
    assert.equal(d.decision, 'CONTINUE');
  });

  it('verified positive economics → SCALE', () => {
    const d = decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 1, completedDecisionCount: 1,
      netRevenue: 480, trafficEvents: 10000, conversionEvents: 240, costsUsd: 73,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
    });
    assert.equal(d.decision, 'SCALE');
  });

  it('ambiguous / high-risk → HUMAN_REVIEW', () => {
    const a = decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 0, completedDecisionCount: 0,
      netRevenue: 0, trafficEvents: 0, conversionEvents: 0, costsUsd: 0,
      halalStatus: 'HALAL', hasAmbiguousSignal: true, highRisk: false,
    });
    const b = decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 0, completedDecisionCount: 0,
      netRevenue: 0, trafficEvents: 0, conversionEvents: 0, costsUsd: 0,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: true,
    });
    assert.equal(a.decision, 'HUMAN_REVIEW');
    assert.equal(b.decision, 'HUMAN_REVIEW');
  });

  it('NOT_ALLOWED → KILL and REVIEW_REQUIRED → HUMAN_REVIEW', () => {
    assert.equal(decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 5, completedDecisionCount: 5,
      netRevenue: 999, trafficEvents: 9, conversionEvents: 9, costsUsd: 1,
      halalStatus: 'NOT_ALLOWED', hasAmbiguousSignal: false, highRisk: false,
    }).decision, 'KILL');
    assert.equal(decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 5, completedDecisionCount: 5,
      netRevenue: 999, trafficEvents: 9, conversionEvents: 9, costsUsd: 1,
      halalStatus: 'REVIEW_REQUIRED', hasAmbiguousSignal: false, highRisk: false,
    }).decision, 'HUMAN_REVIEW');
  });

  it('human decision is authoritative and AI cannot bypass KILL', () => {
    const human = decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 1, completedDecisionCount: 1,
      netRevenue: 100, trafficEvents: 10, conversionEvents: 2, costsUsd: 10,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
      humanDecision: 'PAUSE',
    });
    assert.equal(human.decision, 'PAUSE');
    assert.equal(human.evidenceType, 'HUMAN_DECISION');
    assert.equal(humanOverridesAi('KILL', 'SCALE'), 'KILL');
    assert.equal(cannotBypass({
      decision: 'KILL', reason: 'x', evidenceType: 'VERIFIED_DATA', overridableByHuman: true, simulated: false,
    }, 'SCALE'), true);
  });

  it('losing economics → PAUSE', () => {
    const d = decideLifecycle({
      failedValidationCount: 0, positiveValidationCount: 1, completedDecisionCount: 1,
      netRevenue: 10, trafficEvents: 1000, conversionEvents: 1, costsUsd: 80,
      halalStatus: 'HALAL', hasAmbiguousSignal: false, highRisk: false,
    });
    assert.equal(d.decision, 'PAUSE');
  });
});

describe('8D paper-income simulation', () => {
  it('is deterministic for the same seed and always SIMULATED', () => {
    const a = runPaperSimulation({ seed: 'paper-1', correlationId: 'sim:1', traffic: 10000, conversionRate: 0.024, priceUsd: 2, costPerVisitorUsd: 0.005, fixedCostUsd: 23 });
    const b = runPaperSimulation({ seed: 'paper-1', correlationId: 'sim:1', traffic: 10000, conversionRate: 0.024, priceUsd: 2, costPerVisitorUsd: 0.005, fixedCostUsd: 23 });
    assert.equal(a.revenueUsd, b.revenueUsd);
    assert.equal(a.profitUsd, b.profitUsd);
    assert.equal(a.mode, SIMULATION_MODE);
    assert.equal(a.label, SIMULATION_LABEL);
    assert.equal(a.realTransaction, false);
    assert.equal(a.traffic, 10000);
    assert.equal(a.conversions, 240);
    assert.equal(a.revenueUsd, 480);
    assert.equal(a.costsUsd, 73);
    assert.equal(a.profitUsd, 407);
    assert.match(a.summary, /No real transaction occurred/);
    assert.doesNotThrow(() => assertNotRealRevenue(a));
  });

  it('different seeds produce different streams', () => {
    assert.notEqual(seedToInt('alpha'), seedToInt('beta'));
    const a = runPaperSimulation({ seed: 'alpha', correlationId: 'c1' });
    const b = runPaperSimulation({ seed: 'beta', correlationId: 'c2' });
    assert.equal(a.realTransaction, false);
    assert.equal(b.realTransaction, false);
  });

  it('NOT_ALLOWED simulation marks stages BLOCKED and still stays SIMULATED', () => {
    const r = runPaperSimulation({ seed: 'blocked', correlationId: 'c3', halalStatus: 'NOT_ALLOWED' });
    assert.ok(r.stages.every((s) => s.status === 'BLOCKED' && s.label === SIMULATION_LABEL));
    assert.equal(r.decision, 'KILL');
  });
});

describe('8F failure recovery', () => {
  it('classifies auth / config / validation / human-review as non-retryable', () => {
    assert.equal(classifyFailure({ error: '401 Unauthorized' }).classification, 'AUTHENTICATION');
    assert.equal(classifyFailure({ error: '401 Unauthorized' }).retryable, false);
    assert.equal(classifyFailure({ error: 'NOT_CONFIGURED missing key' }).classification, 'CONFIGURATION');
    assert.equal(classifyFailure({ error: 'invalid payload must be a string' }).classification, 'VALIDATION');
    assert.equal(classifyFailure({ error: 'HUMAN_REVIEW required' }).classification, 'HUMAN_REVIEW');
    assert.equal(classifyFailure({ error: 'NOT_ALLOWED under halal' }).classification, 'BUSINESS_RULE');
    assert.equal(isRetryableFailureClass('AUTHENTICATION'), false);
    assert.equal(isRetryableFailureClass('HUMAN_REVIEW'), false);
    assert.equal(isRetryableFailureClass('VALIDATION'), false);
  });

  it('classifies transient / provider / timeout as retryable with exponential backoff', () => {
    assert.equal(classifyFailure({ error: 'temporar 503' }).classification, 'TRANSIENT');
    assert.equal(classifyFailure({ error: 'provider unavailable NOT_CONNECTED' }).classification, 'PROVIDER_UNAVAILABLE');
    assert.equal(classifyFailure({ error: 'deadline elapsed timeout' }).classification, 'TIMEOUT');
    assert.equal(backoffMs(0), 250);
    assert.equal(backoffMs(1), 500);
    assert.equal(backoffMs(2), 1000);
    assert.ok(backoffMs(20) <= 8000);
  });

  it('never retries endlessly — dead-letters after max', () => {
    const plan = planRecovery({ classification: 'TRANSIENT', retryCount: 3, maxRetries: 3 });
    assert.equal(plan.action, 'DEAD_LETTER');
    const applied = applyRecovery({
      classification: 'TRANSIENT', retryCount: 3, maxRetries: 3, lastError: 'x',
      recoveryState: 'RETRYING', deadLettered: false, resumePoint: 'VALIDATE', correlationId: 'c',
    }, classifyFailure({ error: 'temporar 503' }));
    assert.equal(applied.deadLettered, true);
    assert.equal(applied.recoveryState, 'DEAD_LETTER');
  });

  it('unclassified failures fail closed (non-retryable UNKNOWN)', () => {
    const c = classifyFailure({ error: 'something inexplicable' });
    assert.equal(c.classification, 'UNKNOWN');
    assert.equal(c.retryable, false);
  });
});

describe('8A mission validation', () => {
  it('rejects missing fields, oversized budget, and forbidden capabilities', () => {
    assert.equal(validateMissionSpec({}).valid, false);
    const badCap = validateMissionSpec({
      objective: 'research x', agentType: 'research', correlationId: 'c1',
      allowedCapabilities: ['SHELL' as never],
    });
    assert.equal(badCap.valid, false);
    const budget = validateMissionSpec({
      objective: 'research x', agentType: 'research', correlationId: 'c1', budgetUsd: 999,
    });
    assert.equal(budget.valid, false);
    const ok = validateMissionSpec({
      objective: 'research x', agentType: 'research', correlationId: 'c1', allowedCapabilities: ['RESEARCH'],
    });
    assert.equal(ok.valid, true);
  });
});

describe('8B infinite-loop guard', () => {
  it('trips after three identical non-advancing transitions', () => {
    const history: LoopTransitionRecord[] = [
      { from: 'RESEARCH', to: 'RESEARCH', reason: 'x', evidence: '', evidenceType: 'VERIFIED_DATA', correlationId: 'a', timestamp: 't', status: 'NO_OP' },
      { from: 'RESEARCH', to: 'RESEARCH', reason: 'x', evidence: '', evidenceType: 'VERIFIED_DATA', correlationId: 'b', timestamp: 't', status: 'NO_OP' },
      { from: 'RESEARCH', to: 'RESEARCH', reason: 'x', evidence: '', evidenceType: 'VERIFIED_DATA', correlationId: 'c', timestamp: 't', status: 'NO_OP' },
    ];
    assert.equal(wouldLoopInfinitely(history, { from: 'RESEARCH', to: 'RESEARCH' }), true);
    assert.equal(wouldLoopInfinitely([], { from: 'RESEARCH', to: 'VALIDATE' }), false);
  });
});

describe('8G memory provenance', () => {
  it('does not treat AI inference as verified truth', () => {
    assert.equal(isVerifiedMemory('AI_INFERENCE', 'research-agent'), false);
    assert.equal(isVerifiedMemory('VERIFIED_DATA', 'ai'), false);
    assert.equal(isVerifiedMemory('VERIFIED_DATA', 'AgentLog:abc'), true);
    assert.ok(validateMemoryInput({
      category: 'opportunity', source: 'loop', evidenceType: 'VERIFIED_DATA', observation: 'ok',
    }).length === 0);
    assert.ok(validateMemoryInput({
      category: 'opportunity', source: '', evidenceType: 'AI_INFERENCE', observation: '',
    }).length > 0);
  });
});
