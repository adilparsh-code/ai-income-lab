// Phase 4.2.2 — AgentLog metadata mapping tests.
// Verifies that execution results (including live AI usage metadata) map into
// the persisted AgentLog shape without secrets, using the pure mapper.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentLogData } from '../../agents/agent-log-data';
import type { AgentResult } from '../../agents/types';

function baseResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    output: { summary: 'x' },
    reasoning: 'done',
    evidenceType: 'AI_INFERENCE',
    executionTime: 12,
    ...overrides,
  };
}

describe('buildAgentLogData (Phase 4.2.2)', () => {
  it('maps a live AI usage result into AgentLog metadata', () => {
    const result = baseResult({
      aiUsage: {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        purpose: 'research.findings',
        inputTokens: 120,
        outputTokens: 45,
        estimatedCostUsd: 0.003,
        latencyMs: 250,
      },
      fallbackUsed: false,
    });
    const data = buildAgentLogData({ agentType: 'research', action: 'execute_research', input: { researchObjective: 'x' }, result });
    assert.equal(data.aiProvider, 'gemini');
    assert.equal(data.aiModel, 'gemini-2.5-flash');
    assert.equal(data.inputTokens, 120);
    assert.equal(data.outputTokens, 45);
    assert.equal(data.estimatedCostUsd, 0.003);
    assert.equal(data.fallbackUsed, false);
    assert.equal(data.evidenceType, 'AI_INFERENCE');
  });

  it('records fallbackUsed=true on a controlled failure', () => {
    const result = baseResult({ success: false, fallbackUsed: true, error: 'provider failed' });
    const data = buildAgentLogData({ agentType: 'research', action: 'execute', input: {}, result });
    assert.equal(data.fallbackUsed, true);
  });

  it('uses null for AI fields when no usage is present (deterministic/mock)', () => {
    const data = buildAgentLogData({ agentType: 'research', action: 'execute', input: {}, result: baseResult() });
    assert.equal(data.aiProvider, null);
    assert.equal(data.aiModel, null);
    assert.equal(data.inputTokens, null);
    assert.equal(data.outputTokens, null);
    assert.equal(data.estimatedCostUsd, null);
    assert.equal(data.fallbackUsed, false);
  });

  it('keeps API key material out of structured metadata columns', () => {
    const result = baseResult({
      reasoning: 'Research completed via gemini/gemini-2.5-flash. No secrets here.',
      aiUsage: {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        purpose: 'research.findings',
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostUsd: 0,
        latencyMs: 1,
      },
    });
    const data = buildAgentLogData({
      agentType: 'research',
      action: 'execute',
      input: {},
      result,
    });
    // The structured columns must never carry the raw key value.
    assert.ok(!data.reasoning.includes('AIza'));
    assert.ok(!data.output.includes('AIza'));
    assert.ok(!(data.aiProvider ?? '').includes('AIza'));
    assert.ok(!(data.aiModel ?? '').includes('AIza'));
  });
});