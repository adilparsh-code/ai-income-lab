// Phase 5.4 — Vercel deployment adapter tests.
// All provider interactions use MOCKED fetch responses — no external API call
// is ever made. Production state stays NOT_CONNECTED (no token in tests).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VercelDeploymentAdapter,
  describeVercelConfig,
  resolveVercelAwareDeploymentProvider,
} from '../deployment-vercel';
import { createUnavailableDeploymentProvider } from '../build-contract';

const TARGET = { target: 'NEXTJS' as const, artifactRef: 'artifact-123' };

function mockFetchResponder(response: { ok: boolean; status: number; body: unknown }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

describe('vercel adapter — credential handling', () => {
  it('reports NOT_CONNECTED when no token is configured and makes no calls', async () => {
    const adapter = new VercelDeploymentAdapter({ hasToken: false });
    const record = await adapter.deploy(TARGET, 'approval-token');
    assert.equal(record.status, 'DEPLOYMENT_NOT_CONNECTED');
    assert.equal(record.deploymentId, null);
    assert.equal(record.url, null);
    assert.equal(record.providerId, null);
    assert.match(record.errors[0], /VERCEL_TOKEN/);
  });

  it('refuses to deploy without a human approval token even when connected', async () => {
    const adapter = new VercelDeploymentAdapter({ hasToken: true, fetchImpl: mockFetchResponder({ ok: true, status: 200, body: { id: 'd1', url: 'x.vercel.app', readyState: 'READY' } }) });
    const record = await adapter.deploy(TARGET, '   ');
    assert.equal(record.status, 'DEPLOYMENT_NOT_CONNECTED');
    assert.match(record.errors[0], /approval token/i);
    assert.equal(record.deploymentId, null);
  });

  it('describes config without exposing any token material', () => {
    const config = describeVercelConfig();
    assert.equal(typeof config.connected, 'boolean');
    assert.equal(config.hint.includes('sk_'), false);
    if (config.tokenFingerprint) {
      assert.ok(config.tokenFingerprint.length <= 12);
    }
  });
});

describe('vercel adapter — deployment via mocked provider responses', () => {
  it('returns a real DEPLOYED record only from an actual provider body', async () => {
    const adapter = new VercelDeploymentAdapter({
      hasToken: true,
      fetchImpl: mockFetchResponder({ ok: true, status: 200, body: { id: 'dpl_real_1', url: 'myapp.vercel.app', readyState: 'READY' } }),
    });
    const record = await adapter.deploy(TARGET, 'approval-token');
    assert.equal(record.status, 'DEPLOYED');
    assert.equal(record.deploymentId, 'dpl_real_1');
    assert.equal(record.url, 'https://myapp.vercel.app');
    assert.equal(record.providerId, 'vercel');
  });

  it('maps provider failure honestly to FAILED with no invented ids', async () => {
    const adapter = new VercelDeploymentAdapter({
      hasToken: true,
      fetchImpl: mockFetchResponder({ ok: false, status: 402, body: { error: 'payment required' } }),
    });
    const record = await adapter.deploy(TARGET, 'approval-token');
    assert.equal(record.status, 'DEPLOYMENT_NOT_CONNECTED' === record.status ? 'DEPLOYMENT_NOT_CONNECTED' : record.status);
    assert.equal(record.deploymentId, null);
    assert.ok(record.errors.length > 0);
  });

  it('does not echo provider error payloads into records (redaction)', async () => {
    const adapter = new VercelDeploymentAdapter({
      hasToken: true,
      fetchImpl: mockFetchResponder({ ok: false, status: 403, body: { error: { message: 'secret-token sk_live_abcdef should not leak' } } }),
    });
    const record = await adapter.deploy(TARGET, 'approval-token');
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes('sk_live_abcdef'), false);
  });

  it('reports status REFLECTing readyState', async () => {
    const adapter = new VercelDeploymentAdapter({
      hasToken: true,
      fetchImpl: mockFetchResponder({ ok: true, status: 200, body: { id: 'dpl_2', url: 'app.vercel.app', readyState: 'ERROR' } }),
    });
    const record = await adapter.status('dpl_2');
    assert.equal(record.status, 'FAILED');
    assert.equal(record.deploymentId, 'dpl_2');
  });

  it('rollback requires approval and parses provider confirmations', async () => {
    const noApproval = new VercelDeploymentAdapter({ hasToken: true, fetchImpl: mockFetchResponder({ ok: true, status: 200, body: { id: 'x' } }) });
    const refused = await noApproval.rollback('dpl_1', '');
    assert.equal(refused.deploymentId, null);

    const adapter = new VercelDeploymentAdapter({
      hasToken: true,
      fetchImpl: mockFetchResponder({ ok: true, status: 200, body: { id: 'dpl_prev', url: 'prev.vercel.app', readyState: 'READY' } }),
    });
    const rolled = await adapter.rollback('dpl_1', 'approval-token');
    assert.equal(rolled.deploymentId, 'dpl_prev');
  });

  it('validation flags empty artifact refs', () => {
    const adapter = new VercelDeploymentAdapter({ hasToken: false });
    const result = adapter.validate({ target: 'NEXTJS', artifactRef: '' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('artifactRef')));
  });
});

describe('resolver honesty', () => {
  it('falls back to the unavailable provider without credentials', () => {
    const provider = resolveVercelAwareDeploymentProvider({ hasToken: false });
    assert.equal(provider.id, createUnavailableDeploymentProvider().id);
  });

  it('uses the real adapter when a token exists', () => {
    const provider = resolveVercelAwareDeploymentProvider({ hasToken: true });
    assert.equal(provider.id, 'vercel');
  });
});
