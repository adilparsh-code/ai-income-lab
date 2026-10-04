// ============================================================================
// PHASE 11.3 — SERVICE JOB TYPES (Job Runner integration, hermetic)
// ============================================================================
// Proves that SERVICE_BUILD / SERVICE_QA / SERVICE_DELIVERY execute through the
// EXISTING Job Runner — same idempotency, same JobRun rows, same retry policy —
// and that the payment gate makes unpaid work structurally impossible at the
// runner level too (not merely in the service layer).
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runJob } from '../job-runner';
import { ALL_JOB_TYPES, SERVICE_JOB_TYPES, isJobType, isServiceJobType } from '../types';
import type { JobDb, JobEngagementRow, JobRunRow } from '../job-runner';

interface FakeState {
  jobRuns: JobRunRow[];
  engagements: Map<string, JobEngagementRow>;
  deliverables: Map<string, { id: string; state: string; kind: string; revisionCount: number; revisionLimit: number; isPreview: boolean }>;
  counter: number;
}

function fakeDb(state: FakeState, opts: { withServiceTables: boolean }): JobDb {
  const base = {
    opportunity: { findUnique: async () => null },
    jobRun: {
      findUnique: async (args: { where: { idempotencyKey: string } }) =>
        state.jobRuns.find((r) => r.idempotencyKey === args.where.idempotencyKey) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        state.counter += 1;
        const row = { id: `job-${state.counter}`, ...args.data } as unknown as JobRunRow;
        state.jobRuns.push(row);
        return row;
      },
      update: async (args: { where: { id: string }; data: Partial<Record<string, unknown>> }) => {
        const row = state.jobRuns.find((r) => r.id === args.where.id);
        if (!row) throw new Error('missing row');
        Object.assign(row, args.data);
        return row;
      },
    },
  };
  if (!opts.withServiceTables) return base as unknown as JobDb;
  return {
    ...base,
    serviceEngagement: {
      findUnique: async (args: { where: { id: string } }) => state.engagements.get(args.where.id) ?? null,
    },
    deliverable: {
      findUnique: async (args: { where: { id: string } }) => state.deliverables.get(args.where.id) ?? null,
    },
  } as unknown as JobDb;
}

function freshState(): FakeState {
  return { jobRuns: [], engagements: new Map(), deliverables: new Map(), counter: 0 };
}

function engagement(id: string, state: string, paymentState = 'NOT_DUE'): JobEngagementRow {
  return { id, state, paymentState, engagementType: 'CLIENT_SERVICE', exposureCapUsd: 0, lowRiskExceptionApplied: false };
}

describe('Phase 11.3 — Service job types reuse the existing Job Runner', () => {
  it('registers the three service job types in the existing job vocabulary', () => {
    for (const jobType of SERVICE_JOB_TYPES) {
      assert.ok(isServiceJobType(jobType));
      assert.ok(isJobType(jobType));
      assert.ok(ALL_JOB_TYPES.includes(jobType));
    }
    assert.deepEqual([...SERVICE_JOB_TYPES].sort(), ['SERVICE_BUILD', 'SERVICE_DELIVERY', 'SERVICE_QA']);
    // The pre-existing job types are untouched — no second job system.
    assert.ok(ALL_JOB_TYPES.includes('PRODUCT_BUILD'));
    assert.ok(ALL_JOB_TYPES.includes('RESEARCH'));
  });

  it('rejects a service payload with no engagementId before any execution', async () => {
    const state = freshState();
    const outcome = await runJob('SERVICE_BUILD', {} as never, 'corr-no-engagement', { db: fakeDb(state, { withServiceTables: true }) });
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /Invalid job payload|engagementId/);
  });

  it('blocks SERVICE_BUILD when the engagement is unpaid — UNPAID → EXECUTING is impossible', async () => {
    const state = freshState();
    state.engagements.set('eng-1', engagement('eng-1', 'ACCEPTED'));
    const db = fakeDb(state, { withServiceTables: true });

    const outcome = await runJob('SERVICE_BUILD', { engagementId: 'eng-1' }, 'corr-unpaid', { db });
    assert.equal(outcome.status, 'BLOCKED');
    assert.match(outcome.error ?? '', /PAYMENT_VERIFIED/);
  });

  it('blocks SERVICE_BUILD from every non-authorized state', async () => {
    for (const state_ of ['NO_COMMITMENT', 'PROPOSAL_SENT', 'ACCEPTED', 'PAYMENT_REQUIRED', 'PAYMENT_PENDING', 'PAYMENT_VERIFIED']) {
      const state = freshState();
      state.engagements.set('eng-x', engagement('eng-x', state_));
      const outcome = await runJob('SERVICE_BUILD', { engagementId: 'eng-x' }, `corr-${state_}`, {
        db: fakeDb(state, { withServiceTables: true }),
      });
      assert.equal(outcome.status, 'BLOCKED', `${state_} must block SERVICE_BUILD`);
    }
  });

  it('allows SERVICE_BUILD once payment is verified and the engagement is authorized', async () => {
    const state = freshState();
    state.engagements.set('eng-ok', engagement('eng-ok', 'WORK_AUTHORIZED', 'PAYMENT_VERIFIED'));
    const db = fakeDb(state, { withServiceTables: true });

    const outcome = await runJob('SERVICE_BUILD', { engagementId: 'eng-ok', microServiceKind: 'CUSTOM_WORKSHEET' }, 'corr-paid', { db });
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.result?.bounded, true);
    assert.equal(outcome.executionMode, 'MOCKED', 'no AI or network claim is made');
    // The run is a real JobRun row through the existing runner.
    assert.ok(state.jobRuns.some((r) => r.jobType === 'SERVICE_BUILD'));
  });

  it('fails closed when the payment gate cannot be evaluated at all', async () => {
    const state = freshState();
    // A client WITHOUT the service tables must refuse, never skip the gate.
    const outcome = await runJob('SERVICE_BUILD', { engagementId: 'eng-1' }, 'corr-failclosed', {
      db: fakeDb(state, { withServiceTables: false }),
    });
    assert.equal(outcome.status, 'BLOCKED');
    assert.match(outcome.error ?? '', /fail-closed/);
  });

  it('fails when the engagement does not exist', async () => {
    const state = freshState();
    const outcome = await runJob('SERVICE_BUILD', { engagementId: 'missing' }, 'corr-missing', {
      db: fakeDb(state, { withServiceTables: true }),
    });
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /not found/);
  });

  it('remains idempotent through the existing runner', async () => {
    const state = freshState();
    state.engagements.set('eng-i', engagement('eng-i', 'WORK_AUTHORIZED', 'PAYMENT_VERIFIED'));
    const db = fakeDb(state, { withServiceTables: true });

    const first = await runJob('SERVICE_BUILD', { engagementId: 'eng-i' }, 'corr-idem', { db });
    const second = await runJob('SERVICE_BUILD', { engagementId: 'eng-i' }, 'corr-idem', { db });
    assert.equal(first.status, 'SUCCEEDED');
    assert.equal(second.deduplicated, true);
    assert.equal(state.jobRuns.length, 1);
  });

  it('SERVICE_QA fails closed when the bounded QA checks are unreported', async () => {
    const state = freshState();
    state.engagements.set('eng-q', engagement('eng-q', 'WORK_IN_PROGRESS', 'PAYMENT_VERIFIED'));
    state.deliverables.set('del-1', { id: 'del-1', state: 'QA_PENDING', kind: 'WORKSHEET', revisionCount: 0, revisionLimit: 2, isPreview: false });
    const db = fakeDb(state, { withServiceTables: true });

    const outcome = await runJob('SERVICE_QA', {
      engagementId: 'eng-q', deliverableId: 'del-1', microServiceKind: 'CUSTOM_WORKSHEET',
    }, 'corr-qa', { db });
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.result?.qaPassed, false);
  });

  it('SERVICE_QA passes only when every bounded check is reported as passed', async () => {
    const state = freshState();
    state.engagements.set('eng-q2', engagement('eng-q2', 'WORK_IN_PROGRESS', 'PAYMENT_VERIFIED'));
    state.deliverables.set('del-2', { id: 'del-2', state: 'QA_PENDING', kind: 'WORKSHEET', revisionCount: 0, revisionLimit: 2, isPreview: false });
    const db = fakeDb(state, { withServiceTables: true });

    const outcome = await runJob('SERVICE_QA', {
      engagementId: 'eng-q2',
      deliverableId: 'del-2',
      microServiceKind: 'CUSTOM_WORKSHEET',
      qaChecks: [
        { check: 'Prints cleanly at A4/Letter', passed: true },
        { check: 'No spelling or truncation errors', passed: true },
        { check: 'Matches the stated topic and level', passed: true },
      ],
    }, 'corr-qa2', { db });
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.result?.qaPassed, true);
  });

  it('SERVICE_DELIVERY refuses a final release before QA passes and before authorization', async () => {
    const state = freshState();
    state.engagements.set('eng-d', engagement('eng-d', 'WORK_AUTHORIZED', 'PAYMENT_VERIFIED'));
    state.deliverables.set('del-3', { id: 'del-3', state: 'DRAFT', kind: 'WEB_PAGE', revisionCount: 0, revisionLimit: 2, isPreview: false });
    const db = fakeDb(state, { withServiceTables: true });

    const outcome = await runJob('SERVICE_DELIVERY', { engagementId: 'eng-d', deliverableId: 'del-3' }, 'corr-del', { db });
    assert.equal(outcome.status, 'BLOCKED');
    assert.match(outcome.error ?? '', /not allowed|READY_FOR_DELIVERY|DELIVERY_AUTHORIZED/);
  });

  it('SERVICE_DELIVERY releases a QA-passed deliverable on an authorized engagement', async () => {
    const state = freshState();
    state.engagements.set('eng-d2', engagement('eng-d2', 'DELIVERY_AUTHORIZED', 'PAYMENT_VERIFIED'));
    state.deliverables.set('del-4', { id: 'del-4', state: 'READY_FOR_DELIVERY', kind: 'WEB_PAGE', revisionCount: 0, revisionLimit: 2, isPreview: false });
    const db = fakeDb(state, { withServiceTables: true });

    const outcome = await runJob('SERVICE_DELIVERY', { engagementId: 'eng-d2', deliverableId: 'del-4' }, 'corr-del2', { db });
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.result?.released, true);
  });

  it('rejects an unbounded deliverable kind', async () => {
    const state = freshState();
    state.engagements.set('eng-d3', engagement('eng-d3', 'DELIVERY_AUTHORIZED', 'PAYMENT_VERIFIED'));
    state.deliverables.set('del-5', { id: 'del-5', state: 'READY_FOR_DELIVERY', kind: 'SOMETHING_ELSE', revisionCount: 0, revisionLimit: 2, isPreview: false });
    const db = fakeDb(state, { withServiceTables: true });

    const outcome = await runJob('SERVICE_DELIVERY', { engagementId: 'eng-d3', deliverableId: 'del-5' }, 'corr-del3', { db });
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /bounded deliverable kind/);
  });
});