// Phase 6 — Evidence-strength classification tests.
// Deterministic: provenance and data availability decide; AI confidence never
// influences the result.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvidenceStrength,
  strengthRoutingHint,
  type EvidenceStrengthInput,
} from '../evidence-strength';

function base(overrides: Partial<EvidenceStrengthInput> = {}): EvidenceStrengthInput {
  return {
    presentEvidenceTypes: [],
    hasOutcomeData: false,
    hasPositiveOutlook: false,
    outcomesAreNonPositive: false,
    ...overrides,
  };
}

describe('evidence strength classification', () => {
  it('classifies MISSING when nothing is on file', () => {
    const r = classifyEvidenceStrength(base());
    assert.equal(r.strength, 'MISSING');
    assert.match(r.basis, /No evidence/);
  });

  it('classifies INFERRED when only AI inference exists', () => {
    const r = classifyEvidenceStrength(base({ presentEvidenceTypes: ['AI_INFERENCE'] }));
    assert.equal(r.strength, 'INFERRED');
    assert.match(r.basis, /Only AI inference/);
  });

  it('classifies VERIFIED with verified evidence and outcome data', () => {
    const r = classifyEvidenceStrength(
      base({ presentEvidenceTypes: ['VERIFIED_DATA', 'AI_INFERENCE'], hasOutcomeData: true }),
    );
    assert.equal(r.strength, 'VERIFIED');
  });

  it('classifies SUPPORTED when verified evidence lacks outcomes', () => {
    const r = classifyEvidenceStrength(base({ presentEvidenceTypes: ['VERIFIED_DATA'] }));
    assert.equal(r.strength, 'SUPPORTED');
  });

  it('classifies SUPPORTED for user-entered records without verified evidence', () => {
    const r = classifyEvidenceStrength(base({ presentEvidenceTypes: ['USER_ENTERED'] }));
    assert.equal(r.strength, 'SUPPORTED');
  });

  it('classifies CONFLICTING when verified outcomes contradict a positive outlook', () => {
    const r = classifyEvidenceStrength(
      base({
        presentEvidenceTypes: ['VERIFIED_DATA', 'AI_INFERENCE'],
        hasOutcomeData: true,
        hasPositiveOutlook: true,
        outcomesAreNonPositive: true,
      }),
    );
    assert.equal(r.strength, 'CONFLICTING');
    assert.match(r.basis, /outranks/);
  });

  it('CONFLICTING wins even with strong verified provenance', () => {
    const strong = classifyEvidenceStrength(
      base({
        presentEvidenceTypes: ['VERIFIED_DATA', 'USER_ENTERED'],
        hasOutcomeData: true,
        hasPositiveOutlook: true,
        outcomesAreNonPositive: true,
      }),
    );
    assert.equal(strong.strength, 'CONFLICTING');
  });

  it('never escalates on AI-only positive outlooks', () => {
    const r = classifyEvidenceStrength(
      base({ presentEvidenceTypes: ['AI_INFERENCE'], hasOutcomeData: true, hasPositiveOutlook: true }),
    );
    assert.notEqual(r.strength, 'VERIFIED');
  });

  it('routing hints cover every strength deterministically', () => {
    for (const s of ['VERIFIED', 'SUPPORTED', 'PARTIAL', 'INFERRED', 'MISSING', 'CONFLICTING'] as const) {
      const hint = strengthRoutingHint(s);
      assert.equal(typeof hint, 'string');
      assert.ok(hint.length > 0);
    }
  });
});
