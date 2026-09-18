// Phase 4.2.3 — Architecture guards for the Validation and Product agents.
// Mirrors the Research Agent guards: neither agent may import a concrete AI
// provider, branch on provider identity, or bypass the generic generation
// layer. Reads source files directly (no runtime imports / no DB).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const read = (rawPath: string): string => readFileSync(resolve(ROOT, rawPath), 'utf8');

describe('Validation Agent provider-agnostic architecture (Phase 4.2.3)', () => {
  const source = read('src/lib/agents/validation-agent.ts');
  const importLines = source.split('\n').filter((l) => l.trim().startsWith('import'));

  it('does NOT import a concrete AI provider', () => {
    assert.ok(importLines.every((l) => !/gemini|openai/i.test(l)), 'no import line may reference a concrete provider');
    assert.ok(!source.includes('GeminiProvider'), 'must not reference GeminiProvider');
    assert.ok(!/provider\.generate\(/.test(source), 'must not invoke a provider directly');
  });

  it('uses the generic AI generation layer with the validation purpose', () => {
    assert.ok(source.includes('generateValidated'), 'must call the generic generation function');
    assert.ok(/['"]@\/lib\/ai\/generate['"]|['"]\.\.\/ai\/generate['"]/.test(source), 'must import the generic orchestrator');
    assert.ok(source.includes("buildValidationPrompt"), 'must use the shared prompt builder');
    assert.ok(source.includes('VALIDATION_AI_SCHEMA'), 'must use the shared schema');
    assert.ok(source.includes('normalizeValidationAiOutput'), 'must normalize model output defensively');
  });

  it('hard-blocks NOT_ALLOWED before any AI call', () => {
    // The blocked branch must return before generateValidated is reached.
    const blockedIdx = source.indexOf("validationBlocked = true");
    const gateIdx = source.indexOf("const mode = getExecutionMode()");
    assert.ok(blockedIdx >= 0 && gateIdx > blockedIdx, 'NOT_ALLOWED block must precede execution-mode resolution');
  });

  it('fails closed to the deterministic fallback when live AI fails', () => {
    assert.ok(source.includes('buildMockValidationOutput'), 'mock/fallback builder must exist');
    assert.ok(source.includes('fallbackUsed: true'), 'fallback must be flagged');
  });

  it('never promotes AI output to VERIFIED_DATA', () => {
    // No agent-authored VERIFIED_DATA evidence item may exist here: DB
    // provenance enters via upstream context, not as agent-authored items.
    const code = source
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    const verified = [...code.matchAll(/type:\s*'VERIFIED_DATA'/g)].length;
    assert.equal(verified, 0, 'no agent-authored evidence item may claim VERIFIED_DATA');
  });
});

describe('Product Agent provider-agnostic architecture (Phase 4.2.3)', () => {
  const source = read('src/lib/agents/product-agent.ts');
  const importLines = source.split('\n').filter((l) => l.trim().startsWith('import'));

  it('does NOT import a concrete AI provider', () => {
    assert.ok(importLines.every((l) => !/gemini|openai/i.test(l)), 'no import line may reference a concrete provider');
    assert.ok(!source.includes('GeminiProvider'), 'must not reference GeminiProvider');
    assert.ok(!/provider\.generate\(/.test(source), 'must not invoke a provider directly');
  });

  it('uses the generic AI generation layer with the product purpose', () => {
    assert.ok(source.includes('generateValidated'), 'must call the generic generation function');
    assert.ok(/['"]@\/lib\/ai\/generate['"]|['"]\.\.\/ai\/generate['"]/.test(source), 'must import the generic orchestrator');
    assert.ok(source.includes('buildProductPrompt'), 'must use the shared prompt builder');
    assert.ok(source.includes('PRODUCT_AI_SCHEMA'), 'must use the shared schema');
    assert.ok(source.includes('normalizeProductAiOutput'), 'must normalize model output defensively');
  });

  it('hard-blocks NOT_ALLOWED before any AI call', () => {
    const blockedIdx = source.indexOf('isBlocked = true');
    const modeIdx = source.indexOf('const mode = getExecutionMode()');
    assert.ok(blockedIdx >= 0 && modeIdx > blockedIdx, 'NOT_ALLOWED block must precede execution-mode resolution');
  });

  it('loads upstream research/validation context from AgentLog', () => {
    assert.ok(source.includes('loadUpstreamContext'), 'must load upstream context');
    assert.ok(!/researchContext:\s*false/.test(source), 'research context must not be hardcoded false');
    assert.ok(!/validationContext:\s*false/.test(source), 'validation context must not be hardcoded false');
  });

  it('keeps ProductType/MonetizationModel enum compatibility', () => {
    assert.ok(source.includes('VALID_PRODUCT_TYPES'), 'product-type allow-list must exist');
    assert.ok(source.includes('VALID_MONETIZATION_MODELS'), 'monetization allow-list must exist');
  });

  it('never promotes AI output to VERIFIED_DATA', () => {
    // The ONLY permitted VERIFIED_DATA evidence is the database-loaded
    // opportunity record (source: 'Prisma db.opportunity'). Everything derived
    // from model output stays AI_INFERENCE. Comments/docstrings are excluded.
    const code = source
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    const verified = [...code.matchAll(/type:\s*'VERIFIED_DATA'/g)].length;
    assert.equal(verified, 1, 'exactly one VERIFIED_DATA evidence item is permitted (DB-loaded opportunity)');
    assert.match(code, /source:\s*'Prisma db\.opportunity'/, 'the VERIFIED_DATA item must come from the DB record');
  });
});
