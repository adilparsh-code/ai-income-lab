// Phase 5.5 — Ruflo connector tests.
//
// What is proven here:
// 1. Without a registered handle, dispatch is an honest NOT_CONNECTED refusal —
//    nothing executes.
// 2. With a handle, orchestration flows through the EXISTING workflow runner
//    (same gates) and the handle receives only a bounded, secret-free summary.
// 3. A broken notification channel never corrupts the workflow result.
// 4. Status reporting flips to RUFLO_CONNECTED only while a handle is registered.
//
// All executions are hermetic: providedState + dispatch overrides mean no DB
// rows and no AI calls.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerRufloOrchestrator,
  clearRufloOrchestrator,
  getRegisteredRufloOrchestrator,
  isRufloConnected,
  dispatchWorkflowViaRuflo,
  type RufloProductAnalysis,
} from '../connector';
import { describeRufloIntegration } from '../capability';
import type { WorkflowState } from '../workflows';

const HALAL_STATE: WorkflowState = {
  halalStatus: 'HALAL',
  objectiveText: 'Build a productivity tool',
  hasResearch: false,
  researchAgeDays: null,
  hasPositiveValidation: true,
  validationFailed: false,
  hasProduct: false,
  humanReviewPending: false,
};

function makeDispatch(status: string) {
  const calls: { jobType: string; correlationId: string; payloads: Record<string, unknown>[] }[] = [];
  return {
    calls,
    async dispatch(jobType: string, payload: Record<string, unknown>, correlationId: string) {
      const entry = calls.find((c) => c.jobType === jobType && c.correlationId === correlationId);
      if (entry) entry.payloads.push(payload);
      else calls.push({ jobType, correlationId, payloads: [payload] });
      return { status, jobId: `job-${calls.length}`, deduplicated: false, result: null };
    },
  };
}

describe('Ruflo connector', () => {
  beforeEach(() => {
    clearRufloOrchestrator();
  });

  it('refuses dispatch honestly when no handle is registered — nothing executes', async () => {
    assert.equal(isRufloConnected(), false);

    const result = await dispatchWorkflowViaRuflo(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'test objective' },
      { skipPersistence: true },
    );

    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.status, 'NOT_CONNECTED');
      assert.ok(result.reason.includes('No Ruflo orchestrator handle is registered'));
      assert.ok(result.reason.includes('Nothing was executed'));
    }
  });

  it('with a handle, executes through the existing runner and notifies with a bounded summary', async () => {
    const notifications: { status: string; stepCount: number }[] = [];
    registerRufloOrchestrator({
      id: 'test-orchestrator',
      onWorkflowCompleted: (summary) => {
        notifications.push({ status: summary.status, stepCount: summary.stepCount });
      },
    });
    assert.ok(getRegisteredRufloOrchestrator());

    const md = makeDispatch('SUCCEEDED');
    const result = await dispatchWorkflowViaRuflo(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'Build a productivity tool' },
      { providedState: HALAL_STATE, dispatch: md.dispatch, skipPersistence: true },
    );

    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.execution.status, 'COMPLETED');
      assert.ok(result.execution.steps.length > 0);
      assert.equal(result.execution.correlationId.length > 0, true);
    }
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, 'COMPLETED');
    assert.ok(notifications[0].stepCount > 0);
  });

  it('a broken notification channel never corrupts the workflow result', async () => {
    registerRufloOrchestrator({
      id: 'broken-orchestrator',
      onWorkflowCompleted: () => {
        throw new Error('notification channel exploded');
      },
    });

    const md = makeDispatch('SUCCEEDED');
    const result = await dispatchWorkflowViaRuflo(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'Build a productivity tool' },
      { providedState: HALAL_STATE, dispatch: md.dispatch, skipPersistence: true },
    );

    assert.equal(result.accepted, true);
    if (result.accepted) assert.equal(result.execution.status, 'COMPLETED');
  });

  it('reports RUFLO_CONNECTED only while a handle is registered; gates stay listed', () => {
    const disconnected = describeRufloIntegration();
    assert.equal(disconnected.status, 'NOT_CONNECTED');
    assert.ok(disconnected.unmetRequirements.length > 0);
    assert.ok(disconnected.availableContracts.length > 0);
    assert.ok(disconnected.invariantsPreserved.some((i) => i.includes('Halal gates')));

    registerRufloOrchestrator({ id: 'real-runtime' });
    const connected = describeRufloIntegration();
    assert.equal(connected.status, 'RUFLO_CONNECTED');
    assert.equal(connected.unmetRequirements.length, 0);
    assert.ok(connected.detail.includes('real-runtime'));
    // Invariants persist even when connected.
    assert.ok(connected.invariantsPreserved.some((i) => i.includes('Idempotency')));
  });

  it('rejects invalid handle registrations', () => {
    assert.equal(registerRufloOrchestrator(null as unknown as { id: string }).ok, false);
    assert.equal(registerRufloOrchestrator({ id: '' }).ok, false);
    assert.equal(isRufloConnected(), false);
  });

  it('human-review workflows stop at the gate even when dispatched by Ruflo', async () => {
    registerRufloOrchestrator({ id: 'gate-respecting-orchestrator' });

    const md = makeDispatch('SUCCEEDED');
    const result = await dispatchWorkflowViaRuflo(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'anything' },
      {
        providedState: { ...HALAL_STATE, halalStatus: 'REVIEW_REQUIRED' },
        dispatch: md.dispatch,
        skipPersistence: true,
      },
    );

    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.execution.status, 'HUMAN_REVIEW');
      // No step executed through dispatch.
      assert.equal(md.calls.length, 0);
    }
  });

  it('forwards the deterministic product analysis in the completion notification when PRODUCT_ANALYZE ran', async () => {
    const notifications: { productAnalysis?: RufloProductAnalysis }[] = [];
    registerRufloOrchestrator({
      id: 'learning-orchestrator',
      onWorkflowCompleted: (summary) => notifications.push({ productAnalysis: summary.productAnalysis }),
    });

    // Mimics the real runner's flat result shape for a factory outcome.
    const md = makeDispatch('SUCCEEDED');
    const baseDispatch = md.dispatch;
    const result = await dispatchWorkflowViaRuflo(
      { workflowType: 'PRODUCT_LAUNCH', objective: 'Launch it', opportunityId: 'opp-1' },
      {
        providedState: HALAL_STATE,
        skipPersistence: true,
        dispatch: async (jobType, payload, correlationId) => {
          const base = await baseDispatch(jobType, payload, correlationId);
          if (jobType === 'PRODUCT_ANALYZE') {
            return {
              ...base,
              result: {
                factoryJob: jobType,
                productId: 'prod-1',
                evidenceState: 'PROMISING',
                recommendedAction: 'IMPROVE',
                dataStatus: 'SUPPORTED',
                recordedVisitors: 40,
                visitorEvidenceStatus: 'SUPPORTED',
              },
            };
          }
          return base;
        },
      },
    );

    assert.equal(result.accepted, true);
    assert.equal(notifications.length, 1);
    const analysis = notifications[0].productAnalysis;
    assert.ok(analysis, 'productAnalysis must be present when PRODUCT_ANALYZE ran');
    assert.equal(analysis!['evidenceState'], 'PROMISING');
    assert.equal(analysis!['recommendedAction'], 'IMPROVE');
    assert.equal(analysis!['dataStatus'], 'SUPPORTED');
    assert.equal(analysis!['recordedVisitors'], 40);
  });

  it('omits productAnalysis when no PRODUCT_ANALYZE step ran — never fabricated', async () => {
    const notifications: { productAnalysis?: RufloProductAnalysis }[] = [];
    registerRufloOrchestrator({
      id: 'honest-orchestrator',
      onWorkflowCompleted: (summary) => notifications.push({ productAnalysis: summary.productAnalysis }),
    });

    const md = makeDispatch('SUCCEEDED');
    const result = await dispatchWorkflowViaRuflo(
      { workflowType: 'OPPORTUNITY_DISCOVERY', objective: 'Just research' },
      { providedState: HALAL_STATE, dispatch: md.dispatch, skipPersistence: true },
    );

    assert.equal(result.accepted, true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].productAnalysis, undefined);
  });
});
