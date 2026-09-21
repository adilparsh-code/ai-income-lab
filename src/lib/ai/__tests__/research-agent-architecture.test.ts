// Phase 4.2.2 — Architecture guards.
// Verifies the Research Agent stays provider-agnostic and that the generic AI
// generation layer is the only place that wires concrete providers. Reads
// source files directly (no runtime imports / no DB).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const read = (rawPath: string): string => readFileSync(resolve(ROOT, rawPath), 'utf8');

describe('Provider-agnostic architecture (Phase 4.2.2)', () => {
  it('Research Agent does NOT import the Gemini adapter directly', () => {
    const source = read('src/lib/agents/research-agent.ts');
    const importLines = source.split('\n').filter((l) => l.trim().startsWith('import'));
    assert.ok(importLines.every((l) => !/gemini/i.test(l)), 'no import line may reference gemini');
    assert.ok(!source.includes('GeminiProvider'), 'must not reference GeminiProvider');
  });

  it('Research Agent uses the generic AI generation layer', () => {
    const source = read('src/lib/agents/research-agent.ts');
    assert.ok(/generateValidated/.test(source), 'must call the generic generation function');
    assert.ok(/['"]@\/lib\/ai\/generate['"]|['"]\.\.\/ai\/generate['"]/.test(source), 'must import the generic orchestrator');
  });

  it('Research Agent uses the provider-agnostic research helpers (not a concrete provider)', () => {
    const source = read('src/lib/agents/research-agent.ts');
    assert.ok(source.includes('RESEARCH_SCHEMA'));
    assert.ok(source.includes('buildResearchPrompt'));
    assert.ok(source.includes('buildResearchResult'));
    assert.ok(source.includes('evaluateHalalGate'));
  });

  it('the Gemini adapter is resolved only in the generic orchestrator', () => {
    const source = read('src/lib/ai/generate.ts');
    assert.ok(source.includes('buildGeminiProvider'), 'orchestrator wires the Gemini adapter');
  });

  it('the research layer never imports a concrete provider', () => {
    const source = read('src/lib/ai/research.ts');
    const importLines = source.split('\n').filter((l) => l.trim().startsWith('import'));
    assert.ok(importLines.every((l) => !/gemini/i.test(l)), 'research helpers must not import Gemini');
    assert.ok(importLines.every((l) => !/openai/i.test(l)), 'research helpers must not import OpenAI');
  });

  it('adding another provider would not require Research Agent changes', () => {
    const source = read('src/lib/agents/research-agent.ts');
    const importLines = source.split('\n').filter((l) => l.trim().startsWith('import'));
    assert.ok(importLines.every((l) => !/[\\/]gemini|[\\/]openai/.test(l)), 'agent must not import a concrete provider');
    assert.ok(!source.includes('provider.generate('), 'agent must not invoke a provider directly');
    assert.ok(!source.includes('resolveProviderId('), 'agent must not branch on provider id directly');
  });
});