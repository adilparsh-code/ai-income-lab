import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalHashOf,
  canonicalSpecificationOf,
  toCanonicalJson,
  canonicalize,
  asCanonicalRecord,
  sha256Hex,
  SPEC_CANONICAL_FIELD_ORDER,
} from '../canonical';

describe('canonicalization', () => {
  it('sha256Hex is deterministic', () => {
    assert.equal(sha256Hex('x'), sha256Hex('x'));
    assert.notEqual(sha256Hex('x'), sha256Hex('y'));
  });

  it('canonicalize rejects non-plain objects', () => {
    assert.throws(() => canonicalize(new Date('2026-01-01')), /Unsupported|cannot|plain|object/i);
    assert.throws(() => canonicalize(/abc/), /Unsupported|cannot|plain|object/i);
  });

  it('canonicalize rejects non-finite numbers', () => {
    assert.throws(() => canonicalize(NaN), /Non-finite/i);
    assert.throws(() => canonicalize(Infinity), /Non-finite/i);
  });

  it('asCanonicalRecord rejects non-plain objects', () => {
    assert.throws(() => asCanonicalRecord(new Date()), /plain JSON objects/i);
    assert.throws(() => asCanonicalRecord(/abc/), /plain JSON objects/i);
  });

  it('canonicalSpecificationOf includes only canonical fields in fixed order', () => {
    const src = {
      productType: 'DIGITAL_PRODUCT',
      name: 'A',
      targetAudience: 'parents',
      problem: 'messy planning',
      valueProposition: 'structured plans',
      mvpFeatures: [{ name: 'planner', description: 'weekly plan', priority: 'P0' }],
      buildPhases: [{ phase: 1, name: 'core', tasks: ['build'], expectedOutput: 'planner', risk: 'low' }],
      monetizationModel: 'ONE_TIME_PURCHASE',
      pricingHypothesis: 'single price',
      distributionChannels: ['website'],
      risks: ['early'],
      assumptions: ['parents want structure'],
      evidence: [{ type: 'VERIFIED_DATA', content: 'x' }],
      evidenceProvenance: 'AI_INFERENCE',
      solution: 'a tool',
      userFlows: '["onboard"]',
      techRequirements: '["nextjs"]',
      acceptanceCriteria: '["renders"]',
      extraVolatileField: 'should be ignored',
    };
    const canon = canonicalSpecificationOf(src);
    const keys = Object.keys(canon);
    assert.deepEqual(keys, SPEC_CANONICAL_FIELD_ORDER);
    assert.equal(canon.extraVolatileField, undefined);
  });

  it('omitted fields become null so the canonical form is structurally stable', () => {
    const empty = canonicalSpecificationOf({});
    for (const field of SPEC_CANONICAL_FIELD_ORDER) {
      assert.equal(empty[field], null, `field ${field} should be null when omitted`);
    }
  });

  it('canonical representation is deterministic across construction order', () => {
    const a = canonicalSpecificationOf({
      productType: 'DIGITAL_PRODUCT',
      name: 'Planner',
      mvpFeatures: [{ priority: 'P0', name: 'planner', description: 'weekly' }],
    });
    const b = canonicalSpecificationOf({
      name: 'Planner',
      productType: 'DIGITAL_PRODUCT',
      mvpFeatures: [{ description: 'weekly', name: 'planner', priority: 'P0' }],
    });
    assert.deepEqual(a, b);
  });

  it('canonical hash is stable for equivalent specs regardless of key order', () => {
    const specA = {
      productType: 'DIGITAL_PRODUCT',
      name: 'Homeschool Planner',
      targetAudience: 'Homeschool parents',
      problem: 'Planning lessons takes too long',
      valueProposition: 'Structured weekly plans in minutes',
      mvpFeatures: [
        { name: 'Weekly Planner', description: 'Generates a weekly lesson plan', priority: 'P0' },
        { name: 'Progress Tracker', description: 'Tracks completed lessons', priority: 'P1' },
      ],
      buildPhases: [{ phase: 1, name: 'Core', tasks: ['Build planner'], expectedOutput: 'Working planner', risk: 'Low' }],
      monetizationModel: 'ONE_TIME_PURCHASE',
      pricingHypothesis: 'Single purchase price',
      distributionChannels: ['Direct website'],
      risks: ['Limited initial evidence'],
      assumptions: ['Parents want structured plans'],
      evidence: [{ type: 'VERIFIED_DATA', content: 'Recorded validation result' }],
      evidenceProvenance: 'AI_INFERENCE',
      solution: 'A planning tool',
      userFlows: '["onboard","plan","track"]',
      techRequirements: '["nextjs"]',
      acceptanceCriteria: '["renders"]',
    };
    const shuffled: Record<string, unknown> = {};
    const specARec = specA as Record<string, unknown>;
    for (const key of Object.keys(specARec).reverse()) {
      shuffled[key] = specARec[key];
    }
    assert.equal(canonicalHashOf(specA), canonicalHashOf(shuffled));
    const nestedShuffled = {
      ...specA,
      mvpFeatures: specA.mvpFeatures.map((f: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(f).reverse()) out[k] = f[k];
        return out;
      }),
    };
    assert.equal(canonicalHashOf(specA), canonicalHashOf(nestedShuffled));
  });

  it('canonical hash differs when meaningful content differs', () => {
    const base = { productType: 'DIGITAL_PRODUCT', name: 'A', mvpFeatures: [] };
    assert.notEqual(canonicalHashOf(base), canonicalHashOf({ ...base, name: 'B' }));
  });

  it('toCanonicalJson produces stable deterministic text', () => {
    const spec = { b: 1, a: 2, c: { z: 9, y: 8 } };
    const text = toCanonicalJson(spec);
    assert.equal(text, '{"a":2,"b":1,"c":{"y":8,"z":9}}');
  });

  it('canonicalization does not include any volatile metadata', () => {
    const spec = {
      productType: 'DIGITAL_PRODUCT',
      name: 'X',
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'db-id-123',
      correlationId: 'corr-1',
      attempt: 3,
    };
    const canonText = toCanonicalJson(canonicalSpecificationOf(spec));
    assert.ok(!canonText.includes('createdAt'));
    assert.ok(!canonText.includes('db-id-123'));
    assert.ok(!canonText.includes('corr-1'));
    assert.ok(!canonText.includes('"attempt"'));
  });
});
