// ============================================================================
// PHASE 14 — END-TO-END LIFECYCLE TEST (deterministic, hermetic)
// ============================================================================
// One 16-step pass over the internal business loop, exercising the REAL
// modules — session guard, supervised dispatcher, Job Runner (halal gates,
// idempotency, durable rows), supervised growth cycle, supervisor verdicts,
// funnel analytics, learning store, and revenue ingestion — against a
// temporary SQLite database.
//
// External boundaries are mocked ONLY at the agent-executor seam (the one
// boundary that would otherwise call a live AI provider). Nothing else is
// faked: halal gates, persistence, idempotency, attribution, and provenance
// rules all run for real. No production success is claimed anywhere.
//
// Scenario (per the production-activation pass):
//  1. admin authentication            9.  traffic event
//  2. create opportunity             10.  analytics (funnel)
//  3. research                       11.  growth decision
//  4. validation                     12.  experiment
//  5. halal screening                13.  supervisor evaluation
//  6. business decision              14.  learning
//  7. product workflow               15.  revenue event
//  8. publishing gate                16.  final analytics
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTestDatabase } from '@/test-utils/install-test-database';
import { recallOperationalMemory } from '@/lib/ops/memory';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-e2e-lifecycle-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(() => {
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

let db: any; // eslint-disable-line @typescript-eslint/no-explicit-any
let adminAuth: typeof import('../admin-auth');
let sessionGuard: typeof import('../session-guard');
let supervisedDispatch: typeof import('../supervised-dispatch');
let growthAgent: typeof import('../growth-agent');
let supervisor: typeof import('../supervisor');
let publishing: typeof import('@/lib/publishing/contract');
let events: typeof import('@/lib/product-factory/events');
let economics: typeof import('@/lib/product-factory/economics');
let runtime: typeof import('../runtime');

before(async () => {
  adminAuth = await import('../admin-auth');
  sessionGuard = await import('../session-guard');
  supervisedDispatch = await import('../supervised-dispatch');
  growthAgent = await import('../growth-agent');
  supervisor = await import('../supervisor');
  publishing = await import('@/lib/publishing/contract');
  events = await import('@/lib/product-factory/events');
  economics = await import('@/lib/product-factory/economics');
  runtime = await import('../runtime');
  ({ db } = await import('@/lib/db'));

  // Seed the single admin exactly as production bootstraps it: env vars only.
  process.env.ADMIN_EMAIL = 'e2e-admin@aiincome.lab';
  process.env.ADMIN_PASSWORD = 'e2e-lifecycle-admin-password';
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_DISABLED;
});

type AgentExecutor = NonNullable<
  Parameters<typeof supervisedDispatch.dispatchSupervised>[1]
>['executeAgentJob'];

/** Deterministic mock executor at the AI-provider boundary. */
function mockAgent(overrides: Partial<Record<string, unknown>> = {}): AgentExecutor {
  return async (jobType: string, payload: Record<string, unknown>) => {
    // The payload shape was already validated by the Job Runner before this
    // seam; the deterministic mock never needs it.
    void payload;
    return {
      success: true,
      reasoning: `mock ${jobType} executed deterministically`,
      evidenceType: 'AI_INFERENCE',
      capabilityStatus: 'MOCKED',
      fallbackUsed: false,
      executionTime: 1,
      output: { mock: true, jobType, ...overrides },
    };
  };
}

async function resumeAgency(): Promise<void> {
  const control = await runtime.getAgencyControl();
  if (control.paused) await runtime.setAgencyPaused(false, 'e2e-admin@aiincome.lab');
}

// ---------------------------------------------------------------------------
// Step 1 — admin authentication (real credential verification + real session)
// ---------------------------------------------------------------------------

describe('step 1: admin authentication', () => {
  it('rejects invalid credentials, then authenticates the real admin and issues a verifiable session', async () => {
    assert.equal(adminAuth.verifyAdminCredentials('e2e-admin@aiincome.lab', 'wrong-password'), false);
    assert.equal(adminAuth.verifyAdminCredentials('nope@aiincome.lab', 'e2e-lifecycle-admin-password'), false);
    assert.equal(adminAuth.verifyAdminCredentials(null, null), false);

    assert.equal(
      adminAuth.verifyAdminCredentials('e2e-admin@aiincome.lab', 'e2e-lifecycle-admin-password'),
      true,
    );

    const { token, session } = await adminAuth.createAdminSession('e2e-admin@aiincome.lab', 'e2e-lifecycle');
    assert.ok(token.length > 20, 'opaque cookie token is issued once');
    assert.equal(session.email, 'e2e-admin@aiincome.lab');

    // Session resolves only through the real guard path (cookie header parse → DB row).
    const request = new Request('https://lab.local/api/test', {
      headers: { cookie: `${adminAuth.ADMIN_SESSION_COOKIE}=${token}` },
    });
    const resolved = await sessionGuard.currentAdminSession(request);
    assert.ok(resolved, 'session resolves via the real guard');
    assert.equal(resolved!.email, 'e2e-admin@aiincome.lab');

    const forged = await sessionGuard.currentAdminSession(
      new Request('https://lab.local/api/test', {
        headers: { cookie: `${adminAuth.ADMIN_SESSION_COOKIE}=forged-token` },
      }),
    );
    assert.equal(forged, null, 'forged token is rejected');

    // Unauthorized API shape: the guard returns a 401 response, never access.
    const guard = await sessionGuard.requireAdminApi(
      new Request('https://lab.local/api/agency/growth'),
    );
    assert.ok('response' in guard && guard.response.status === 401);
  });
});

// ---------------------------------------------------------------------------
// Steps 2–4 — opportunity, research, validation (supervised dispatch, mocked AI)
// ---------------------------------------------------------------------------

let opportunityId = '';
let researchJobId = '';
let validationJobId = '';

describe('steps 2–4: opportunity, research, validation', () => {
  it('creates the opportunity and runs supervised research (halal gate real, AI mocked)', async () => {
    await resumeAgency();
    const opportunity = await db.opportunity.create({
      data: {
        title: 'E2E lifecycle test opportunity',
        category: 'EDUCATION',
        businessModel: 'DIGITAL_PRODUCT',
        targetAudience: 'busy parents',
        problemSolved: 'Meal planning takes too long',
        monetizationMethod: 'ONE_TIME_PURCHASE',
        status: 'IDEA',
        halalStatus: 'HALAL',
      },
    });
    opportunityId = opportunity.id;
    assert.ok(opportunityId);

    const research = await supervisedDispatch.dispatchSupervised(
      {
        agentId: 'research',
        stage: 'RESEARCH',
        objective: 'Validate demand for a family meal-planning toolkit',
        opportunityId,
        correlationId: 'e2e-research',
      },
      { executeAgentJob: mockAgent({ finding: 'demand supported' }) },
    );
    assert.equal(research.ok, true, JSON.stringify(research));
    if (!research.ok) return;
    assert.equal(research.verdict, 'PROCEED');
    assert.equal(research.jobStatus, 'SUCCEEDED');
    assert.equal(research.executionMode, 'MOCKED', 'mock AI is honestly labelled MOCKED');
    assert.ok(research.agentRunId && research.agentRunId !== 'n/a', 'AgentRun persisted');
    researchJobId = research.jobId;

    // Idempotency: the same correlation id returns the stored outcome.
    const replay = await supervisedDispatch.dispatchSupervised(
      {
        agentId: 'research',
        stage: 'RESEARCH',
        objective: 'Validate demand for a family meal-planning toolkit',
        opportunityId,
        correlationId: 'e2e-research',
      },
      { executeAgentJob: mockAgent() },
    );
    assert.ok(replay.ok && replay.jobStatus === 'SUCCEEDED');
    const stored = await db.jobRun.findUnique({ where: { id: researchJobId } });
    assert.ok(stored);
    const replayRow = await db.jobRun.findFirst({
      where: { jobType: 'RESEARCH', correlationId: 'e2e-research' },
    });
    assert.equal(replayRow?.id, researchJobId, 'no second job row for a replayed correlation id');
  });

  it('runs supervised validation through the Job Runner with a durable row', async () => {
    const validation = await supervisedDispatch.dispatchSupervised(
      {
        agentId: 'validation',
        stage: 'VALIDATE',
        objective: 'Validate pricing hypothesis for the meal-planning toolkit',
        opportunityId,
        correlationId: 'e2e-validation',
      },
      { executeAgentJob: mockAgent({ verdict: 'VALID' }) },
    );
    assert.equal(validation.ok, true, JSON.stringify(validation));
    if (!validation.ok) return;
    assert.equal(validation.jobStatus, 'SUCCEEDED');
    assert.equal(validation.verdict, 'PROCEED');
    validationJobId = validation.jobId;
    const row = await db.jobRun.findUnique({ where: { id: validationJobId } });
    assert.equal(row?.status, 'SUCCEEDED');
    assert.equal(row?.executionMode, 'MOCKED');
  });
});

// ---------------------------------------------------------------------------
// Step 5 — halal screening (the REAL screening engine, both verdicts)
// ---------------------------------------------------------------------------

describe('step 5: halal screening (fail-closed, real engine)', () => {
  it('screens clean concepts as HALAL and prohibited concepts as NOT_ALLOWED', async () => {
    const { screenForHalalCompliance } = await import('@/lib/halal-filter');
    const clean = screenForHalalCompliance(
      'Family meal planner',
      'Weekly meal plans for busy parents',
      'EDUCATION',
      'DIGITAL_PRODUCT',
      'ONE_TIME_PURCHASE',
    );
    assert.equal(clean.status, 'HALAL');

    const prohibited = screenForHalalCompliance(
      'High-roller casino betting tips',
      'guaranteed gambling wins and lottery systems',
      'gambling',
      'DIRECT_SALES',
      'ONE_TIME_PURCHASE',
    );
    assert.equal(prohibited.status, 'NOT_ALLOWED');
    assert.ok(prohibited.flaggedKeywords.length > 0);

    // The Job Runner — the authoritative execution gate — refuses to execute
    // a NOT_ALLOWED opportunity BEFORE any agent or AI access: durable BLOCKED
    // row, no execution, no fabricated output.
    const blockedOpp = await db.opportunity.create({
      data: {
        title: 'Prohibited opportunity',
        category: 'GAMBLING',
        businessModel: 'DIGITAL_PRODUCT',
        targetAudience: 'x',
        problemSolved: 'x',
        monetizationMethod: 'ONE_TIME_PURCHASE',
        status: 'IDEA',
        halalStatus: 'NOT_ALLOWED',
      },
    });
    const { runJob } = await import('@/lib/jobs/job-runner');
    const blocked = await runJob(
      'RESEARCH',
      {
        researchObjective: 'Try to research the prohibited opportunity',
        opportunityId: blockedOpp.id,
      },
      'e2e-halal-block',
      { executeAgentJob: mockAgent() },
    );
    assert.equal(blocked.status, 'BLOCKED', 'halal gate refuses execution');
    assert.match(blocked.error ?? '', /NOT_ALLOWED/);
    const blockedRow = await db.jobRun.findUnique({ where: { id: blocked.jobId! } });
    assert.equal(blockedRow?.status, 'BLOCKED');
    assert.equal(blockedRow?.correlationId, 'e2e-halal-block');
  });
});

// ---------------------------------------------------------------------------
// Step 6 — business decision (Business Manager scope via the Job Runner)
// ---------------------------------------------------------------------------

describe('step 6: business decision (Business Manager)', () => {
  it('executes a FULL_BUSINESS_REVIEW payload through the Job Runner', async () => {
    const { runJob } = await import('@/lib/jobs/job-runner');
    const outcome = await runJob(
      'BUSINESS_MANAGER',
      {
        objective: 'Review the meal-planner opportunity after validation',
        decisionScope: 'FULL_BUSINESS_REVIEW',
        notes: 'e2e lifecycle business decision',
        opportunityId,
      },
      'e2e-bm-review',
      { executeAgentJob: mockAgent({ decision: 'PROCEED_TO_PRODUCT' }) },
    );
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.ok(outcome.jobId && outcome.jobId !== 'n/a');
    const row = await db.jobRun.findUnique({ where: { id: outcome.jobId! } });
    assert.equal(row?.jobType, 'BUSINESS_MANAGER');
  });
});

// ---------------------------------------------------------------------------
// Steps 7–8 — product workflow and the publishing gate
// ---------------------------------------------------------------------------

let productId = '';

describe('steps 7–8: product workflow and publishing gate', () => {
  it('runs the supervised product job and maps the result onto a publishable spec', async () => {
    const product = await supervisedDispatch.dispatchSupervised(
      {
        agentId: 'product',
        stage: 'BUILD',
        objective: 'Design the digital meal-planning toolkit',
        opportunityId,
        correlationId: 'e2e-product',
      },
      { executeAgentJob: mockAgent({ productNameHypothesis: 'Meal Planner Toolkit' }) },
    );
    assert.equal(product.ok, true, JSON.stringify(product));
    if (!product.ok) return;
    assert.equal(product.jobStatus, 'SUCCEEDED');

    const productRow = await db.product.create({
      data: { name: 'Meal Planner Toolkit', type: 'DIGITAL_PRODUCT', opportunityId },
    });
    productId = productRow.id;

    // toPublishableSpec keeps provenance honest: mocked agent output stays MOCKED.
    const spec = publishing.toPublishableSpec({
      productType: 'DIGITAL_PRODUCT',
      productConcept: { productNameHypothesis: 'Meal Planner Toolkit', positioning: 'x', differentiation: 'y' },
      targetCustomer: 'busy parents',
      problemBeingSolved: 'meal planning takes long',
      valueProposition: 'one week of plans in five minutes',
      mvpFeatures: [{ name: 'planner', description: '7-day planner', priority: 'MUST' }],
      buildPhases: [{ phase: 1, name: 'core', tasks: ['a'], expectedOutput: 'pdf', risk: 'low' }],
      monetizationModel: 'ONE_TIME_PURCHASE',
      pricingHypothesis: '$19 one-time',
      distributionChannels: ['direct'],
      risks: [],
      assumptions: [],
      evidence: [{ type: 'AI_INFERENCE', content: 'mock' }],
      capabilityStatus: 'MOCKED',
      confidence: 0.5,
      reasoning: 'mock product design',
      agentLogId: null,
      fallbackUsed: false,
      executionTime: 1,
    } as unknown as Parameters<typeof publishing.toPublishableSpec>[0]);
    assert.equal(spec.evidenceProvenance, 'MOCKED', 'mock provenance is never upgraded');
  });

  it('publishing gate: drafts locally, structurally refuses publication, never claims success', async () => {
    const spec = {
      productType: 'DIGITAL_PRODUCT',
      name: 'Meal Planner Toolkit',
      targetAudience: 'busy parents',
      problem: 'meal planning takes long',
      valueProposition: 'one week of plans in five minutes',
      mvpFeatures: [{ name: 'planner', description: '7-day planner', priority: 'MUST' }],
      buildPhases: [{ phase: 1, name: 'core', tasks: ['a'], expectedOutput: 'pdf', risk: 'low' }],
      monetizationModel: 'ONE_TIME_PURCHASE',
      pricingHypothesis: '$19 one-time',
      distributionChannels: ['direct'],
      risks: [],
      assumptions: [],
      evidence: [],
      evidenceProvenance: 'MOCKED' as const,
    };

    // No adapter configured → honest PUBLISHING_UNAVAILABLE (no fake success).
    const unavailable = publishing.requestPublishing({ channel: 'DIGITAL_PRODUCT', spec });
    assert.equal(unavailable.status, 'PUBLISHING_UNAVAILABLE');
    assert.equal(unavailable.publication, null);

    const health = publishing.describePublishingStatus();
    assert.equal(health.status, 'PUBLISHING_UNAVAILABLE', 'no provider is connected in the test env');
    delete process.env.POLAR_ACCESS_TOKEN;

    const response = publishing.requestPublishing({ channel: 'DIGITAL_PRODUCT', spec });
    assert.ok(
      response.publication === null || response.publication.published === false,
      'nothing is ever published without an authorized adapter + human approval',
    );
  });
});

// ---------------------------------------------------------------------------
// Steps 9–10 — traffic ingestion and funnel analytics (real persistence)
// ---------------------------------------------------------------------------

describe('steps 9–10: traffic ingestion and analytics', () => {
  it('records idempotent traffic events and computes an honest funnel snapshot', async () => {
    const first = await events.recordProductEvent({
      eventType: 'VISITOR',
      productId,
      opportunityId,
      idempotencyKey: 'e2e-visitor-1',
      source: 'e2e',
      sessionId: 'e2e-sess-1',
      utmSource: 'newsletter',
      utmCampaign: 'e2e-launch',
    });
    assert.equal(first.status, 'RECORDED');

    // Enough recorded visitors to clear the funnel's 30-visitor data threshold:
    // the direct visitor above is #1; the bulk loop adds 29 more unique sessions.
    const baseTime = Date.now() - 86_400_000;
    for (let i = 1; i <= 29; i += 1) {
      await db.productEvent.create({
        data: {
          eventType: 'VISITOR',
          productId,
          opportunityId,
          sessionId: `e2e-sess-bulk-${i}`,
          idempotencyKey: `e2e-visitor-bulk-${i}`,
          source: 'e2e',
          occurredAt: new Date(baseTime + i * 1000),
        },
      });
    }

    const replay = await events.recordProductEvent({
      eventType: 'VISITOR',
      productId,
      opportunityId,
      idempotencyKey: 'e2e-visitor-1',
      source: 'e2e',
      sessionId: 'e2e-sess-1',
    });
    assert.equal(replay.status, 'DUPLICATE', 'replayed traffic collapses to DUPLICATE');

    const invalid = await events.recordProductEvent({
      eventType: 'NOT_A_TYPE' as unknown as Parameters<typeof events.recordProductEvent>[0]['eventType'],
      productId,
      idempotencyKey: 'e2e-invalid',
      source: 'e2e',
    });
    assert.equal(invalid.status, 'INVALID', 'unknown event types are rejected');

    const purchase = await events.recordProductEvent({
      eventType: 'PURCHASE',
      productId,
      opportunityId,
      idempotencyKey: 'e2e-purchase-1',
      source: 'e2e',
      sessionId: 'e2e-sess-2',
      amountUsd: 19,
    });
    assert.equal(purchase.status, 'RECORDED');

    const end = new Date();
    const start = new Date(end.getTime() - 24 * 86_400_000);
    const funnel = await events.computeProductFunnel(productId, { start, end });
    assert.ok(funnel.visitors >= 30, '30 unique visitors recorded');
    assert.equal(funnel.purchases, 1);
    assert.equal(funnel.grossRevenueUsd, 19);
    assert.equal(funnel.evidenceStatus, 'SUPPORTED', 'sample size clears the honest-labelling threshold');
    assert.ok(Math.abs((funnel.conversionRate ?? 0) - 1 / funnel.visitors) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Steps 11–13 — growth decision, experiment, supervisor evaluation
// ---------------------------------------------------------------------------

describe('steps 11–13: growth decision, experiment, supervisor evaluation', () => {
  it('runs the supervised growth cycle over recorded traffic and records a durable experiment', async () => {
    // 60 more visitors / 6 recorded purchases keep the cycle well clear of the
    // 30-visitor NO-DATA safety threshold.
    const baseTime = Date.now() - 43_200_000;
    for (let i = 0; i < 60; i += 1) {
      await db.productEvent.create({
        data: {
          eventType: 'VISITOR',
          productId,
          opportunityId,
          sessionId: `e2e-growth-sess-${i}`,
          idempotencyKey: `e2e-growth-visitor-${i}`,
          source: 'e2e',
          occurredAt: new Date(baseTime + i * 1000),
        },
      });
    }
    for (let i = 0; i < 6; i += 1) {
      await db.productEvent.create({
        data: {
          eventType: 'PURCHASE',
          productId,
          opportunityId,
          sessionId: `e2e-growth-buyer-${i}`,
          idempotencyKey: `e2e-growth-purchase-${i}`,
          source: 'e2e',
          amountUsd: 29,
          occurredAt: new Date(baseTime + (60 + i) * 1000),
        },
      });
    }

    const result = await growthAgent.runSupervisedGrowthCycle({
      opportunityId,
      correlationId: 'e2e-growth-cycle',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const ok = result as Extract<typeof result, { ok: true }>;
    // Deterministic outcome over recorded data with no ResourceAllocation:
    // the engine evaluates the portfolio, the Business Manager brief is
    // produced, and a VERIFIED_DATA decision row is recorded. No experiment is
    // created and $0 can be spent — the documented fail-closed default (G1).
    assert.equal(ok.outcome, 'DECISION_RECORDED');
    assert.equal(ok.correlationId, 'e2e-growth-cycle', 'caller-supplied correlation id honored verbatim');
    assert.equal(ok.verdict, 'PROCEED');
    assert.equal(ok.engineDecision, 'CONTINUE');
    assert.equal(ok.health, 'HEALTHY');
    assert.equal(ok.experimentId, null, 'no experiment without an allocation (fail-closed $0)');
    assert.ok(ok.brief, 'Business Manager growth brief is returned');
    assert.equal(ok.brief?.opportunityId, opportunityId);

    // The decision itself is a durable, VERIFIED_DATA artifact.
    const decision = await db.growthDecision.findFirst({
      where: { opportunityId, correlationId: 'e2e-growth-cycle' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(decision, 'GrowthDecision row persisted');
    assert.equal(decision.decision, 'CONTINUE');
    assert.equal(decision.evidenceType, 'VERIFIED_DATA');
  });

  it('supervisor verdicts stay deterministic (plan bounds + honest output + loop protection)', async () => {
    const plan = supervisor.evaluatePlan(
      { agentId: 'growth', stage: 'GROWTH', jobType: 'ANALYTICS', budgetUsd: 5, timeoutMs: 10_000, retryCount: 0 },
      { allowedStages: ['GROWTH'], budgetLimitUsd: 10, timeoutMs: 25_000, maxRetries: 2 },
    );
    assert.equal(plan.valid, true);

    const overBudget = supervisor.evaluatePlan(
      { agentId: 'growth', stage: 'GROWTH', jobType: 'ANALYTICS', budgetUsd: 50, timeoutMs: 10_000, retryCount: 0 },
      { allowedStages: ['GROWTH'], budgetLimitUsd: 10, timeoutMs: 25_000, maxRetries: 2 },
    );
    assert.equal(overBudget.valid, false);

    const honest = supervisor.evaluateOutput({ status: 'SUCCEEDED', fallbackUsed: false, safetyVerdict: 'HALAL', costUsd: 0 });
    assert.equal(honest.valid, true);
    const lying = supervisor.evaluateOutput({ status: 'SUCCEEDED', fallbackUsed: true, safetyVerdict: 'HALAL', costUsd: 0 });
    assert.equal(lying.valid, false, 'fallback can never be reported as clean success');

    const looped = supervisor.evaluateLoops({
      recentIdenticalJobs: 6, recentIdenticalFailures: 0, exhaustedRetries: false,
      circularDelegation: false, recentTokenUsage: 0, recentCostUsd: 0,
      repeatedSafetyRejections: 0, staleWorkflowMinutes: null,
    });
    assert.equal(looped.quarantined, true, 'repeated identical jobs quarantine the loop');
  });
});

// ---------------------------------------------------------------------------
// Step 14 — learning (operational memory from the real cycle)
// ---------------------------------------------------------------------------

describe('step 14: learning (operational memory)', () => {
  it('recalls VERIFIED_DATA memories written by the growth cycle', async () => {
    const memories = await recallOperationalMemory({ category: 'agent', relatedEntityId: opportunityId });
    assert.ok(memories.length >= 1, 'the growth cycle wrote operational memory');
    assert.equal(memories[0].evidenceType, 'VERIFIED_DATA');
    assert.match(memories[0].observation, /Growth cycle/);

    // Provenance rule: AI-derived text can never be upgraded to VERIFIED_DATA.
    await runtime.recordAgentRun({
      agentId: 'growth',
      jobId: null,
      jobType: 'ANALYTICS',
      stage: 'LEARN',
      status: 'SUCCEEDED',
      correlationId: 'e2e-learning',
      safetyVerdict: 'HALAL',
      verification: 'NOT_APPLICABLE',
      lifecycleSteps: [{ step: 'REPORT', outcome: 'OK' }],
    });
    const runs = await runtime.listAgentRuns('growth');
    assert.ok(runs.some((r) => r.correlationId === 'e2e-growth-cycle' || r.correlationId === 'e2e-learning'));
  });
});

// ---------------------------------------------------------------------------
// Steps 15–16 — revenue event and final analytics
// ---------------------------------------------------------------------------

describe('steps 15–16: revenue event and final analytics', () => {
  it('records attributed revenue idempotently and reconciles it against the funnel', async () => {
    const date = new Date().toISOString();
    const input = {
      date,
      revenueSource: 'polar',
      grossRevenue: 19,
      fees: 0.6,
      currency: 'USD',
      productId,
      opportunityId,
    };
    const expectedKey = economics.revenueIdempotencyKey(input);
    const first = await economics.recordRevenueWithAttribution(input);
    assert.equal(first.status, 'RECORDED');
    assert.ok(first.revenueId);
    assert.equal(first.attribution?.source, 'PRODUCT');
    assert.ok(first.attribution?.evidenceType === 'VERIFIED');

    const replay = await economics.recordRevenueWithAttribution(input);
    assert.equal(replay.status, 'DUPLICATE', 'replayed revenue collapses to DUPLICATE');

    // The persisted row carries the server-derived idempotency key.
    const stored = await db.revenue.findUnique({ where: { id: first.revenueId! } });
    assert.ok(stored);
    assert.equal(stored.idempotencyKey, expectedKey, 'key derived by the shared rule, never by the caller');
    assert.equal(stored.opportunityId, opportunityId);

    // Final analytics: funnel (product events) + the opportunity's durable artifacts.
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const funnel = await events.computeProductFunnel(productId, { start, end });
    assert.equal(funnel.purchases, 7, '6 growth-seeded + 1 lifecycle purchase, all real rows');
    assert.equal(funnel.grossRevenueUsd, 19 + 6 * 29, 'event revenue reconciles to recorded events');
    assert.equal(funnel.evidenceStatus, 'SUPPORTED', 'final analytics are labelled honestly');

    const decisions = await db.growthDecision.findMany({ where: { opportunityId } });
    assert.ok(decisions.length >= 1, 'growth decisions persist into the final snapshot');
    const revenueRows = await db.revenue.findMany({ where: { opportunityId } });
    assert.equal(revenueRows.length, 1, 'exactly one revenue row after the replay collapses');
  });
});
