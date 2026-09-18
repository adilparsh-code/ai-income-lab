// Phase 5.5 — AI capability discovery tests.
//
// HONESTY RULE under test: an env var is NOT proof of a working provider.
// LIVE is issued only after a real (or injected, in tests) successful
// generation round trip through the provider adapter. No network in tests —
// the verification round trip is injected via the seam.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AiProviderError } from '../provider';

const importCapability = () => import('../capability');

describe('AI capability discovery', () => {
  let savedProvider: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.AI_PROVIDER;
    savedKey = process.env.AI_PROVIDER_API_KEY;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_PROVIDER_API_KEY;
  });

  afterEach(() => {
    if (savedProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = savedProvider;
    if (savedKey === undefined) delete process.env.AI_PROVIDER_API_KEY;
    else process.env.AI_PROVIDER_API_KEY = savedKey;
  });

  it('reports MOCKED with deterministic-mock model when AI_PROVIDER is mock', async () => {
    process.env.AI_PROVIDER = 'mock';
    const { describeAiCapability } = await importCapability();

    const cap = describeAiCapability();
    assert.equal(cap.status, 'MOCKED');
    assert.equal(cap.providerId, 'mock');
    assert.equal(cap.model, 'deterministic-mock');
    assert.equal(cap.verifiedAt, null);
    assert.ok(cap.requiredToActivate.includes('AI_PROVIDER=gemini'));
    // Honesty: detail must not contain key material.
    assert.ok(!cap.detail.includes('key='));
  });

  it('reports NOT_CONFIGURED when a real provider is selected but the key is missing', async () => {
    process.env.AI_PROVIDER = 'gemini';
    delete process.env.AI_PROVIDER_API_KEY;
    const { describeAiCapability } = await importCapability();

    const cap = describeAiCapability();
    assert.equal(cap.status, 'NOT_CONFIGURED');
    assert.equal(cap.model, null);
    assert.ok(cap.requiredToActivate.includes('AI_PROVIDER_API_KEY'));
    assert.equal(cap.lastErrorCategory, null);
  });

  it('refuses LIVE from a key check alone — ERROR until a round trip succeeds', async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_PROVIDER_API_KEY = 'test-key-never-logged';
    const { describeAiCapability } = await importCapability();

    const cap = describeAiCapability();
    // No verification round trip has happened: the honest label is ERROR
    // (configured but unverified), never LIVE.
    assert.equal(cap.status, 'ERROR');
    assert.ok(cap.requiredToActivate[0].includes('round trip'));
  });

  it('issues LIVE only after a successful verification round trip, and caches it', async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_PROVIDER_API_KEY = 'test-key-never-logged';
    const capability = await importCapability();
    capability.__resetAiCapabilityCache();
    capability.__setAiCapabilityVerifySeam(() => Promise.resolve());

    try {
      const verified = await capability.verifyAiProvider();
      assert.equal(verified.status, 'LIVE');
      assert.ok(verified.verifiedAt);
      assert.equal(verified.lastErrorCategory, null);

      // Cached within TTL: describe agrees without re-verifying.
      const cached = capability.describeAiCapability();
      assert.equal(cached.status, 'LIVE');
    } finally {
      capability.__resetAiCapabilityCache();
      capability.__resetAiCapabilityVerifySeam();
    }
  });

  it('keeps the label non-LIVE with a typed error category when verification fails', async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_PROVIDER_API_KEY = 'test-key-never-logged';
    const capability = await importCapability();
    capability.__resetAiCapabilityCache();
    capability.__setAiCapabilityVerifySeam(() =>
      Promise.reject(new AiProviderError('503 upstream', { category: 'provider_unavailable' }))
    );

    try {
      const verified = await capability.verifyAiProvider();
      assert.equal(verified.status, 'ERROR');
      assert.equal(verified.lastErrorCategory, 'provider_unavailable');
      assert.equal(verified.verifiedAt, null);
      // Failure is not cached: the report must not pretend recovery.
      assert.equal(capability.describeAiCapability().status, 'ERROR');
      // No secret material in the report.
      assert.ok(!verified.detail.includes('test-key-never-logged'));
    } finally {
      capability.__resetAiCapabilityCache();
      capability.__resetAiCapabilityVerifySeam();
    }
  });
});
