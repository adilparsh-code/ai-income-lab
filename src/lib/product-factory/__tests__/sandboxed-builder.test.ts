// Phase 5.4 — Sandboxed builder tests: sandbox enforcement, build lifecycle,
// quality gates, provenance, bounded retry, determinism.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeterministicSpecCompiler,
  decideBuildRetry,
  describeBuilderCapabilities,
  getMaxBuildAttempts,
  buildOutcomeToTransitions,
} from '../sandboxed-builder';
import { resolveProductBuilder } from '../build-contract';
import type { PublishableProductSpec } from '@/lib/publishing/contract';

function validSpec(): PublishableProductSpec {
  return {
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
    pricingHypothesis: 'Single purchase price to be tested',
    distributionChannels: ['Direct website'],
    risks: ['Limited initial evidence'],
    assumptions: ['Parents want structured plans'],
    evidence: [{ type: 'VERIFIED_DATA', content: 'Recorded validation result' }],
    evidenceProvenance: 'AI_INFERENCE',
  };
}

describe('sandbox enforcement', () => {
  it('every declared capability is sandboxed and deterministic', () => {
    for (const cap of describeBuilderCapabilities()) {
      assert.equal(cap.sandboxed, true);
      assert.equal(cap.deterministic, true);
    }
  });

  it('the adapter type itself is literal sandboxed=true', () => {
    const builder = new DeterministicSpecCompiler();
    assert.equal(builder.sandboxed, true);
    assert.equal(builder.deterministic, true);
  });

  it('describes capabilities without overstating (no toolchain claims)', () => {
    const caps = describeBuilderCapabilities();
    assert.ok(caps.length > 0);
    for (const cap of caps) {
      assert.equal(/compiler|toolchain/i.test(cap.description) && /gcc|rustc|node binary/i.test(cap.description), false);
    }
  });
});

describe('build lifecycle', () => {
  it('succeeds on a valid spec and produces provenance-stamped artifacts', async () => {
    const builder = new DeterministicSpecCompiler();
    const outcome = await builder.build(builder.normalizeRequest({ productId: 'p1', spec: validSpec(), attempt: 0 }));
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.failureClass, null);
    assert.ok(outcome.artifacts.length >= 3);
    for (const artifact of outcome.artifacts) {
      assert.equal(artifact.provenance, 'AI_GENERATED');
      assert.match(artifact.contentHash, /^[0-9a-f]{64}$/);
      assert.ok(artifact.sizeBytes > 0);
    }
    assert.ok(outcome.version);
  });

  it('is deterministic: identical (spec, attempt) → identical hashes', async () => {
    const builder = new DeterministicSpecCompiler();
    const a = await builder.build(builder.normalizeRequest({ productId: 'p1', spec: validSpec(), attempt: 0 }));
    const b = await builder.build(builder.normalizeRequest({ productId: 'p1', spec: validSpec(), attempt: 0 }));
    assert.equal(a.determinismHash, b.determinismHash);
    assert.deepEqual(a.artifacts.map((x) => x.contentHash), b.artifacts.map((x) => x.contentHash));
  });

  it('classifies invalid specs as SPEC_INVALID with no artifacts', async () => {
    const spec = validSpec();
    spec.mvpFeatures = [];
    const builder = new DeterministicSpecCompiler();
    const outcome = await builder.build(builder.normalizeRequest({ productId: 'p1', spec, attempt: 0 }));
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.failureClass, 'SPEC_INVALID');
    assert.equal(outcome.artifacts.length, 0);
    assert.equal(outcome.version, null);
  });

  it('normalizes attempts into the bounded range', () => {
    const builder = new DeterministicSpecCompiler();
    const request = builder.normalizeRequest({ productId: 'p1', spec: validSpec(), attempt: 99 });
    assert.ok(request.attempt < getMaxBuildAttempts());
  });
});

describe('bounded retry contract', () => {
  it('never retries deterministic failures', async () => {
    const builder = new DeterministicSpecCompiler();
    const spec = validSpec();
    spec.mvpFeatures = [];
    const failed = await builder.build(builder.normalizeRequest({ productId: 'p1', spec, attempt: 0 }));
    const decision = decideBuildRetry(failed);
    assert.equal(decision.retry, false);
    assert.match(decision.reason, /deterministic|changed spec/i);
  });

  it('allows one bounded retry only for transient failures', () => {
    const decision = decideBuildRetry({
      status: 'FAILED', failureClass: 'TRANSIENT', artifacts: [], qualityGates: [],
      tests: { total: 0, passed: 0, failed: 0 }, logSummary: '', version: null, attempt: 0, determinismHash: 'x', errors: [],
    });
    assert.equal(decision.retry, true);
    assert.equal(decision.nextAttempt, 1);

    const exhausted = decideBuildRetry({
      status: 'FAILED', failureClass: 'TRANSIENT', artifacts: [], qualityGates: [],
      tests: { total: 0, passed: 0, failed: 0 }, logSummary: '', version: null, attempt: getMaxBuildAttempts() - 1, determinismHash: 'x', errors: [],
    });
    assert.equal(exhausted.retry, false);
    assert.match(exhausted.reason, /bound reached/);
  });

  it('refuses retries for unknown failure classes', () => {
    const decision = decideBuildRetry({
      status: 'FAILED', failureClass: 'UNKNOWN', artifacts: [], qualityGates: [],
      tests: { total: 0, passed: 0, failed: 0 }, logSummary: '', version: null, attempt: 0, determinismHash: 'x', errors: [],
    });
    assert.equal(decision.retry, false);
  });

  it('maps outcomes onto valid lifecycle transitions', async () => {
    const builder = new DeterministicSpecCompiler();
    const ok = await builder.build(builder.normalizeRequest({ productId: 'p1', spec: validSpec(), attempt: 0 }));
    assert.deepEqual(buildOutcomeToTransitions(ok), { onStarted: 'BUILD', onTested: 'START_TESTING', onFinish: 'TEST_PASS' });
  });
});

describe('Phase 5.3 boundary intact', () => {
  it('resolveProductBuilder still refuses non-sandboxed builders', () => {
    // The Phase 5.3 resolver returns null (no external builder connected);
    // the sandboxed compiler is reachable only through resolveSandboxedBuilder.
    const builder = resolveProductBuilder();
    if (builder !== null) {
      assert.equal(builder.sandboxed, true);
    }
  });
});
