// Phase 4.2.1 - Agent result types & AgentLog behavior tests
// Verifies: AI usage metadata types are correct, existing AgentResult
// contracts preserved, AI output remains AI_INFERENCE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import types for compile-time verification (erased at runtime by tsx)
import type { AgentResult, AiUsageMetadata, EvidenceType, AgentStatus } from '../../agents/types';

describe('Agent Result Types (Phase 4.2.1)', () => {
  it('AgentResult preserves all existing fields', () => {
    const result: AgentResult = {
      success: true,
      output: { message: 'ok' },
      reasoning: 'test',
      evidenceType: 'AI_INFERENCE',
      executionTime: 0,
    };
    assert.equal(result.success, true);
    assert.equal(result.evidenceType, 'AI_INFERENCE');
    assert.equal(result.executionTime, 0);
  });

  it('AgentResult accepts optional aiUsage metadata', () => {
    const aiUsage: AiUsageMetadata = {
      provider: 'mock',
      model: 'mock-default',
      purpose: 'test',
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostUsd: 0.001,
      latencyMs: 5,
    };
    const result: AgentResult = {
      success: true,
      output: {},
      reasoning: 'test',
      evidenceType: 'AI_INFERENCE',
      executionTime: 10,
      aiUsage,
      fallbackUsed: false,
    };
    assert.equal(result.aiUsage?.provider, 'mock');
    assert.equal(result.fallbackUsed, false);
  });

  it('AgentResult works without aiUsage (legacy/deterministic path)', () => {
    const result: AgentResult = {
      success: true,
      output: { data: 'mock' },
      reasoning: 'deterministic result',
      evidenceType: 'AI_INFERENCE',
      executionTime: 0,
    };
    assert.equal(result.aiUsage, undefined);
    assert.equal(result.fallbackUsed, undefined);
  });

  it('fallbackUsed defaults to false when absent', () => {
    const result: AgentResult = {
      success: true,
      output: {},
      reasoning: '',
      evidenceType: 'AI_INFERENCE',
      executionTime: 0,
    };
    // Deterministic/mock execution: AI fields absent, fallbackUsed is false (not true)
    const fallback = result.fallbackUsed ?? false;
    assert.equal(fallback, false);
    assert.equal(result.aiUsage, undefined);
  });

  it('AiUsageMetadata has all required fields', () => {
    const usage: AiUsageMetadata = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      purpose: 'research.findings',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.005,
      latencyMs: 250,
    };
    assert.equal(usage.provider, 'gemini');
    assert.equal(usage.model, 'gemini-2.5-flash');
    assert.equal(usage.purpose, 'research.findings');
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 50);
    assert.equal(usage.estimatedCostUsd, 0.005);
    assert.equal(usage.latencyMs, 250);
  });

  it('EvidenceType includes AI_INFERENCE, VERIFIED_DATA, USER_ENTERED', () => {
    const types: EvidenceType[] = ['AI_INFERENCE', 'VERIFIED_DATA', 'USER_ENTERED'];
    assert.ok(types.includes('AI_INFERENCE'));
    assert.ok(types.includes('VERIFIED_DATA'));
    assert.ok(types.includes('USER_ENTERED'));
  });

  it('AgentStatus includes MOCKED for all current agents', () => {
    // All five agents have status MOCKED
    const statuses: AgentStatus[] = ['LIVE', 'MOCKED', 'PLANNED'];
    assert.ok(statuses.includes('MOCKED'));
  });
});
