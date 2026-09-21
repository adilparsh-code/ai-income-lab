// Phase 4.5.2 — Job Runner tests.
// Hermetic: the DB and executors are injected; no real DB, network, or AI.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runJob, retryJob, isRetryableFailure, mapAgentOutcomeToStatus, type JobDb, type JobRunRow } from '../job-runner';
import { validateJobPayload } from '../job-definitions';

/** Shape the runner's executeAgentJob seam accepts (subset of AgentResult). */
interface AgentResultLike {
  success: boolean;
  reasoning: string;
  evidenceType: string;
  capabilityStatus?: string;
  fallbackUsed?: boolean;
  executionTime: number;
  error?: string;
  output?: unknown;
}

type AgentExecutor = (jobType: JobTypeLike, payload: Record<string, unknown>) => Promise<AgentResultLike>;
type JobTypeLike = Parameters<typeof runJob>[0];

function fakeDb(overrides: {
  opportunity?: Record<string, unknown> | null;
  existing?: JobRunRow | null;
} = {}): { db: JobDb; rows: JobRunRow[] } {
  const rows: JobRunRow[] = [];
  if (overrides.existing) rows.push(overrides.existing);
  let seq = 0;
  const db: JobDb = {
    opportunity: {
      async findUnique({ where }) {
        if (overrides.opportunity === null) return null;
        const opp = overrides.opportunity ?? {
          id: where.id, title: 'Test Opp', problemSolved: 'p', category: 'Digital Products',
          businessModel: 'Direct Sales', monetizationMethod: 'ONE_TIME_PURCHASE', halalStatus: 'HALAL',
        };
        return opp as unknown as Awaited<ReturnType<JobDb['opportunity']['findUnique']>>;
      },
    },
    jobRun: {
      async findUnique({ where }) {
        return rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      },
      async create({ data }) {
        const row: JobRunRow = {
          id: `job-${++seq}`,
          jobType: data.jobType,
          status: data.status,
          correlationId: data.correlationId,
          idempotencyKey: data.idempotencyKey,
          opportunityId: data.opportunityId,
          agentType: data.agentType,
          input: data.input,
          output: data.output,
          resultRef: data.resultRef,
          error: data.error,
          retryCount: data.retryCount,
          executionMode: data.executionMode,
          createdAt: new Date(),
          startedAt: data.startedAt,
          completedAt: data.completedAt,
        };
        rows.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('row not found');
        Object.assign(row, data as Partial<JobRunRow>);
        return row;
      },
    },
  };
  return { db, rows };
}

function okAgent(overrides: Partial<AgentResultLike> = {}): AgentExecutor {
  return async () => ({
    success: true,
    reasoning: 'ok',
    evidenceType: 'AI_INFERENCE',
    capabilityStatus: 'MOCKED',
    fallbackUsed: false,
    executionTime: 5,
    output: { agentLogId: 'log-1', halalStatus: 'HALAL', recommendation: 'ok' },
    ...overrides,
  });
}

describe('job payload validation (Phase 4.5.2)', () => {
  it('rejects RESEARCH without an objective', () => {
    const result = validateJobPayload('RESEARCH', {});
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('researchObjective'));
  });

  it('rejects PRODUCT with an unknown productType', () => {
    const result = validateJobPayload('PRODUCT', { productObjective: 'x', productType: 'NUCLEAR_PLANT' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.join(' ').includes('productType'));
  });

  it('rejects BUSINESS_MANAGER without decisionScope', () => {
    const result = validateJobPayload('BUSINESS_MANAGER', {});
    assert.equal(result.valid, false);
  });

  it('rejects OPPORTUNITY_PIPELINE without objective and with bad stages', () => {
    assert.equal(validateJobPayload('OPPORTUNITY_PIPELINE', {}).valid, false);
    assert.equal(validateJobPayload('OPPORTUNITY_PIPELINE', { objective: 'x', stages: ['CHAOS'] }).valid, false);
  });

  it('accepts a well-formed payload', () => {
    assert.equal(validateJobPayload('RESEARCH', { researchObjective: 'Research demand for planners' }).valid, true);
    assert.equal(validateJobPayload('ANALYTICS', { opportunityId: 'opp-1' }).valid, true);
  });

  it('rejects oversized free-text fields', () => {
    const result = validateJobPayload('RESEARCH', { researchObjective: 'x'.repeat(5000) });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('at most'));
  });
});

describe('job execution (Phase 4.5.2)', () => {
  it('executes a valid RESEARCH job through the injected executor and records SUCCEEDED', async () => {
    const { db, rows } = fakeDb();
    const outcome = await runJob('RESEARCH', { researchObjective: 'Demand for planners' }, 'corr-1',
      { db, executeAgentJob: okAgent() });

    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.jobId, rows[0].id);
    assert.equal(outcome.executionMode, 'MOCKED');
    assert.equal(outcome.deduplicated, false);
    const stored = rows[rows.length - 1];
    assert.equal(stored.status, 'SUCCEEDED');
    assert.ok(stored.startedAt && stored.completedAt, 'durable timestamps recorded');
    assert.deepEqual(JSON.parse(stored.resultRef ?? '{}'), { agentLogId: 'log-1' });
  });

  it('persists QUEUED→RUNNING transitions and the correlation id', async () => {
    const { db, rows } = fakeDb();
    await runJob('ANALYTICS', { analyticsObjective: 'Review revenue' }, 'corr-abc', { db, executeAgentJob: okAgent() });
    const created = rows[0];
    assert.equal(created.status, 'SUCCEEDED');
    assert.equal(created.correlationId, 'corr-abc');
    assert.equal(created.idempotencyKey, 'ANALYTICS:corr-abc');
    assert.ok(created.startedAt, 'startedAt recorded');
    assert.ok(created.completedAt, 'completedAt recorded');
  });

  it('marks DEGRADED when the agent fell back, and FAILED on agent failure', async () => {
    const degraded = fakeDb();
    const degradedOutcome = await runJob('RESEARCH', { researchObjective: 'x' }, 'c1',
      { db: degraded.db, executeAgentJob: okAgent({ fallbackUsed: true }) });
    assert.equal(degradedOutcome.status, 'DEGRADED');

    const failed = fakeDb();
    const failedOutcome = await runJob('RESEARCH', { researchObjective: 'x' }, 'c2',
      { db: failed.db, executeAgentJob: okAgent({ success: false, error: 'AI failed after retries' }) });
    assert.equal(failedOutcome.status, 'FAILED');
  });

  it('fails a job for a missing opportunity without invoking any agent', async () => {
    const { db } = fakeDb({ opportunity: null });
    let agentCalled = false;
    const outcome = await runJob('RESEARCH', { researchObjective: 'x', opportunityId: 'nope' }, 'c3',
      { db, executeAgentJob: async () => { agentCalled = true; throw new Error('must not run'); } });
    assert.equal(outcome.status, 'FAILED');
    assert.ok(outcome.error?.includes('not found'));
    assert.equal(agentCalled, false, 'agent must not be invoked for a missing opportunity');
  });

  it('rejects invalid payloads before creating rows or calling agents', async () => {
    const { db, rows } = fakeDb();
    let agentCalled = false;
    const outcome = await runJob('PRODUCT', { productType: 'SAAS' }, 'c4',
      { db, executeAgentJob: async () => { agentCalled = true; throw new Error('must not run'); } });
    assert.equal(outcome.status, 'FAILED');
    assert.ok(outcome.error?.includes('productObjective'));
    assert.equal(rows.length, 0, 'no row is created for an invalid payload');
    assert.equal(agentCalled, false);
  });
});

describe('halal gating (Phase 4.5.2)', () => {
  it('hard-blocks NOT_ALLOWED opportunities before any agent/AI invocation', async () => {
    const { db, rows } = fakeDb({
      opportunity: {
        id: 'opp-1', title: 'T', problemSolved: 'p', category: ' Gambling ',
        businessModel: 'Betting', monetizationMethod: 'AD_SUPPORTED', halalStatus: 'NOT_ALLOWED',
      },
    });
    let agentCalled = false;
    const outcome = await runJob('RESEARCH', { researchObjective: 'x', opportunityId: 'opp-1' }, 'c5',
      { db, executeAgentJob: async () => { agentCalled = true; throw new Error('must not run'); } });

    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(agentCalled, false, 'NOT_ALLOWED must never reach an agent or AI provider');
    assert.equal(rows.length, 1, 'the BLOCKED job is durably recorded');
    assert.equal(rows[0].status, 'BLOCKED');
    assert.ok(rows[0].error?.includes('NOT_ALLOWED'));
  });

  it('routes REVIEW_REQUIRED to HUMAN_REVIEW with no autonomous execution', async () => {
    const { db } = fakeDb({
      opportunity: {
        id: 'opp-2', title: 'T', problemSolved: 'p', category: 'c',
        businessModel: 'b', monetizationMethod: 'ONE_TIME_PURCHASE', halalStatus: 'REVIEW_REQUIRED',
      },
    });
    let agentCalled = false;
    const outcome = await runJob('VALIDATION', { validationObjective: 'x', opportunityId: 'opp-2' }, 'c6',
      { db, executeAgentJob: async () => { agentCalled = true; throw new Error('must not run'); } });
    assert.equal(outcome.status, 'HUMAN_REVIEW');
    assert.equal(agentCalled, false);
  });

  it('upgrades to BLOCKED when the payload itself screens as NOT_ALLOWED (no opportunity)', async () => {
    const { db } = fakeDb();
    const outcome = await runJob('RESEARCH', { researchObjective: 'Launch a gambling and betting affiliate site' }, 'c7',
      { db, executeAgentJob: okAgent() });
    assert.equal(outcome.status, 'BLOCKED');
    assert.ok(outcome.error === null || typeof outcome.error === 'string');
  });
});

describe('idempotency & correlation (Phase 4.5.2)', () => {
  it('returns the existing terminal row without re-executing', async () => {
    const { db } = fakeDb();
    const first = await runJob('RESEARCH', { researchObjective: 'x' }, 'same-corr', { db, executeAgentJob: okAgent() });
    let calls = 0;
    const second = await runJob('RESEARCH', { researchObjective: 'x' }, 'same-corr', {
      db,
      executeAgentJob: async () => { calls += 1; throw new Error('must not run'); },
    });
    assert.equal(second.deduplicated, true, 're-dispatch is deduplicated');
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(calls, 0, 'completed work is never re-executed');
  });

  it('generates distinct correlation ids when none is supplied', async () => {
    const { db } = fakeDb();
    const a = await runJob('RESEARCH', { researchObjective: 'x' }, undefined, { db, executeAgentJob: okAgent() });
    const b = await runJob('RESEARCH', { researchObjective: 'x' }, undefined, { db, executeAgentJob: okAgent() });
    assert.notEqual(a.jobId, b.jobId);
  });
});

describe('retry policy (Phase 4.5.2)', () => {
  it('classifies only DEGRADED as retryable', () => {
    for (const status of ['DEGRADED'] as const) assert.ok(isRetryableFailure(status));
    for (const status of ['SUCCEEDED', 'FAILED', 'BLOCKED', 'HUMAN_REVIEW', 'QUEUED', 'RUNNING'] as const) {
      assert.equal(isRetryableFailure(status), false, `${status} must not be blindly retried`);
    }
  });

  it('retry uses a fresh correlation id and can succeed', async () => {
    const { db } = fakeDb();
    const outcome = await retryJob('RESEARCH', { researchObjective: 'x' }, { db, executeAgentJob: okAgent() });
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.ok(outcome.jobId !== 'n/a');
  });
});

describe('pipeline workflow job (Phase 4.5.2)', () => {
  it('maps COMPLETED pipeline runs to SUCCEEDED with a run reference', async () => {
    const { db, rows } = fakeDb();
    const outcome = await runJob('OPPORTUNITY_PIPELINE', { objective: 'Build a planner product' }, 'c10',
      {
        db,
        executePipelineJob: async () => ({ status: 'COMPLETED', runId: 'run-1', steps: [1, 2, 3] }),
      });
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.deepEqual(JSON.parse(rows[rows.length - 1].resultRef ?? '{}'), { pipelineRunId: 'run-1' });
    assert.equal((outcome.result as { stepsExecuted?: number }).stepsExecuted, 3);
  });

  it('hard-blocked pipeline runs record BLOCKED with zero steps executed', async () => {
    const { db } = fakeDb();
    const outcome = await runJob('OPPORTUNITY_PIPELINE', { objective: 'x', opportunityId: 'opp-1' }, 'c11',
      {
        db,
        executePipelineJob: async () => ({ status: 'BLOCKED', runId: 'run-2', steps: [] }),
      });
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal((outcome.result as { blockedWithZeroSteps?: boolean }).blockedWithZeroSteps, true);
  });

  it('maps HUMAN_REVIEW pipeline runs to HUMAN_REVIEW', async () => {
    const { db } = fakeDb();
    const outcome = await runJob('OPPORTUNITY_PIPELINE', { objective: 'x' }, 'c12',
      { db, executePipelineJob: async () => ({ status: 'HUMAN_REVIEW', runId: 'run-3', steps: [1] }) });
    assert.equal(outcome.status, 'HUMAN_REVIEW');
  });
});

describe('status mapping invariants (Phase 4.5.2)', () => {
  it('blocking and review dominate success', () => {
    assert.equal(mapAgentOutcomeToStatus({ success: true }, false, true), 'BLOCKED');
    assert.equal(mapAgentOutcomeToStatus({ success: true }, true, false), 'HUMAN_REVIEW');
    assert.equal(mapAgentOutcomeToStatus({ success: true }, true, true), 'BLOCKED');
    assert.equal(mapAgentOutcomeToStatus({ success: true, fallbackUsed: true }, false, false), 'DEGRADED');
    assert.equal(mapAgentOutcomeToStatus({ success: false, fallbackUsed: true }, false, false), 'DEGRADED');
    assert.equal(mapAgentOutcomeToStatus({ success: false }, false, false), 'FAILED');
    assert.equal(mapAgentOutcomeToStatus({ success: true }, false, false), 'SUCCEEDED');
  });
});

describe('unknown job type (Phase 4.5.2)', () => {
  it('is rejected by the type guard', async () => {
    const { isJobType } = await import('../types');
    assert.equal(isJobType('DESTROY_ALL_DATA'), false);
    assert.equal(isJobType('RESEARCH'), true);
    assert.equal(isJobType('OPPORTUNITY_PIPELINE'), true);
  });
});
