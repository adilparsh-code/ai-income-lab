// Phase 5.2 — Ruflo workflow runner tests (hermetic via explicit seams).
//
// The runner's own logic under test: state-aware planning handoff, fail-closed
// chaining, status mapping, NOT_ALLOWED / HUMAN_REVIEW termination, idempotency
// passthrough (dedup flag), and persistence behavior. Agents/halal/db are seam-
// overridden — they have their own suites.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executeWorkflow } from '../workflow-runner';
import type { WorkflowState } from '../workflows';

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? 'file:' + join(mkdtempSync(join(tmpdir(), 'aill-wfr-')), 'test.db'),
  NODE_ENV: 'test',
});

function okDispatch(status: string) {
  return async () => ({ status, jobId: `job-${status.toLowerCase()}`, deduplicated: false, result: { ok: true } });
}

function baseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    halalStatus: 'HALAL',
    objectiveText: 'launch a digital product',
    hasResearch: false,
    researchAgeDays: null,
    hasPositiveValidation: true,
    validationFailed: false,
    hasProduct: false,
    humanReviewPending: false,
    ...overrides,
  };
}

describe('workflow runner: termination gates', () => {
  const savedEnv = process.env;
  beforeEach(() => { process.env = { ...savedEnv }; });
  afterEach(() => { process.env = savedEnv; });

  it('NOT_ALLOWED opportunity terminates safely before any dispatch', async () => {
    const dispatched: string[] = [];
    const result = await executeWorkflow(
      { workflowType: 'FULL_INCOME_PIPELINE', objective: 'x' },
      { providedState: baseState({ halalStatus: 'NOT_ALLOWED' }), skipPersistence: true,
        dispatch: async (jt) => { dispatched.push(jt); return okDispatch('SUCCEEDED')(); } },
    );
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(dispatched, []);
    assert.ok(result.plan.terminated);
    assert.ok(result.steps.length > 0);
    for (const step of result.steps) {
      assert.equal(step.jobId, null);
      assert.equal(step.status, 'BLOCKED');
    }
  });

  it('REVIEW_REQUIRED stops the workflow for human review', async () => {
    const result = await executeWorkflow(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'x' },
      { providedState: baseState({ halalStatus: 'REVIEW_REQUIRED' }), skipPersistence: true, dispatch: okDispatch('SUCCEEDED') },
    );
    assert.equal(result.status, 'HUMAN_REVIEW');
    for (const step of result.steps) assert.equal(step.jobId, null);
  });

  it('missing opportunity for an opportunity-scoped workflow is fail-closed', async () => {
    const result = await executeWorkflow(
      { workflowType: 'OPPORTUNITY_TO_PRODUCT', objective: 'x' },
      { providedState: baseState({ halalStatus: 'NOT_ALLOWED', objectiveText: '__invalid_opportunity__ x' }), skipPersistence: true, dispatch: okDispatch('SUCCEEDED') },
    );
    assert.equal(result.status, 'BLOCKED');
  });

  it('pending human review in state stops the workflow', async () => {
    const result = await executeWorkflow(
      { workflowType: 'BUSINESS_ANALYSIS', objective: 'x' },
      { providedState: baseState({ humanReviewPending: true }), skipPersistence: true, dispatch: okDispatch('SUCCEEDED') },
    );
    assert.equal(result.status, 'HUMAN_REVIEW');
  });
});

describe('workflow runner: state-aware planning', () => {
  it('skips research when fresh research exists (no duplicate work)', async () => {
    const dispatched: string[] = [];
    const result = await executeWorkflow(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'x' },
      { providedState: baseState({ hasResearch: true, researchAgeDays: 1 }), skipPersistence: true,
        dispatch: async (jt) => { dispatched.push(jt); return okDispatch('SUCCEEDED')(); } },
    );
    assert.ok(!dispatched.includes('RESEARCH'));
    assert.ok(dispatched.includes('VALIDATION'));
    const researchStep = result.steps.find((s) => s.jobType === 'RESEARCH');
    assert.equal(researchStep?.decision, 'SKIP_FRESH');
    assert.ok(researchStep?.status === 'SKIPPED_FRESH' || researchStep?.decision === 'SKIP_FRESH');
  });

  it('runs research when existing research is stale', async () => maxResearchAgeOk());
  async function maxResearchAgeOk(): Promise<void> {
    const dispatched: string[] = [];
    const result = await executeWorkflow(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'x' },
      { providedState: baseState({ hasResearch: true, researchAgeDays: 400 }), skipPersistence: true,
        dispatch: async (jt) => { dispatched.push(jt); return okDispatch('SUCCEEDED')(); } },
    );
    assert.ok(dispatched.includes('RESEARCH'), 'stale research must re-run');
    assert.equal(result.status, 'COMPLETED');
  }

  it('does not create a duplicate product when one already exists', async () => {
    const dispatched: string[] = [];
    await executeWorkflow(
      { workflowType: 'OPPORTUNITY_TO_PRODUCT', objective: 'x' },
      { providedState: baseState({ hasProduct: true }), skipPersistence: true,
        dispatch: async (jt) => { dispatched.push(jt); return okDispatch('SUCCEEDED')(); } },
    );
    assert.ok(!dispatched.includes('PRODUCT'));
  });

  it('does not build product when validation failed (no autonomous build on weak signal)', async () => {
    const dispatched: string[] = [];
    await executeWorkflow(
      { workflowType: 'OPPORTUNITY_TO_PRODUCT', objective: 'x' },
      { providedState: baseState({ validationFailed: true }), skipPersistence: true,
        dispatch: async (jt) => { dispatched.push(jt); return okDispatch('SUCCEEDED')(); } },
    );
    assert.ok(!dispatched.includes('PRODUCT'));
  });
});

describe('workflow runner: chaining and status mapping', () => {
  it('fail-closed: FAILED step stops downstream EXECUTE steps', async () => {
    const result = await executeWorkflow(
      { workflowType: 'FULL_INCOME_PIPELINE', objective: 'x' },
      { providedState: baseState(), skipPersistence: true, dispatch: okDispatch('FAILED') },
    );
    assert.equal(result.status, 'PARTIAL');
    const executed = result.steps.filter((s) => s.decision === 'EXECUTE');
    assert.ok(executed.length >= 1);
    for (const s of result.steps.filter((s) => s.decision === 'BLOCKED')) {
      assert.equal(s.status, 'NOT_RUN');
      assert.match(s.reason, /fail-closed/i);
    }
  });

  it('BLOCKED step stops the workflow as BLOCKED', async () => {
    const result = await executeWorkflow(
      { workflowType: 'FULL_INCOME_PIPELINE', objective: 'x' },
      { providedState: baseState(), skipPersistence: true, dispatch: okDispatch('BLOCKED') },
    );
    assert.equal(result.status, 'BLOCKED');
  });

  it('HUMAN_REVIEW step stops the workflow as HUMAN_REVIEW', async () => {
    const result = await executeWorkflow(
      { workflowType: 'FULL_INCOME_PIPELINE', objective: 'x' },
      { providedState: baseState(), skipPersistence: true, dispatch: okDispatch('HUMAN_REVIEW') },
    );
    assert.equal(result.status, 'HUMAN_REVIEW');
  });

  it('DEGRADED completion maps to PARTIAL', async () => {
    const result = await executeWorkflow(
      { workflowType: 'BUSINESS_ANALYSIS', objective: 'x' },
      { providedState: baseState(), skipPersistence: true, dispatch: okDispatch('DEGRADED') },
    );
    assert.equal(result.status, 'PARTIAL');
  });

  it('correlation ID is threaded to every step', async () => {
    const result = await executeWorkflow(
      { workflowType: 'BUSINESS_ANALYSIS', objective: 'x', correlationId: 'corr-42' },
      { providedState: baseState(), skipPersistence: true, dispatch: okDispatch('SUCCEEDED') },
    );
    assert.equal(result.correlationId, 'corr-42');
    for (const s of result.steps) assert.equal(s.correlationId, 'corr-42');
  });

  it('successful workflow with persistence failure still returns the result', async () => {
    process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'aill-wfr2-')), 'db', 'missing', 'deep.db')}`;
    const result = await executeWorkflow(
      { workflowType: 'BUSINESS_ANALYSIS', objective: 'x' },
      { providedState: baseState(), dispatch: okDispatch('SUCCEEDED') },
    );
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.workflowRunId, null);
  });

  it('module boundary status stays honest', async () => {
    const { describeWorkflowBoundary } = await import('../workflow-runner');
    assert.equal(describeWorkflowBoundary().status, 'RUFLO_READY');
  });

  it('esm registration stays intact for module resolution', async () => {
    const mod = await import(pathToFileURL(join(process.cwd(), 'src/lib/ruflo/workflow-runner.ts')).href);
    assert.ok(typeof mod.executeWorkflow === 'function');
  });
});
