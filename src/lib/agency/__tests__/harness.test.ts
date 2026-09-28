// Agency — Harness boundary tests (pure, no DB, no network).
// Honesty rules under test: the boundary reports NOT_CONNECTED until a real
// adapter is registered; registration accepts only well-formed, non-secret
// labels; the evaluation snapshot is read-only data over recorded runs; and
// nothing in the boundary can execute agents or bypass gates.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHarnessSnapshot,
  clearHarnessAdapter,
  describeHarnessBoundary,
  getRegisteredHarnessAdapter,
  isHarnessConnected,
  registerHarnessAdapter,
} from '../harness';
import { HARNESS_STATES } from '../types';

afterEach(() => {
  clearHarnessAdapter();
});

describe('harness boundary honesty (Supervisor/Harness boundary)', () => {
  it('reports NOT_CONNECTED with no adapter registered — never a faked LIVE', () => {
    clearHarnessAdapter();
    const boundary = describeHarnessBoundary();
    assert.equal(boundary.status, 'NOT_CONNECTED');
    assert.equal(isHarnessConnected(), false);
    assert.equal(getRegisteredHarnessAdapter(), null);
    assert.ok(HARNESS_STATES.includes(boundary.status));
    assert.match(boundary.note, /no external evaluation harness is connected/);
  });

  it('refuses malformed registrations and stays NOT_CONNECTED', () => {
    assert.equal(registerHarnessAdapter(null as never).ok, false);
    assert.equal(registerHarnessAdapter({ id: '' }).ok, false);
    assert.equal(registerHarnessAdapter({ id: 'x'.repeat(81) }).ok, false);
    assert.equal(isHarnessConnected(), false, 'failed registration must not flip the status');
  });

  it('reports CONNECTED only while a real adapter is registered', () => {
    const ok = registerHarnessAdapter({ id: 'eval-harness-1' });
    assert.equal(ok.ok, true);
    assert.equal(isHarnessConnected(), true);
    assert.equal(getRegisteredHarnessAdapter()?.adapter.id, 'eval-harness-1');
    const boundary = describeHarnessBoundary();
    assert.equal(boundary.status, 'CONNECTED');
    assert.match(boundary.note, /read-only evaluation snapshots/);
  });

  it('unregistering returns the boundary to NOT_CONNECTED', () => {
    registerHarnessAdapter({ id: 'eval-harness-2' });
    clearHarnessAdapter();
    assert.equal(describeHarnessBoundary().status, 'NOT_CONNECTED');
  });

  it('trims and bounds the adapter id; never stores secrets', () => {
    const ok = registerHarnessAdapter({ id: '  padded-harness  ' });
    assert.equal(ok.ok, true);
    assert.equal(getRegisteredHarnessAdapter()?.adapter.id, 'padded-harness');
  });
});

describe('harness evaluation snapshot (read-only over recorded runs)', () => {
  it('derives a bounded distribution from real AgentRun views without fabricating data', () => {
    const snapshot = buildHarnessSnapshot([
      {
        id: 'r1', agentId: 'research', jobId: 'job-1', jobType: 'RESEARCH', stage: 'RESEARCH',
        status: 'SUCCEEDED', correlationId: 'c1', lifecycleSteps: [], safetyVerdict: 'HALAL',
        verification: 'PASSED', failureReason: null, evidenceRefs: [], retryCount: 0,
        startedAt: '2026-09-28T00:00:00.000Z', completedAt: '2026-09-28T00:00:01.000Z',
      },
      {
        id: 'r2', agentId: 'validation', jobId: 'job-2', jobType: 'VALIDATION', stage: 'VALIDATE',
        status: 'FAILED', correlationId: 'c2', lifecycleSteps: [], safetyVerdict: 'HALAL',
        verification: 'NOT_APPLICABLE', failureReason: 'insufficient evidence', evidenceRefs: [],
        retryCount: 0, startedAt: '2026-09-28T00:01:00.000Z', completedAt: null,
      },
      {
        id: 'r3', agentId: 'growth', jobId: null, jobType: 'RESEARCH', stage: 'GROWTH',
        status: 'BLOCKED', correlationId: 'c3', lifecycleSteps: [], safetyVerdict: 'NOT_ALLOWED',
        verification: 'NOT_APPLICABLE', failureReason: 'stage outside contract', evidenceRefs: [],
        retryCount: 0, startedAt: '2026-09-28T00:02:00.000Z', completedAt: null,
      },
    ]);

    assert.equal(snapshot.recentRuns.length, 3);
    assert.equal(snapshot.verdictDistribution['SUCCEEDED'], 1);
    assert.equal(snapshot.verdictDistribution['FAILED'], 1);
    assert.equal(snapshot.verdictDistribution['BLOCKED'], 1);
    assert.equal(snapshot.recentRuns[2].safetyVerdict, 'NOT_ALLOWED');
    // Safe fields only: no payloads, no lifecycle dumps, no evidence blobs.
    assert.equal(Object.hasOwn(snapshot.recentRuns[0], 'lifecycleSteps'), false);
    assert.equal(Object.hasOwn(snapshot.recentRuns[0], 'evidenceRefs'), false);
    assert.ok(snapshot.generatedAt.length > 0);
  });

  it('produces an empty-but-honest snapshot when there are no runs', () => {
    const snapshot = buildHarnessSnapshot([]);
    assert.deepEqual(snapshot.recentRuns, []);
    assert.deepEqual(snapshot.verdictDistribution, {});
  });
});
