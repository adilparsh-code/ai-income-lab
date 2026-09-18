// Phase 5.4 — End-to-end PRODUCT_LAUNCH workflow tests (Part 9).
//
// Exercises the full launch workflow through the runner's hermetic seams
// (providedState + dispatch), proving:
//   - complete supported pipeline runs in order through runJob-style dispatch
//   - halal NOT_ALLOWED blocks the entire workflow before any execution
//   - REVIEW_REQUIRED stops the workflow for a human
//   - state-awareness: existing product → product steps skipped, not duplicated
//   - fail-closed chaining: a failed step halts all downstream steps
//   - a single correlationId threads every dispatched job (idempotency scope)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeWorkflow, type ExecuteWorkflowOptions } from '../workflow-runner';

const LAUNCH_INPUT = {
  workflowType: 'PRODUCT_LAUNCH' as const,
  objective: 'Launch the validated planner product',
  opportunityId: 'opp-1',
};

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    halalStatus: 'HALAL',
    objectiveText: LAUNCH_INPUT.objective,
    hasResearch: true,
    researchAgeDays: 1,
    hasPositiveValidation: true,
    validationFailed: false,
    hasProduct: false,
    humanReviewPending: false,
    ...overrides,
  };
}

function recordingDispatch(outcomes: Record<string, { status: string; result?: Record<string, unknown> }> = {}) {
  const dispatched: { jobType: string; correlationId: string }[] = [];
  const dispatch: ExecuteWorkflowOptions['dispatch'] = async (jobType, _payload, correlationId) => {
    dispatched.push({ jobType, correlationId });
    const outcome = outcomes[jobType] ?? { status: 'SUCCEEDED' };
    return {
      status: outcome.status,
      jobId: `job-${dispatched.length}`,
      deduplicated: false,
      result: outcome.result ?? { summary: { ok: true } },
    };
  };
  return { dispatched, dispatch };
}

const noPersist: ExecuteWorkflowOptions = { skipPersistence: true };

describe('PRODUCT_LAUNCH — happy path', () => {
  it('executes all seven factory steps in order through one correlationId', async () => {
    const { dispatched, dispatch } = recordingDispatch();
    const result = await executeWorkflow(LAUNCH_INPUT, { ...noPersist, providedState: baseState(), dispatch });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(dispatched.length, 7);
    const jobTypes = dispatched.map((d) => d.jobType);
    assert.deepEqual(jobTypes, [
      'PRODUCT_CREATE', 'PRODUCT_BUILD', 'PRODUCT_TEST', 'PRODUCT_DEPLOY',
      'PRODUCT_PUBLISH', 'REVENUE_SYNC', 'PRODUCT_ANALYZE',
    ]);
    const correlationIds = new Set(dispatched.map((d) => d.correlationId));
    assert.equal(correlationIds.size, 1);
    assert.equal(result.correlationId, dispatched[0].correlationId);
  });
});

describe('PRODUCT_LAUNCH — halal gates', () => {
  it('NOT_ALLOWED blocks the workflow before any step executes', async () => {
    const { dispatched, dispatch } = recordingDispatch();
    const result = await executeWorkflow(LAUNCH_INPUT, {
      ...noPersist,
      providedState: baseState({ halalStatus: 'NOT_ALLOWED' }),
      dispatch,
    });

    assert.equal(result.status, 'BLOCKED');
    assert.equal(dispatched.length, 0);
    assert.ok(result.steps.every((s) => s.status === 'BLOCKED'));
    assert.match(result.plan.gateReason, /NOT_ALLOWED|halal/i);
  });

  it('REVIEW_REQUIRED stops the workflow for a human without executing', async () => {
    const { dispatched, dispatch } = recordingDispatch();
    const result = await executeWorkflow(LAUNCH_INPUT, {
      ...noPersist,
      providedState: baseState({ halalStatus: 'REVIEW_REQUIRED' }),
      dispatch,
    });

    assert.equal(result.status, 'HUMAN_REVIEW');
    assert.equal(dispatched.length, 0);
  });
});

describe('PRODUCT_LAUNCH — state awareness', () => {
  it('skips product creation when a product already exists (no duplicates)', async () => {
    const { dispatched, dispatch } = recordingDispatch();
    const result = await executeWorkflow(LAUNCH_INPUT, {
      ...noPersist,
      providedState: baseState({ hasProduct: true }),
      dispatch,
    });

    assert.equal(result.status, 'COMPLETED');
    const executed = dispatched.map((d) => d.jobType);
    assert.equal(executed.includes('PRODUCT_CREATE'), false);
    assert.ok(executed.includes('PRODUCT_BUILD'));
  });

  it('refuses to launch when validation failed (fail-closed state)', async () => {
    const { dispatched, dispatch } = recordingDispatch();
    const result = await executeWorkflow(LAUNCH_INPUT, {
      ...noPersist,
      providedState: baseState({ hasPositiveValidation: false, validationFailed: true }),
      dispatch,
    });

    assert.equal(dispatched.length, 0);
    assert.ok(result.status === 'BLOCKED' || result.status === 'HUMAN_REVIEW');
  });
});

describe('PRODUCT_LAUNCH — fail-closed chaining', () => {
  it('a failed PRODUCT_TEST halts all downstream steps', async () => {
    const { dispatched, dispatch } = recordingDispatch({
      PRODUCT_TEST: { status: 'FAILED' },
    });
    const result = await executeWorkflow(LAUNCH_INPUT, {
      ...noPersist,
      providedState: baseState(),
      dispatch,
    });

    assert.equal(result.status, 'FAILED');
    const executed = dispatched.map((d) => d.jobType);
    assert.ok(executed.includes('PRODUCT_TEST'));
    assert.equal(executed.includes('PRODUCT_DEPLOY'), false);
    assert.equal(executed.includes('PRODUCT_PUBLISH'), false);
    assert.equal(executed.includes('PRODUCT_ANALYZE'), false);
  });

  it('HUMAN_REVIEW on deploy stops publish automatically', async () => {
    const { dispatched, dispatch } = recordingDispatch({
      PRODUCT_DEPLOY: { status: 'HUMAN_REVIEW' },
    });
    const result = await executeWorkflow(LAUNCH_INPUT, {
      ...noPersist,
      providedState: baseState(),
      dispatch,
    });

    assert.equal(result.status, 'HUMAN_REVIEW');
    const executed = dispatched.map((d) => d.jobType);
    assert.equal(executed.includes('PRODUCT_PUBLISH'), false);
  });

  it('DEGRADED (provider not connected) does not fabricate success', async () => {
    const { dispatch } = recordingDispatch({
      PRODUCT_DEPLOY: { status: 'DEGRADED' },
    });
    const result = await executeWorkflow(LAUNCH_INPUT, {
      ...noPersist,
      providedState: baseState(),
      dispatch,
    });

    assert.equal(result.status, 'DEGRADED');
    const deployStep = result.steps.find((s) => s.jobType === 'PRODUCT_DEPLOY');
    assert.equal(deployStep?.status, 'DEGRADED');
  });
});
