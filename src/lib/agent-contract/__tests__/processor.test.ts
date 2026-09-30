// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — processor chain tests (hermetic)
// ============================================================================
// Exercises the full enforcement chain with injected seams: authorization,
// resource/safety gate, budget/rate, human approval, idempotency, Job Runner
// dispatch and honest status mapping, audit reservation, and error mapping.
// ============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { processAgentAction, evaluateResourceAndSafety, type ProcessorOptions } from '../processor';
import { validateAgentRequest } from '../contract';
import type { AgentIdentity } from '../contract';
import type { AgentActionDb, AgentActionRow } from '../audit';
import type { JobOutcome } from '@/lib/jobs/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore() {
  const rows = new Map<string, AgentActionRow>();
  let seq = 1;
  const store: AgentActionDb = {
    agentActionRecord: {
      async findUnique({ where }) {
        return rows.get(where.requestId) ?? null;
      },
      async create({ data }) {
        if (rows.has(data.requestId)) throw new Error('Unique constraint failed: requestId');
        const row: AgentActionRow = { id: `row-${seq++}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.set(data.requestId, row);
        return row;
      },
      async update({ where, data }) {
        const row = rows.get(where.requestId);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { store, rows };
}

const identity = (granted: string[]): AgentIdentity => ({
  agentId: 'alpha-agent',
  credentialLabel: 'ALPHA',
  fingerprint: 'fp000000000000000',
  grantedCapabilities: granted as AgentIdentity['grantedCapabilities'],
});

function req(overrides: Record<string, unknown> = {}) {
  const raw = {
    contractVersion: 'v1',
    agentId: 'alpha-agent',
    agentVersion: '1.0.0',
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    correlationId: `corr-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    action: 'WRITE_RESEARCH_EVIDENCE',
    payload: { researchObjective: 'Evaluate demand for a deterministic toolkit.' },
    ...overrides,
  };
  const validation = validateAgentRequest(raw);
  if (!validation.ok) throw new Error(`fixture invalid: ${validation.errors.join('; ')}`);
  return validation.request;
}

const ALL_GRANTED = [
  'READ_OPPORTUNITY', 'WRITE_RESEARCH_EVIDENCE', 'RUN_VALIDATION', 'CREATE_EXPERIMENT',
  'CREATE_PRODUCT_PLAN', 'READ_ANALYTICS', 'READ_REVENUE', 'REQUEST_PUBLISH', 'REQUEST_CONFIG_CHANGE',
];

function jobOutcome(status: string, jobId = 'job-1'): JobOutcome {
  return {
    jobId, jobType: 'RESEARCH', status: status as never, deduplicated: false,
    result: { summary: 'ok' }, error: null, executionMode: 'MOCKED', retryCount: 0,
  };
}

function makeOptions(store: ReturnType<typeof makeStore>, overrides: Partial<ProcessorOptions> = {}): ProcessorOptions {
  return {
    auditStore: store.store,
    runJob: async () => jobOutcome('SUCCEEDED'),
    rate: async () => ({ allowed: true, remaining: 10 }),
    reviews: { createHumanReview: async () => ({ ok: true, id: 'review-1' }) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('processor: authorization', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('rejects a capability outside the credential grant (403 + audit)', async () => {
    const result = await processAgentAction(
      { request: req({ action: 'CREATE_EXPERIMENT' }), identity: identity(['READ_OPPORTUNITY']), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.httpStatus, 403);
    assert.equal(!result.ok && result.response.code, 'FORBIDDEN_CAPABILITY');
    const row = [...store.rows.values()][0];
    assert.equal(row?.authorizationResult, 'DENIED_CAPABILITY');
    assert.equal(row?.status, 'REJECTED');
  });

  it('accepts a granted capability and reserves the audit row before dispatch', async () => {
    const dispatches: string[] = [];
    const result = await processAgentAction(
      { request: req(), identity: identity(['WRITE_RESEARCH_EVIDENCE']), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { runJob: async (jobType) => { dispatches.push(jobType as string); return jobOutcome('SUCCEEDED'); } }),
    );
    assert.equal(result.ok, true);
    assert.equal(!result.ok || result.httpStatus, 201);
    assert.equal(!result.ok || result.response.status, 'ACCEPTED');
    assert.deepEqual(dispatches, ['RESEARCH']);
    assert.equal(!result.ok || result.response.jobId, 'job-1');
  });

  it('maps the fixed capability→job type (caller never names it)', async () => {
    const dispatches: { jobType: string; payload: Record<string, unknown> }[] = [];
    await processAgentAction(
      { request: req({ action: 'RUN_VALIDATION', payload: { validationObjective: 'Validate the toolkit hypothesis.', opportunityId: 'opp-1' } }), identity: identity(ALL_GRANTED), resource: { opportunityId: 'opp-1', halalStatus: 'HALAL' } },
      makeOptions(store, { runJob: async (jobType, payload) => { dispatches.push({ jobType: jobType as string, payload: payload as Record<string, unknown> }); return jobOutcome('SUCCEEDED', 'job-v'); } }),
    );
    assert.equal(dispatches[0].jobType, 'VALIDATION');
    assert.equal(dispatches[0].payload.source, 'AGENT_V1');
    assert.equal(dispatches[0].payload.opportunityId, 'opp-1');
  });

  it('rejects a payload missing the required objective (nothing dispatched)', async () => {
    const dispatches: string[] = [];
    const result = await processAgentAction(
      { request: req({ payload: {} }), identity: identity(['WRITE_RESEARCH_EVIDENCE']), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { runJob: async (jobType) => { dispatches.push(jobType as string); return jobOutcome('SUCCEEDED'); } }),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.response.code, 'INVALID_REQUEST');
    assert.equal(dispatches.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Safety / resource
// ---------------------------------------------------------------------------

describe('processor: safety + resource', () => {
  it('blocks prohibited content before dispatch (409 SAFETY_BLOCKED)', async () => {
    const store = makeStore();
    const result = await processAgentAction(
      { request: req({ payload: { researchObjective: 'Maximize engagement for a gambling betting site.' } }), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { runJob: async () => { throw new Error('MUST NOT DISPATCH'); } }),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.response.code, 'SAFETY_BLOCKED');
    assert.equal(!result.ok && result.httpStatus, 409);
    const row = [...store.rows.values()][0];
    assert.equal(row?.safetyVerdict, 'NOT_ALLOWED');
    assert.equal(row?.status, 'BLOCKED');
  });

  it('blocks when the referenced opportunity is NOT_ALLOWED on file', async () => {
    const store = makeStore();
    const result = await processAgentAction(
      { request: req({ payload: { researchObjective: 'ok objective', opportunityId: 'opp-bad' } }), identity: identity(ALL_GRANTED), resource: { opportunityId: 'opp-bad', halalStatus: 'NOT_ALLOWED' } },
      makeOptions(store, { runJob: async () => { throw new Error('MUST NOT DISPATCH'); } }),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.response.code, 'SAFETY_BLOCKED');
  });

  it('404s a missing referenced opportunity without dispatching', async () => {
    const store = makeStore();
    const result = await processAgentAction(
      { request: req({ payload: { researchObjective: 'x', opportunityId: 'missing-opp' } }), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.response.code, 'NOT_FOUND');
  });

  it('sends REVIEW_REQUIRED content to human review instead of executing', async () => {
    const store = makeStore();
    const reviews: string[] = [];
    const result = await processAgentAction(
      // "wine" is flagged REVIEW_REQUIRED by the existing deterministic gate.
      { request: req({ payload: { researchObjective: 'Wine tasting club subscription with paid membership tiers.' } }), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, {
        runJob: async () => { throw new Error('MUST NOT DISPATCH'); },
        reviews: { createHumanReview: async (input) => { reviews.push(input.category); return { ok: true, id: 'rev-safety' }; } },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(!result.ok || result.response.status, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(!result.ok || result.response.jobId, null);
    assert.deepEqual(reviews, ['SAFETY_REVIEW']);
    const row = [...store.rows.values()][0];
    assert.equal(row?.safetyVerdict, 'REVIEW_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// Human approval capabilities
// ---------------------------------------------------------------------------

describe('processor: HUMAN_APPROVAL capabilities', () => {
  it('REQUEST_PUBLISH creates a review and never dispatches', async () => {
    const store = makeStore();
    const dispatches: string[] = [];
    const result = await processAgentAction(
      { request: req({ action: 'REQUEST_PUBLISH', payload: { productId: 'prod-1' } }), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { runJob: async (jobType) => { dispatches.push(jobType as string); return jobOutcome('SUCCEEDED'); } }),
    );
    assert.equal(result.ok, true);
    assert.equal(!result.ok || result.response.status, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(!result.ok || result.response.reviewId, 'review-1');
    assert.equal(dispatches.length, 0);
    const row = [...store.rows.values()][0];
    assert.equal(row?.status, 'HUMAN_APPROVAL_REQUIRED');
    assert.ok(row?.reviewId);
  });

  it('REQUEST_CONFIG_CHANGE queues a SECURITY_CHANGE review', async () => {
    const store = makeStore();
    const categories: string[] = [];
    const result = await processAgentAction(
      { request: req({ action: 'REQUEST_CONFIG_CHANGE', payload: { changeSummary: 'Rotate the agent token' } }), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { reviews: { createHumanReview: async (input) => { categories.push(input.category); return { ok: true, id: 'rev-cfg' }; } } }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(categories, ['SECURITY_CHANGE']);
  });
});

// ---------------------------------------------------------------------------
// Rate limit + idempotency + dispatch outcomes
// ---------------------------------------------------------------------------

describe('processor: rate limit + idempotency', () => {
  it('429s when the durable limiter refuses', async () => {
    const store = makeStore();
    const result = await processAgentAction(
      { request: req(), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { rate: async () => ({ allowed: false, retryAfterSeconds: 42 }) }),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.response.code, 'RATE_LIMITED');
    assert.equal(!result.ok && result.httpStatus, 429);
  });

  it('returns the stored response for a replayed requestId (no second job)', async () => {
    const store = makeStore();
    let dispatches = 0;
    const options = makeOptions(store, { runJob: async () => { dispatches += 1; return jobOutcome('SUCCEEDED'); } });
    const first = await processAgentAction({ request: req({ requestId: 'same-req' }), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } }, options);
    const replay = await processAgentAction({ request: req({ requestId: 'same-req' }), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } }, options);
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(!replay.ok || replay.response.status, 'DUPLICATE');
    assert.equal(!replay.ok || replay.httpStatus, 200);
    assert.equal(dispatches, 1); // exactly one job across both calls
  });

  it('reserves the audit row before dispatch so a crash cannot lose the trail', async () => {
    const store = makeStore();
    await processAgentAction(
      { request: req(), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { runJob: async () => { throw new Error('runner exploded'); } }),
    );
    const row = [...store.rows.values()][0];
    assert.ok(row, 'audit row exists even when dispatch throws');
    assert.equal(row.status, 'FAILED');
  });
});

describe('processor: Job Runner outcome mapping', () => {
  const cases: { status: string; expected: { ok: boolean; code?: string; status?: string; http?: number } }[] = [
    { status: 'SUCCEEDED', expected: { ok: true, status: 'ACCEPTED', http: 201 } },
    { status: 'DEGRADED', expected: { ok: true, status: 'ACCEPTED', http: 201 } },
    { status: 'BLOCKED', expected: { ok: false, code: 'SAFETY_BLOCKED', http: 409 } },
    { status: 'HUMAN_REVIEW', expected: { ok: true, status: 'HUMAN_APPROVAL_REQUIRED', http: 202 } },
    { status: 'FAILED', expected: { ok: false, code: 'INTERNAL_ERROR', http: 500 } },
  ];
  for (const { status, expected } of cases) {
    it(`maps Job Runner ${status} honestly`, async () => {
      const store = makeStore();
      const result = await processAgentAction(
        { request: req(), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
        makeOptions(store, { runJob: async () => jobOutcome(status) }),
      );
      assert.equal(result.ok, expected.ok);
      if (!result.ok) {
        assert.equal(result.response.code, expected.code);
        assert.equal(result.httpStatus, expected.http);
      } else {
        assert.equal(result.response.status, expected.status);
        assert.equal(result.httpStatus, expected.http);
      }
    });
  }

  it('never reports LIVE for a MOCKED execution', async () => {
    const store = makeStore();
    const result = await processAgentAction(
      { request: req(), identity: identity(ALL_GRANTED), resource: { opportunityId: null, halalStatus: null } },
      makeOptions(store, { runJob: async () => jobOutcome('SUCCEEDED') }),
    );
    assert.ok(result.ok);
    if (result.ok) {
      const snapshot = result.response.result as Record<string, unknown>;
      assert.equal(snapshot.executionMode, 'MOCKED'); // honest, from the runner
      assert.equal(JSON.stringify(result.response).includes('LIVE'), false);
    }
  });
});

// ---------------------------------------------------------------------------
// Resource/safety pure function edge cases
// ---------------------------------------------------------------------------

describe('evaluateResourceAndSafety', () => {
  it('skips halal screening for READ capabilities', () => {
    const parsed = validateAgentRequest({
      contractVersion: 'v1', agentId: 'alpha-agent', agentVersion: '1', requestId: 'r1', correlationId: 'c1',
      timestamp: '2026-01-01T00:00:00.000Z', action: 'READ_OPPORTUNITY',
      payload: { opportunityId: 'opp-1', title: 'casino gambling scheme' },
    });
    assert.ok(parsed.ok);
    if (parsed.ok) {
      const decision = evaluateResourceAndSafety(parsed.request, { opportunityId: 'opp-1', halalStatus: 'HALAL' });
      assert.equal(decision.ok, true);
      if (decision.ok) assert.equal(decision.verdict, 'NOT_APPLICABLE');
    }
  });

  it('requires the referenced opportunity to exist for scoped writes', () => {
    const parsed = validateAgentRequest({
      contractVersion: 'v1', agentId: 'alpha-agent', agentVersion: '1', requestId: 'r2', correlationId: 'c2',
      timestamp: '2026-01-01T00:00:00.000Z', action: 'RUN_VALIDATION',
      payload: { validationObjective: 'x', opportunityId: 'ghost' },
    });
    assert.ok(parsed.ok);
    if (parsed.ok) {
      const decision = evaluateResourceAndSafety(parsed.request, { opportunityId: null, halalStatus: null });
      assert.equal(decision.ok, false);
      if (!decision.ok) assert.equal(decision.code, 'NOT_FOUND');
    }
  });
});
