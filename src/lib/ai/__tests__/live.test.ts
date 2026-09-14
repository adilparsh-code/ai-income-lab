// Phase 4.2.2 — LIVE Gemini integration tests (require a real key + network).
//
// These tests are EXCLUDED from the normal `npm test` suite. They only run when
// explicitly enabled via:
//   AI_LIVE_TESTS=true AI_PROVIDER=gemini AI_PROVIDER_API_KEY=<key> npm test
//
// They deliberately perform a REAL Gemini call with the research schema to prove
// the full provider-agnostic path works end-to-end. No fake live results here.
// The standard CI/test suite never depends on these.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateValidated } from '../generate';
import { getModelPolicy } from '../models';
import { RESEARCH_SCHEMA, buildResearchPrompt } from '../research';

const LIVE = process.env.AI_LIVE_TESTS === 'true';
const KEY_SET = Boolean(process.env.AI_PROVIDER_API_KEY && process.env.AI_PROVIDER_API_KEY.length > 0);
const PROVIDER_OK = process.env.AI_PROVIDER === 'gemini';

const skipReason = !LIVE
  ? 'AI_LIVE_TESTS not enabled; skipping live tests'
  : !KEY_SET || !PROVIDER_OK
    ? 'AI_PROVIDER=gemini and AI_PROVIDER_API_KEY required for live tests'
    : false;

describe('Live Gemini research round-trip (Phase 4.2.2)', { skip: skipReason }, () => {
  it('performs a real structured research generation through the generic layer', async () => {
    const policy = getModelPolicy('research.findings');
    const prompt = buildResearchPrompt({
      researchObjective: 'Identify a halal-friendly, low-startup-coast digital product niche for teachers.',
      halalConsiderations: [],
    });

    const outcome = await generateValidated(
      prompt,
      'research.findings',
      RESEARCH_SCHEMA,
      { model: policy.model, maxOutputTokens: policy.maxOutputTokens, temperature: policy.temperature }
    );

    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' | '));
    if (outcome.ok) {
      assert.ok(typeof outcome.value.summary === 'string' && outcome.value.summary.length > 0);
      assert.ok(Array.isArray(outcome.value.demandSignals));
      assert.ok(Array.isArray(outcome.value.risks));
      assert.equal(outcome.usage.provider, 'gemini');
      assert.ok(outcome.usage.inputTokens >= 0);
      assert.ok(outcome.usage.outputTokens >= 0);
    }
  });
});