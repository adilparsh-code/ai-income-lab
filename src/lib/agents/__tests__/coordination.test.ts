// Phase 4.5.3 — Agent coordination tests: handoffs, conflict handling, memory.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessConflict,
  buildHandoff,
  createMemoryEntry,
  MEMORY_CATEGORIES,
  memoryToContextItems,
  retrieveMemory,
  type AgentPosition,
} from '../coordination';

describe('handoff contract', () => {
  it('builds a bounded, provenance-aware handoff', () => {
    const handoff = buildHandoff({
      sourceAgent: 'research',
      sourceExecutionId: 'log-123',
      sourceRef: 'AgentLog:log-123',
      evidenceType: 'AI_INFERENCE',
      confidence: 0.6,
      relevantFacts: ['Demand signal observed in KDP category (AI inference)'],
      hypotheses: ['Printable activity books could serve the same audience'],
      unresolvedQuestions: ['No verified demand data yet'],
      recommendedNextStep: 'Validation should design a landing-page test',
    });
    assert.equal(handoff.sourceAgent, 'research');
    assert.equal(handoff.evidenceType, 'AI_INFERENCE');
    assert.equal(handoff.confidence, 0.6);
    assert.equal(handoff.relevantFacts.length, 1);
    assert.equal(handoff.hypotheses.length, 1);
    assert.equal(handoff.unresolvedQuestions.length, 1);
    assert.ok(handoff.recommendedNextStep?.includes('Validation'));
    assert.ok(handoff.createdAt.length > 0);
  });

  it('bounds over-long lists and strings honestly', () => {
    const handoff = buildHandoff({
      sourceAgent: 'research',
      evidenceType: 'VERIFIED_DATA',
      relevantFacts: Array.from({ length: 30 }, (_, i) => `fact-${i}-${'x'.repeat(400)}`),
      unresolvedQuestions: Array.from({ length: 20 }, (_, i) => `q-${i}`),
      confidence: 5, // out of range is clamped
    });
    assert.equal(handoff.relevantFacts.length, 12);
    assert.ok(handoff.relevantFacts[0].length <= 300);
    assert.equal(handoff.unresolvedQuestions.length, 8);
    assert.equal(handoff.confidence, 1);
  });

  it('clamps negative confidence to 0 and drops empty strings', () => {
    const handoff = buildHandoff({
      sourceAgent: 'validation',
      evidenceType: 'AI_INFERENCE',
      confidence: -2,
      relevantFacts: ['', '   ', 'real fact'],
    });
    assert.equal(handoff.confidence, 0);
    assert.deepEqual(handoff.relevantFacts, ['real fact']);
  });
});

describe('conflict handling', () => {
  it('detects conflict between positive and negative signals', () => {
    const positions: AgentPosition[] = [
      { agent: 'research', signal: 'PROMISING', evidenceType: 'AI_INFERENCE', collectedAt: '2026-09-18T10:00:00Z' },
      { agent: 'validation', signal: 'WEAK_SIGNAL', evidenceType: 'AI_INFERENCE', collectedAt: '2026-09-18T11:00:00Z' },
    ];
    const result = assessConflict(positions);
    assert.equal(result.hasConflict, true);
    assert.ok(result.conflictDescription?.includes('disagree'));
  });

  it('NEVER blindly follows the positive signal without verified evidence', () => {
    const positions: AgentPosition[] = [
      { agent: 'research', signal: 'PROMISING', evidenceType: 'AI_INFERENCE', collectedAt: '2026-09-18T10:00:00Z' },
      { agent: 'analytics', signal: 'POOR_RESULTS', evidenceType: 'AI_INFERENCE', collectedAt: '2026-09-18T11:00:00Z' },
    ];
    const result = assessConflict(positions);
    assert.equal(result.hasConflict, true);
    assert.equal(result.safeAction, 'REQUEST_HUMAN_REVIEW');
    assert.ok(result.resolutionReason?.includes('must not pick the positive signal'));
  });

  it('prefers verified evidence over AI inference in a conflict', () => {
    const positions: AgentPosition[] = [
      { agent: 'research', signal: 'PROMISING', evidenceType: 'AI_INFERENCE', collectedAt: '2026-09-18T12:00:00Z' },
      { agent: 'analytics', signal: 'POOR_RESULTS', evidenceType: 'VERIFIED_DATA', collectedAt: '2026-09-18T09:00:00Z' },
    ];
    const result = assessConflict(positions);
    assert.equal(result.preferredPosition?.agent, 'analytics');
    assert.equal(result.safeAction, 'PROCEED_ON_VERIFIED');
  });

  it('BLOCKED dominance: safety overrides everything', () => {
    const positions: AgentPosition[] = [
      { agent: 'validation', signal: 'PROVEN', evidenceType: 'VERIFIED_DATA', collectedAt: '2026-09-18T12:00:00Z' },
      { agent: 'research', signal: 'BLOCKED', evidenceType: 'AI_INFERENCE', collectedAt: '2026-09-18T11:00:00Z' },
    ];
    const result = assessConflict(positions);
    assert.equal(result.safeAction, 'REQUEST_HUMAN_REVIEW');
    assert.equal(result.preferredPosition?.signal, 'BLOCKED');
    assert.ok(result.resolutionReason?.includes('BLOCKED overrides'));
  });

  it('unanimous signals do not create conflict', () => {
    const positions: AgentPosition[] = [
      { agent: 'research', signal: 'PROMISING', evidenceType: 'AI_INFERENCE', collectedAt: '2026-09-18T10:00:00Z' },
      { agent: 'validation', signal: 'PROMISING', evidenceType: 'VERIFIED_DATA', collectedAt: '2026-09-18T11:00:00Z' },
    ];
    const result = assessConflict(positions);
    assert.equal(result.hasConflict, false);
    assert.equal(result.safeAction, 'PROCEED_ON_VERIFIED');
  });

  it('handles empty positions honestly', () => {
    const result = assessConflict([]);
    assert.equal(result.hasConflict, false);
    assert.equal(result.safeAction, 'NO_ACTION');
  });
});

describe('memory foundation', () => {
  const baseEntry = {
    provenance: 'test',
    createdAt: '2026-09-18T00:00:00.000Z',
  };

  it('exposes exactly the seven required categories', () => {
    assert.deepEqual([...MEMORY_CATEGORIES], [
      'VERIFIED_FACTS', 'USER_ENTERED', 'AI_INFERENCE', 'EXPERIMENT_RESULTS',
      'BUSINESS_DECISIONS', 'FAILED_HYPOTHESES', 'SUCCESSFUL_PATTERNS',
    ]);
  });

  it('creates bounded, provenance-aware entries', () => {
    const entry = createMemoryEntry({
      id: 'm1',
      category: 'VERIFIED_FACTS',
      scope: 'opportunity:abc',
      content: 'x'.repeat(2000),
      evidenceType: 'VERIFIED_DATA',
      provenance: 'p'.repeat(300),
    });
    assert.equal(entry.content.length, 600);
    assert.equal(entry.provenance.length, 120);
    assert.equal(entry.category, 'VERIFIED_FACTS');
  });

  it('retrieval filters by scope and category', () => {
    const entries = [
      createMemoryEntry({ id: 'a', category: 'VERIFIED_FACTS', scope: 'opportunity:1', content: 'verified', evidenceType: 'VERIFIED_DATA', ...baseEntry }),
      createMemoryEntry({ id: 'b', category: 'AI_INFERENCE', scope: 'opportunity:1', content: 'inference', evidenceType: 'AI_INFERENCE', ...baseEntry }),
      createMemoryEntry({ id: 'c', category: 'VERIFIED_FACTS', scope: 'opportunity:2', content: 'other scope', evidenceType: 'VERIFIED_DATA', ...baseEntry }),
    ];
    const scoped = retrieveMemory(entries, { scope: 'opportunity:1' });
    assert.equal(scoped.length, 2);
    const verifiedOnly = retrieveMemory(entries, { scope: 'opportunity:1', categories: ['VERIFIED_FACTS'] });
    assert.equal(verifiedOnly.length, 1);
    assert.equal(verifiedOnly[0].id, 'a');
  });

  it('ranks verified/user evidence above inference at equal recency', () => {
    const entries = [
      createMemoryEntry({ id: 'inference', category: 'AI_INFERENCE', scope: 'global', content: 'guess', evidenceType: 'AI_INFERENCE', ...baseEntry }),
      createMemoryEntry({ id: 'verified', category: 'VERIFIED_FACTS', scope: 'global', content: 'fact', evidenceType: 'VERIFIED_DATA', ...baseEntry }),
    ];
    const result = retrieveMemory(entries, { limit: 2 });
    assert.equal(result[0].id, 'verified');
  });

  it('prefers fresher entries within the same category', () => {
    const entries = [
      createMemoryEntry({ id: 'old', category: 'EXPERIMENT_RESULTS', scope: 'global', content: 'old', evidenceType: 'VERIFIED_DATA', provenance: 'test', createdAt: '2026-01-01T00:00:00.000Z' }),
      createMemoryEntry({ id: 'new', category: 'EXPERIMENT_RESULTS', scope: 'global', content: 'new', evidenceType: 'VERIFIED_DATA', provenance: 'test', createdAt: '2026-09-17T00:00:00.000Z' }),
    ];
    const result = retrieveMemory(entries, { limit: 2, now: new Date('2026-09-18T00:00:00.000Z') });
    assert.equal(result[0].id, 'new');
  });

  it('enforces the bounded limit (no wholesale history dumps)', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      createMemoryEntry({ id: `m${i}`, category: 'USER_ENTERED', scope: 'global', content: `entry ${i}`, evidenceType: 'USER_ENTERED', ...baseEntry }),
    );
    const result = retrieveMemory(entries, { limit: 5 });
    assert.equal(result.length, 5);
  });

  it('converts memory into compact context items with provenance', () => {
    const entries = [
      createMemoryEntry({ id: 'a', category: 'BUSINESS_DECISIONS', scope: 'global', content: 'Paused product X', evidenceType: 'USER_ENTERED', ...baseEntry }),
    ];
    const items = memoryToContextItems(entries);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'BUSINESS_DECISIONS · global');
    assert.equal(items[0].evidenceType, 'USER_ENTERED');
  });
});
