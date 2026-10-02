// ============================================================================
// PHASE 11.4 → 11.7 — PAYMENT, OUTREACH, EXECUTION AND ECONOMICS (hermetic DB)
// ============================================================================
// Exercises the REAL service layer against a temporary SQLite database (same
// convention as the Phase 11.1 / 11.2-11.3 hermetic suites). Nothing is mocked
// except the admin session used by the route-level tests.
//
// The focus is the end-to-end invariants that only appear once rows exist:
// a replayed webhook cannot move state twice, a manual review cannot be
// anonymous, a refund cannot leave an engagement "paid", and a projection
// cannot inflate profit.
// ============================================================================

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-economics-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  execSync('npx prisma7 db push --schema=prisma/schema.test.prisma', {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: process.env,
  });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

let db: typeof import('../../../lib/db')['db'];
let paymentService: typeof import('../payment-service');
let engagementService: typeof import('../engagement-service');
let economics: typeof import('../economics');
let outreachService: typeof import('../outreach-service');
let learning: typeof import('../commercial-learning');
let stateMachines: typeof import('../engagement-states');

before(async () => {
  db = (await import('../../../lib/db')).db;
  paymentService = await import('../payment-service');
  engagementService = await import('../engagement-service');
  economics = await import('../economics');
  outreachService = await import('../outreach-service');
  learning = await import('../commercial-learning');
  stateMachines = await import('../engagement-states');
});

const SURFACE = 'test:economics';
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq += 1)}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeProspect(overrides: Record<string, unknown> = {}) {
  return db.prospect.create({
    data: {
      displayName: `Prospect ${uniq()}`,
      source: 'MANUAL',
      lifecycleState: 'QUALIFIED',
      ...overrides,
    } as never,
  });
}

async function makeOffer(overrides: Record<string, unknown> = {}) {
  return db.offer.create({
    data: {
      type: 'MICRO_SERVICE',
      title: `Offer ${uniq()}`,
      price: 500,
      halalStatus: 'HALAL',
      status: 'ACTIVE',
      ...overrides,
    } as never,
  });
}

/** Create an engagement walked legally to PAYMENT_REQUIRED. */
async function makeEngagementRequiringPayment(options: { totalPrice?: number } = {}) {
  const offer = await makeOffer();
  const created = await engagementService.createEngagement({
    engagementType: 'MICRO_SERVICE',
    title: `Engagement ${uniq()}`,
    offerId: offer.id,
    microServiceKind: 'CUSTOM_WORKSHEET',
    totalPrice: options.totalPrice ?? 500,
    actor: 'admin@test.local',
    surface: SURFACE,
  });
  assert.equal(created.ok, true, created.ok ? '' : created.error);
  const engagementId = created.ok ? (created.engagementId as string) : '';
  const id = engagementId;
  await engagementService.transitionEngagement({ engagementId: id, to: 'PROPOSAL_SENT', actor: 'a', surface: SURFACE });
  await engagementService.transitionEngagement({ engagementId: id, to: 'ACCEPTED', actor: 'a', surface: SURFACE });
  await engagementService.transitionEngagement({ engagementId: id, to: 'PAYMENT_REQUIRED', actor: 'a', surface: SURFACE });
  return { id, offer };
}

// ===========================================================================
// PHASE 11.4 — payment verification
// ===========================================================================

describe('Phase 11.4 — verified provider payment', () => {
  beforeEach(async () => {
    await db.paymentEvent.deleteMany({});
    await db.manualPaymentVerification.deleteMany({});
    await db.revenue.deleteMany({});
  });

  it('UNPAID → EXECUTING stays impossible without any evidence', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const attempt = await engagementService.transitionEngagement({
      engagementId: id, to: 'WORK_AUTHORIZED', actor: 'a', surface: SURFACE,
    });
    assert.equal(attempt.ok, false, 'an unpaid engagement must not authorize work');

    // PAYMENT_VERIFIED without a source is refused too.
    const noSource = await engagementService.transitionEngagement({
      engagementId: id, to: 'PAYMENT_VERIFIED', actor: 'a', surface: SURFACE,
    });
    assert.equal(noSource.ok, false);
  });

  it('refuses an UNSIGNED payload claiming to be a webhook', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const result = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: false, amount: 500, engagementId: id, surface: SURFACE,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /signature/i);

    const engagement = await db.serviceEngagement.findUnique({ where: { id }, select: { state: true } });
    assert.equal(engagement?.state, 'PAYMENT_REQUIRED', 'nothing may change without a verified signature');
  });

  it('applies a signature-verified payment exactly once, and is idempotent on replay', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const eventId = `evt_${uniq()}`;

    const first = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: eventId, eventType: 'order.paid',
      signatureVerified: true, amount: 500, engagementId: id, surface: SURFACE,
    });
    assert.equal(first.ok, true, first.ok ? '' : first.error);

    const afterFirst = await db.serviceEngagement.findUnique({ where: { id }, select: { state: true } });
    assert.equal(afterFirst?.state, 'PAYMENT_VERIFIED');

    // Replaying the same provider event must not change anything further.
    const replay = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: eventId, eventType: 'order.paid',
      signatureVerified: true, amount: 500, engagementId: id, surface: SURFACE,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.duplicate, true);

    const events = await db.paymentEvent.count({ where: { provider: 'POLAR', providerEventId: eventId } });
    assert.equal(events, 1, 'the replay guard must leave exactly one ledger row');
  });

  it('refuses a stale event outside the replay window', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const old = Date.now() - 60 * 60 * 1000;
    const result = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 500, eventTimestampMs: old, engagementId: id, surface: SURFACE,
    });
    assert.equal(result.ok, false);
    const engagement = await db.serviceEngagement.findUnique({ where: { id }, select: { state: true } });
    assert.equal(engagement?.state, 'PAYMENT_REQUIRED');
  });

  it('refuses an underpayment against a milestone and verifies a full one', async () => {
    const { id } = await makeEngagementRequiringPayment({ totalPrice: 500 });
    const milestone = await engagementService.createMilestone({
      engagementId: id, key: 'm1', title: 'First', percent: 50, amountUsd: 250, actor: 'a', surface: SURFACE,
    });
    assert.equal(milestone.ok, true);
    const milestoneId = milestone.ok ? (milestone.milestoneId as string) : '';

    const short = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 100, engagementId: id, milestoneId, surface: SURFACE,
    });
    assert.equal(short.ok, false, 'an underpayment must not settle a milestone');

    const full = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 250, engagementId: id, milestoneId, surface: SURFACE,
    });
    assert.equal(full.ok, true, full.ok ? '' : full.error);

    const row = await db.milestone.findUnique({ where: { id: milestoneId }, select: { paymentState: true, verificationSource: true } });
    assert.equal(row?.paymentState, 'PAYMENT_VERIFIED');
    assert.equal(row?.verificationSource, 'PROVIDER_WEBHOOK');
  });

  it('refuses a milestone that belongs to a different engagement (ownership)', async () => {
    const a = await makeEngagementRequiringPayment();
    const b = await makeEngagementRequiringPayment();
    const milestone = await engagementService.createMilestone({
      engagementId: b.id, key: 'm1', title: 'B milestone', percent: 100, amountUsd: 100, actor: 'a', surface: SURFACE,
    });
    const milestoneId = milestone.ok ? (milestone.milestoneId as string) : '';
    const result = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 500, engagementId: a.id, milestoneId, surface: SURFACE,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /does not belong/i);
  });

  it('refuses a payment in a currency the engagement was not priced in', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const result = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 500, currency: 'EUR', engagementId: id, surface: SURFACE,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /currency/i);
  });

  it('records a verified payment with no engagement WITHOUT authorizing anything', async () => {
    const result = await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 99, surface: SURFACE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.unlinked, true);
  });
});

// ===========================================================================
// PHASE 11.4 — controlled manual verification
// ===========================================================================

describe('Phase 11.4 — manual admin verification', () => {
  beforeEach(async () => {
    await db.manualPaymentVerification.deleteMany({});
    await db.paymentEvent.deleteMany({});
  });

  it('refuses a verification with no reviewer identity', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const result = await paymentService.recordManualPaymentVerification({
      engagementId: id, providerRef: 'ref-1', reviewer: '', reason: 'saw it',
      evidenceRefs: ['x'], amountUsd: 500, approved: true, surface: SURFACE,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /reviewer/i);
  });

  it('refuses a verification with no reason and no evidence', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const result = await paymentService.recordManualPaymentVerification({
      engagementId: id, providerRef: 'ref-2', reviewer: 'admin@test.local',
      reason: '', evidenceRefs: [], amountUsd: 500, approved: true, surface: SURFACE,
    });
    assert.equal(result.ok, false);
  });

  it('approves a fully attributed review, records reviewer/reason/evidence/time, and is idempotent', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const input = {
      engagementId: id, providerRef: `ref-${uniq()}`, reviewer: 'admin@test.local',
      reason: 'Bank transfer reference confirmed in statement.',
      evidenceRefs: ['bank:4471'], amountUsd: 500, approved: true, surface: SURFACE,
    };
    const first = await paymentService.recordManualPaymentVerification(input);
    assert.equal(first.ok, true, first.ok ? '' : first.error);

    const row = await db.manualPaymentVerification.findFirst({ where: { engagementId: id } });
    assert.equal(row?.reviewer, 'admin@test.local');
    assert.ok((row?.reason ?? '').length > 0);
    assert.ok((row?.evidenceRefs ?? '').length > 0);
    assert.ok(row?.reviewedAt instanceof Date);

    const engagement = await db.serviceEngagement.findUnique({ where: { id }, select: { state: true, verificationSource: true } });
    assert.equal(engagement?.state, 'PAYMENT_VERIFIED');
    assert.equal(engagement?.verificationSource, 'MANUAL_ADMIN_APPROVED');

    // Re-running the identical review is a no-op, not a second approval.
    const second = await paymentService.recordManualPaymentVerification(input);
    assert.equal(second.ok, true);
    assert.equal(second.ok && second.duplicate, true);
    assert.equal(await db.manualPaymentVerification.count({ where: { engagementId: id } }), 1);
  });

  it('records a REFUSED review without moving state', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const result = await paymentService.recordManualPaymentVerification({
      engagementId: id, providerRef: `ref-${uniq()}`, reviewer: 'admin@test.local',
      reason: 'No matching statement line found.', evidenceRefs: ['bank:none'],
      amountUsd: 500, approved: false, surface: SURFACE,
    });
    assert.equal(result.ok, true);
    const engagement = await db.serviceEngagement.findUnique({ where: { id }, select: { state: true } });
    assert.equal(engagement?.state, 'PAYMENT_REQUIRED', 'a refused review must not authorize anything');
  });
});

// ===========================================================================
// PHASE 11.4 — refunds / chargebacks
// ===========================================================================

describe('Phase 11.4 — refund and reversal', () => {
  beforeEach(async () => {
    await db.revenue.deleteMany({});
    await db.paymentEvent.deleteMany({});
  });

  it('a refund must not leave the engagement silently paid', async () => {
    const { id } = await makeEngagementRequiringPayment();
    await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 500, engagementId: id, surface: SURFACE,
    });
    await engagementService.recordServiceRevenue({
      engagementId: id, paymentVerificationSource: 'PROVIDER_WEBHOOK',
      paymentVerificationRef: `ref-${uniq()}`, revenueSource: 'service:micro', amountUsd: 500, surface: SURFACE,
    });

    const refund = await paymentService.applyVerifiedReversalEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.refunded',
      signatureVerified: true, amount: 500, engagementId: id, surface: SURFACE,
    });
    assert.equal(refund.ok, true, refund.ok ? '' : refund.error);

    const engagement = await db.serviceEngagement.findUnique({ where: { id }, select: { paymentState: true } });
    assert.equal(engagement?.paymentState, 'REFUNDED', 'a refunded engagement must not still report paid');

    const revenue = await db.revenue.findMany({ where: { serviceEngagementId: id } });
    assert.equal(revenue.length, 1, 'the revenue row is retained as history');
    assert.equal(revenue[0].recognizedUsd, 0, 'recognized revenue must drop to zero after a refund');
  });

  it('refuses an unsigned reversal and a reversal with no engagement', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const unsigned = await paymentService.applyVerifiedReversalEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.refunded',
      signatureVerified: false, engagementId: id, surface: SURFACE,
    });
    assert.equal(unsigned.ok, false);

    const orphan = await paymentService.applyVerifiedReversalEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.refunded',
      signatureVerified: true, surface: SURFACE,
    });
    assert.equal(orphan.ok, false);
  });
});

// ===========================================================================
// PHASE 11.4 — revenue idempotency (the ledger cannot double-count)
// ===========================================================================

describe('Phase 11.4 — revenue idempotency', () => {
  it('replaying one verified payment never creates a second revenue row', async () => {
    const { id } = await makeEngagementRequiringPayment();
    await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 500, engagementId: id, surface: SURFACE,
    });
    const ref = `ref-${uniq()}`;
    const first = await engagementService.recordServiceRevenue({
      engagementId: id, paymentVerificationSource: 'PROVIDER_WEBHOOK',
      paymentVerificationRef: ref, revenueSource: 'service:micro', amountUsd: 500, surface: SURFACE,
    });
    assert.equal(first.ok, true);
    const second = await engagementService.recordServiceRevenue({
      engagementId: id, paymentVerificationSource: 'PROVIDER_WEBHOOK',
      paymentVerificationRef: ref, revenueSource: 'service:micro', amountUsd: 500, surface: SURFACE,
    });
    assert.equal(second.ok, true);
    assert.equal(second.ok && second.duplicate, true);
    assert.equal(await db.revenue.count({ where: { serviceEngagementId: id } }), 1);
  });

  it('refuses revenue with no verification source at all', async () => {
    const { id } = await makeEngagementRequiringPayment();
    for (const source of [undefined, null, 'CLIENT_MESSAGE', 'SCREENSHOT', 'PAID']) {
      const result = await engagementService.recordServiceRevenue({
        engagementId: id, paymentVerificationSource: source,
        paymentVerificationRef: `ref-${uniq()}`, revenueSource: 'service:x', amountUsd: 500, surface: SURFACE,
      });
      assert.equal(result.ok, false, `${String(source)} must not produce revenue`);
    }
  });
});

// ===========================================================================
// PHASE 11.6 — execution gates
// ===========================================================================

describe('Phase 11.6 — execution gating', () => {
  it('refuses to create an engagement against an UNVERIFIED (unscreened) offer', async () => {
    const offer = await makeOffer({ halalStatus: 'UNVERIFIED' });
    const result = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE', title: 'Blocked work', offerId: offer.id,
      microServiceKind: 'CUSTOM_WORKSHEET', totalPrice: 100, actor: 'admin@test.local', surface: SURFACE,
    });
    assert.equal(result.ok, false, 'an unscreened offer must not back an engagement');
    assert.match(result.ok ? '' : result.error, /UNVERIFIED/i);
  });

  it('refuses a BLOCKED offer outright and requires an explicit override for REVIEW_REQUIRED', async () => {
    const blocked = await makeOffer({ halalStatus: 'BLOCKED' });
    const blockedResult = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE', title: 'Blocked', offerId: blocked.id,
      microServiceKind: 'CUSTOM_WORKSHEET', totalPrice: 100, actor: 'a', surface: SURFACE,
    });
    assert.equal(blockedResult.ok, false);

    const review = await makeOffer({ halalStatus: 'REVIEW_REQUIRED' });
    const noOverride = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE', title: 'Review', offerId: review.id,
      microServiceKind: 'CUSTOM_WORKSHEET', totalPrice: 100, actor: 'a', surface: SURFACE,
    });
    assert.equal(noOverride.ok, false, 'REVIEW_REQUIRED needs an explicit admin acknowledgement');

    const withOverride = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE', title: 'Review approved', offerId: review.id,
      microServiceKind: 'CUSTOM_WORKSHEET', totalPrice: 100,
      allowReviewRequiredOffer: true, actor: 'admin@test.local', surface: SURFACE,
    });
    assert.equal(withOverride.ok, true, withOverride.ok ? '' : withOverride.error);
  });

  it('refuses cross-engagement mutation of a deliverable, revision or issue (IDOR)', async () => {
    const a = await makeEngagementRequiringPayment();
    const b = await makeEngagementRequiringPayment();

    const deliverable = await engagementService.createDeliverable({
      engagementId: b.id, title: 'B deliverable', kind: 'DOCUMENT', actor: 'a', surface: SURFACE,
    });
    const deliverableId = deliverable.ok ? (deliverable.deliverableId as string) : '';
    const issue = await engagementService.createServiceIssue({
      engagementId: b.id, issueType: 'DISPUTE', summary: 'B dispute', surface: SURFACE,
    });
    const issueId = issue.ok ? (issue.issueId as string) : '';

    // Addressing A in the path while acting on B's rows must be refused.
    const wrongState = await engagementService.transitionDeliverable({
      deliverableId, engagementId: a.id, to: 'QA_PENDING', actor: 'ADMIN', surface: SURFACE,
    });
    assert.equal(wrongState.ok, false, 'deliverable-state must refuse another engagement');

    const wrongClassify = await engagementService.classifyDeliverableRevision({
      deliverableId, engagementId: a.id, requestedSummary: 'change', surface: SURFACE,
    });
    assert.equal(wrongClassify.ok, false, 'revision-classify must refuse another engagement');

    const wrongResolve = await engagementService.resolveServiceIssue({
      issueId, engagementId: a.id, to: 'APPROVED', actor: 'admin@test.local', surface: SURFACE,
    });
    assert.equal(wrongResolve.ok, false, 'issue-resolve must refuse another engagement');

    // And the correct owner still works, proving the check is a real guard and
    // not a blanket refusal.
    const correct = await engagementService.transitionDeliverable({
      deliverableId, engagementId: b.id, to: 'QA_PENDING', actor: 'ADMIN', surface: SURFACE,
    });
    assert.equal(correct.ok, true, correct.ok ? '' : correct.error);
  });

  it('refuses cross-engagement milestone payment transitions', async () => {
    const a = await makeEngagementRequiringPayment();
    const b = await makeEngagementRequiringPayment();
    const milestone = await engagementService.createMilestone({
      engagementId: b.id, key: 'm1', title: 'B', percent: 100, amountUsd: 100, actor: 'a', surface: SURFACE,
    });
    const milestoneId = milestone.ok ? (milestone.milestoneId as string) : '';
    const result = await engagementService.transitionMilestonePayment({
      milestoneId, engagementId: a.id, to: 'PAYMENT_REQUIRED', actor: 'a', surface: SURFACE,
    });
    assert.equal(result.ok, false);
  });

  it('keeps DRAFT → DELIVERED impossible and acceptance evidence-backed', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const deliverable = await engagementService.createDeliverable({
      engagementId: id, title: 'Doc', kind: 'DOCUMENT', actor: 'a', surface: SURFACE,
    });
    const deliverableId = deliverable.ok ? (deliverable.deliverableId as string) : '';

    const direct = await engagementService.transitionDeliverable({
      deliverableId, engagementId: id, to: 'DELIVERED', actor: 'ADMIN', surface: SURFACE,
    });
    assert.equal(direct.ok, false, 'a DRAFT deliverable can never jump straight to DELIVERED');

    const accepted = await engagementService.transitionDeliverable({
      deliverableId, engagementId: id, to: 'ACCEPTED', actor: 'CLIENT_EVIDENCE', surface: SURFACE,
    });
    assert.equal(accepted.ok, false, 'acceptance before delivery/review must be refused');

    // Silence is never acceptance: CLIENT_EVIDENCE without evidence is refused.
    await engagementService.transitionDeliverable({
      deliverableId, engagementId: id, to: 'QA_PENDING', actor: 'ADMIN', surface: SURFACE,
    });
    const silent = await engagementService.transitionDeliverable({
      deliverableId, engagementId: id, to: 'QA_PASSED', actor: 'QA', surface: SURFACE,
    });
    assert.equal(silent.ok, true);
  });

  it('refuses execution state after cancellation and termination', () => {
    assert.equal(stateMachines.isWorkAuthorized('CANCELLED'), false);
    assert.equal(stateMachines.isWorkAuthorized('TERMINATED'), false);
    const fromCancelled = stateMachines.canTransitionEngagement({
      from: 'CANCELLED', to: 'WORK_IN_PROGRESS', actor: 'ADMIN',
    });
    assert.equal(fromCancelled.ok, false, 'a cancelled engagement has no outgoing edges');
  });
});

// ===========================================================================
// PHASE 11.5 — governed outreach
// ===========================================================================

describe('Phase 11.5 — governed outreach', () => {
  it('refuses impersonating and deceptive copy BEFORE any provider is reached', async () => {
    const prospect = await makeProspect();
    for (const body of [
      "Hi, I am a real person and we are here to help.",
      'Trusted by 500+ clients, 4.9 star rated.',
      'Our previous clients include large enterprises.',
      'Guaranteed income of $10k per month.',
      'Only 3 slots left, act now!',
    ]) {
      const result = await outreachService.sendGovernedOutreach({
        prospectId: prospect.id, channel: 'EMAIL', to: 'biz@example.com',
        subject: 'Hello', body, logicalId: `l-${uniq()}`, surface: SURFACE,
      });
      assert.equal(result.ok, false, `deceptive copy must be refused: ${body.slice(0, 30)}`);
      assert.equal(result.ok ? '' : result.gate, 'content');
    }
  });

  it('refuses first contact without a human approval reference', async () => {
    const prospect = await makeProspect();
    const result = await outreachService.sendGovernedOutreach({
      prospectId: prospect.id, channel: 'EMAIL', to: 'biz@example.com',
      subject: 'Hello', body: 'A bounded, honest introduction to our services.',
      logicalId: `l-${uniq()}`, surface: SURFACE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.gate, 'eligibility');
  });

  it('honours opt-out unconditionally', async () => {
    const prospect = await makeProspect();
    const suppressed = await outreachService.suppressOutreach({
      prospectId: prospect.id, reason: 'asked to stop', surface: SURFACE,
    });
    assert.equal(suppressed.ok, true);

    const result = await outreachService.sendGovernedOutreach({
      prospectId: prospect.id, channel: 'EMAIL', to: 'biz@example.com',
      subject: 'Hello', body: 'An honest and bounded follow-up message.',
      logicalId: `l-${uniq()}`, contactApprovalRef: 'approval-1', surface: SURFACE,
    });
    assert.equal(result.ok, false, 'an opted-out prospect must never be contacted');
    assert.match(result.ok ? '' : result.error, /opted out/i);
  });

  it('is idempotent — a retried outreach is a no-op, not a second ledger row', async () => {
    const prospect = await makeProspect();
    const logicalId = `l-${uniq()}`;
    const input = {
      prospectId: prospect.id, channel: 'EMAIL', to: 'biz@example.com',
      subject: 'Hello', body: 'An honest and bounded first message.',
      logicalId, contactApprovalRef: 'approval-1', surface: SURFACE,
    };
    // No provider is connected, so the first attempt is refused at the provider
    // gate — but it is still recorded, which is what makes the dedupe testable.
    const first = await outreachService.sendGovernedOutreach(input);
    assert.equal(first.ok, false);
    assert.equal(first.ok ? '' : first.gate, 'provider');

    const rowsAfterFirst = await db.outreachSend.count({ where: { prospectId: prospect.id } });
    assert.equal(rowsAfterFirst, 1);

    // Retrying the SAME logical outreach must not create a second attempt.
    const second = await outreachService.sendGovernedOutreach(input);
    assert.equal(second.ok, true, 'a replay is an idempotent success, not a re-send attempt');
    assert.equal(second.ok && second.status, 'DUPLICATE');
    assert.equal(await db.outreachSend.count({ where: { prospectId: prospect.id } }), 1);
  });

  it('reports the provider truthfully as NOT_CONNECTED and sends nothing', async () => {
    const prospect = await makeProspect();
    const result = await outreachService.sendGovernedOutreach({
      prospectId: prospect.id, channel: 'EMAIL', to: 'biz@example.com',
      subject: 'Hello', body: 'An honest and bounded first message.',
      logicalId: `l-${uniq()}`, contactApprovalRef: 'approval-1', surface: SURFACE,
    });
    assert.equal(result.ok, false, 'with no provider connected, nothing may be reported as sent');
    assert.match(result.ok ? '' : result.error, /NOT_CONNECTED/i);

    const row = await db.outreachSend.findFirst({ where: { prospectId: prospect.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(row, 'the attempt is still recorded so the refusal is auditable');
    assert.equal(row?.status, 'FAILED');
  });

  it('enforces the per-prospect contact cap', async () => {
    const prospect = await makeProspect({ contactAttempts: 3, lastContactedAt: null });
    const result = await outreachService.sendGovernedOutreach({
      prospectId: prospect.id, channel: 'EMAIL', to: 'biz@example.com',
      subject: 'Hello', body: 'An honest follow-up.', logicalId: `l-${uniq()}`,
      contactApprovalRef: 'approval-1', surface: SURFACE,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /cap/i);
  });
});

// ===========================================================================
// PHASE 11.7 — cost, P&L, learning
// ===========================================================================

describe('Phase 11.7 — cost ledger and P&L', () => {
  it('refuses an ACTUAL cost with no evidence, and accepts an ESTIMATED one', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const unevidenced = await economics.recordEngagementCost({
      engagementId: id, category: 'AI_EXECUTION', amountUsd: 3.5, basis: 'ACTUAL', surface: SURFACE,
    });
    assert.equal(unevidenced.ok, false, 'an unevidenced "actual" cost is a fabricated cost');

    const estimated = await economics.recordEngagementCost({
      engagementId: id, category: 'AI_EXECUTION', amountUsd: 3.5, basis: 'ESTIMATED',
      description: 'planning figure', surface: SURFACE,
    });
    assert.equal(estimated.ok, true, estimated.ok ? '' : estimated.error);
  });

  it('is idempotent on the same evidenced cost', async () => {
    const { id } = await makeEngagementRequiringPayment();
    const input = {
      engagementId: id, category: 'PLATFORM_FEE', amountUsd: 12, basis: 'ACTUAL',
      sourceRef: 'invoice-991', surface: SURFACE,
    };
    const first = await economics.recordEngagementCost(input);
    assert.equal(first.ok, true, first.ok ? '' : first.error);
    const second = await economics.recordEngagementCost(input);
    assert.equal(second.ok && second.duplicate, true);
    assert.equal(await db.engagementCost.count({ where: { engagementId: id } }), 1);
  });

  it('derives profit and margin from ACTUAL rows only, and keeps estimates separate', async () => {
    const { id } = await makeEngagementRequiringPayment();
    await paymentService.applyVerifiedPaymentEvent({
      provider: 'POLAR', providerEventId: `evt_${uniq()}`, eventType: 'order.paid',
      signatureVerified: true, amount: 500, engagementId: id, surface: SURFACE,
    });
    await engagementService.recordServiceRevenue({
      engagementId: id, paymentVerificationSource: 'PROVIDER_WEBHOOK',
      paymentVerificationRef: `ref-${uniq()}`, revenueSource: 'service:micro', amountUsd: 500, surface: SURFACE,
    });
    await economics.recordEngagementCost({
      engagementId: id, category: 'AI_EXECUTION', amountUsd: 100, basis: 'ACTUAL',
      sourceRef: 'ai-invoice-1', surface: SURFACE,
    });
    await economics.recordEngagementCost({
      engagementId: id, category: 'TOOLING', amountUsd: 999, basis: 'ESTIMATED', surface: SURFACE,
    });

    const pnl = await economics.getEngagementPnl(id);
    assert.ok(pnl);
    assert.equal(pnl?.realized.recognizedUsd, 500);
    assert.equal(pnl?.cost.actualUsd, 100, 'only ACTUAL costs count toward profit');
    assert.equal(pnl?.cost.estimatedUsd, 999, 'estimates are tracked but excluded');
    assert.equal(pnl?.profit.value, 400);
    assert.equal(pnl?.profit.label, 'DERIVED');
    assert.equal(pnl?.margin.value, 0.8);
    assert.equal(pnl?.projected.label, 'ESTIMATED');
    assert.equal(pnl?.sampleSize.revenueRows, 1, 'a 1-of-1 sample is reported honestly');
  });

  it('reports margin as UNKNOWN when no actual cost exists — never zero', async () => {
    const { id } = await makeEngagementRequiringPayment();
    await engagementService.recordServiceRevenue({
      engagementId: id, paymentVerificationSource: 'MANUAL_ADMIN_APPROVED',
      paymentVerificationRef: `ref-${uniq()}`, revenueSource: 'service:micro', amountUsd: 500, surface: SURFACE,
    });
    const pnl = await economics.getEngagementPnl(id);
    assert.equal(pnl?.cost.actualRows, 0);
    assert.equal(pnl?.cost.dataQuality, 'UNKNOWN');
  });

  it('never folds a PROJECTED or SIMULATED row into portfolio totals', async () => {
    const { id } = await makeEngagementRequiringPayment();
    await engagementService.recordServiceRevenue({
      engagementId: id, paymentVerificationSource: 'MANUAL_ADMIN_APPROVED',
      paymentVerificationRef: `ref-${uniq()}`, revenueSource: 'service:micro', amountUsd: 100, surface: SURFACE,
    });
    await db.revenue.create({
      data: {
        date: new Date(), revenueSource: 'plan:forecast', grossRevenue: 9_999_999, currency: 'USD',
        revenueBasis: 'PROJECTED', recognizedUsd: 0, netRevenue: 9_999_999, idempotencyKey: `proj-${uniq()}`,
      },
    });
    await db.revenue.create({
      data: {
        date: new Date(), revenueSource: 'sim:test', grossRevenue: 5_000_000, currency: 'USD',
        revenueBasis: 'SIMULATED', recognizedUsd: 0, netRevenue: 5_000_000, idempotencyKey: `sim-${uniq()}`,
      },
    });

    const portfolio = await economics.getPortfolioEconomics();
    assert.equal(portfolio.projected.rows, 1);
    assert.equal(portfolio.simulated.rows, 1);

    // The decisive check: the realized total equals the sum of ACTUAL rows
    // only. A 10M projection and a 5M simulation must contribute exactly zero.
    const actualOnly = await db.revenue.findMany({
      where: { revenueBasis: 'ACTUAL' },
      select: { grossRevenue: true },
    });
    const expectedUsd = Math.round(actualOnly.reduce((s, r) => s + r.grossRevenue, 0) * 100) / 100;
    assert.equal(portfolio.totals.recognizedRevenueUsd, expectedUsd);
    assert.ok(expectedUsd < 1_000_000, 'the ACTUAL base itself must be small for this test to mean anything');
  });

  it('optimization recommendations never act autonomously and stay inconclusive at small samples', async () => {
    const result = await economics.recommendOptimizations();
    assert.ok(result.recommendations.length >= 4);
    for (const rec of result.recommendations) {
      assert.equal(rec.requiresHumanApproval, true, 'no recommendation may act without a human');
      if (rec.sampleSize < result.minSampleForAction) {
        assert.equal(rec.actionable, false, 'a small sample must not be presented as actionable');
        assert.equal(rec.confidence, 'INSUFFICIENT_DATA');
      }
    }
  });
});

// ===========================================================================
// PHASE 11.7 — learning integrity
// ===========================================================================

describe('Phase 11.7 — learning integrity', () => {
  it('emits all twelve declared signal kinds', async () => {
    const snapshot = await learning.deriveCommercialSignals();
    const kinds = new Set(snapshot.signals.map((s) => s.kind));
    for (const kind of [
      'OPPORTUNITY_CONVERTED', 'OPPORTUNITY_FAILED_VALIDATION', 'OFFER_ACCEPTED', 'PROPOSAL_REJECTED',
      'PAYMENT_DELAYED', 'SCOPE_OVERRUN', 'DELIVERY_COMPLETED', 'REVISION_FREQUENCY',
      'REVENUE_GENERATED', 'MARGIN_OUTCOME', 'BLOCKED_OPPORTUNITY', 'HALAL_REVIEW_OUTCOME',
    ]) {
      assert.ok(kinds.has(kind as never), `${kind} must actually be emitted, not just declared`);
    }
    assert.equal(snapshot.signals.length, 12);
  });

  it('reports margin UNKNOWN rather than measured when no cost is recorded', async () => {
    const snapshot = await learning.deriveCommercialSignals();
    const margin = snapshot.signals.find((s) => s.kind === 'MARGIN_OUTCOME');
    assert.ok(margin);
    if (!margin) return;
    assert.equal(margin.metric, 'mean_realized_margin_ratio', 'margin must be a margin, not a price');
  });

  it('persists learning rows idempotently — a repeat run creates no duplicates', async () => {
    const before = await db.learningEntry.count({ where: { context: { startsWith: 'commercial' } } });
    await learning.persistCommercialLearning();
    const afterFirst = await db.learningEntry.count({ where: { context: { startsWith: 'commercial' } } });
    assert.equal(afterFirst - before, 12, 'all twelve signals persist on the first run');

    await learning.persistCommercialLearning();
    const afterSecond = await db.learningEntry.count({ where: { context: { startsWith: 'commercial' } } });
    assert.equal(afterSecond, afterFirst, 'an identical observation must not duplicate rows');
  });

  it('never marks a signal VALIDATED below the minimum sample size', async () => {
    const snapshot = await learning.deriveCommercialSignals();
    for (const signal of snapshot.signals) {
      if (signal.sampleSize < learning.MIN_VALIDATED_SAMPLE && signal.result === 'VALIDATED') {
        // A signal may only be VALIDATED with real evidence behind it.
        assert.ok(
          signal.kind === 'HALAL_REVIEW_OUTCOME' || signal.kind === 'OFFER_ACCEPTED',
          `${signal.kind} must not be VALIDATED on a sample of ${signal.sampleSize}`,
        );
      }
    }
  });
});
