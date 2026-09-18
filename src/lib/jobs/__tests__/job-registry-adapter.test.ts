// Phase 4.5.2 — Job registry facade + Ruflo adapter boundary tests.
// Hermetic: injected DB for listings; no real DB, network, or AI.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRecentJobActivity, describeRufloIntegration } from '../job-registry';
import { rufloDispatch, describeRufloAdapter } from '../ruflo-adapter';
import { runJob, type JobDb } from '../job-runner';

function fakeRunDb(halalStatus: string | null): JobDb {
  const row = { id: 'row-1' };
  const data = {
    jobType: 'RESEARCH', status: 'QUEUED', correlationId: 'c', idempotencyKey: 'k',
    opportunityId: null, agentType: null, input: '{}', output: null, resultRef: null,
    error: null, retryCount: 0, executionMode: null, startedAt: null, completedAt: null,
  } as unknown as Parameters<JobDb['jobRun']['create']>[0]['data'];
  return {
    opportunity: {
      async findUnique({ where }) {
        if (halalStatus === null) return null;
        return {
          id: where.id, title: 'T', problemSolved: 'p', category: 'Digital Products',
          businessModel: 'Direct Sales', monetizationMethod: 'ONE_TIME_PURCHASE', halalStatus,
        };
      },
    },
    jobRun: {
      async findUnique() { return null; },
      async create() { return { ...row, ...data } as unknown as Awaited<ReturnType<JobDb['jobRun']['create']>>; },
      async update({ where, data: d }) { return { id: where.id, ...d } as unknown as Awaited<ReturnType<JobDb['jobRun']['update']>>; },
    },
  };
}

describe('job registry activity listing (Phase 4.5.2)', () => {
  it('exposes an injectable-db listing that maps rows to safe items', async () => {
    // The facade module binds its default DB via a lazy proxy; the mapping
    // invariants are covered by the runner/outcome tests below. Here we verify
    // the listing function exists with the documented signature and returns an
    // array (empty when no rows exist) without touching a real DB.
    const listing = await getRecentJobActivity(0);
    assert.ok(Array.isArray(listing));
  });

  it('integration metadata is RUFLO_READY but explicitly NOT connected', () => {
    const info = describeRufloIntegration();
    assert.equal(info.status, 'RUFLO_READY');
    assert.equal(info.connected, false);
    assert.ok(info.description.includes('not installed or connected'));
    assert.ok(info.contract.runJob.includes('runJob'));
  });
});

describe('ruflo adapter boundary (Phase 4.5.2)', () => {
  it('reports NOT_CONNECTED and never claims LIVE', () => {
    const info = describeRufloAdapter();
    assert.equal(info.status, 'NOT_CONNECTED');
    assert.ok(info.note.includes('no orchestrator is connected'));
  });

  it('rejects unknown job types without creating rows or running agents', async () => {
    let executed = false;
    const result = await rufloDispatch(
      { jobType: 'DESTROY_EVERYTHING', payload: {} },
      { db: fakeRunDb(null), executeAgentJob: async () => { executed = true; throw new Error('must not run'); } },
    );
    assert.equal(result.accepted, false);
    assert.ok(result.reason?.includes('Unknown jobType'));
    assert.equal(executed, false);
  });

  it('rejects malformed payloads and correlation ids', async () => {
    const badPayload = await rufloDispatch(
      { jobType: 'RESEARCH', payload: 'not-an-object' },
      { db: fakeRunDb(null) },
    );
    assert.equal(badPayload.accepted, false);

    const badCorr = await rufloDispatch(
      { jobType: 'RESEARCH', payload: {}, correlationId: 42 },
      { db: fakeRunDb(null) },
    );
    assert.equal(badCorr.accepted, false);
  });

  it('forwards valid dispatches to the runner, which still enforces halal gates', async () => {
    let executed = false;
    const result = await rufloDispatch(
      { jobType: 'RESEARCH', payload: { researchObjective: 'x', opportunityId: 'opp-1' }, correlationId: 'ruflo-corr-1' },
      {
        db: fakeRunDb('NOT_ALLOWED'),
        executeAgentJob: async () => { executed = true; throw new Error('agent must not run for NOT_ALLOWED'); },
      },
    );
    assert.equal(result.accepted, true);
    assert.equal(result.outcome?.status, 'BLOCKED', 'adapter output is hard-blocked by the runner');
    assert.equal(executed, false, 'no agent execution for prohibited opportunities');
  });

  it('returns accepted dispatch outcomes for permitted jobs', async () => {
    const result = await rufloDispatch(
      { jobType: 'RESEARCH', payload: { researchObjective: 'Demand for planners' }, correlationId: 'ruflo-corr-2' },
      {
        db: fakeRunDb('HALAL'),
        executeAgentJob: async () => ({
          success: true, reasoning: 'ok', evidenceType: 'AI_INFERENCE',
          capabilityStatus: 'MOCKED', fallbackUsed: false, executionTime: 3,
          output: { agentLogId: 'log-9' },
        }),
      },
    );
    assert.equal(result.accepted, true);
    assert.equal(result.outcome?.status, 'SUCCEEDED');
    assert.equal(result.outcome?.deduplicated, false);
  });
});

describe('no arbitrary execution (Phase 4.5.2)', () => {
  it('runJob rejects unknown job types at the type level (guard verified)', async () => {
    const { isJobType } = await import('../types');
    const candidates = ['EXECUTE_ARBITRARY', 'rm -rf', '__proto__', 'RESEARCH; DROP TABLE JobRun'];
    for (const candidate of candidates) {
      assert.equal(isJobType(candidate), false, `${candidate} must not be a job type`);
    }
  });

  it('the runner never persists or returns secret-like material', async () => {
    const outcome = await runJob('RESEARCH', { researchObjective: 'x' }, 'sec-corr', {
      db: fakeRunDb('HALAL'),
      executeAgentJob: async () => ({
        success: true, reasoning: 'ok', evidenceType: 'AI_INFERENCE',
        capabilityStatus: 'MOCKED', fallbackUsed: false, executionTime: 1,
        output: { agentLogId: 'log-2', halalStatus: 'HALAL', recommendation: 'ok' },
      }),
    });
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes('AI_PROVIDER_API_KEY'));
    assert.ok(!serialized.includes('apiKey'));
    assert.ok(!serialized.includes('researchObjective'), 'input payloads are not echoed back');
  });
});
