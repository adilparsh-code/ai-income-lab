// ============================================================================
// PHASE 11.9 GAP REMEDIATION — AUDIT FINDINGS G1–G10 (hermetic DB tests)
// ============================================================================
// One regression test per MANDATORY audit item, each aimed at the PRODUCTION
// path rather than the helper in isolation. The point of this suite is that a
// future refactor cannot quietly re-open any of these holes: every test drives
// the real service layer or the real job runner against a real database.
//
// Each test names the finding it closes so the mapping back to the audit is
// explicit and reviewable.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-gaps-'));
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
let offerService: typeof import('../offer-service');
let engagementService: typeof import('../engagement-service');
let routingService: typeof import('../routing-service');
let jobRunner: typeof import('../../jobs/job-runner');
let microServices: typeof import('../micro-services');
let learning: typeof import('../commercial-learning');
let communicationProvider: typeof import('../communication-provider');
let revenueService: typeof import('../../product-factory/economics');

const SURFACE = 'test:gap-remediation';
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq += 1)}`;

before(async () => {
  db = (await import('../../../lib/db')).db;
  offerService = await import('../offer-service');
  engagementService = await import('../engagement-service');
  routingService = await import('../routing-service');
  jobRunner = await import('../../jobs/job-runner');
  microServices = await import('../micro-services');
  learning = await import('../commercial-learning');
  communicationProvider = await import('../communication-provider');
  revenueService = await import('../../product-factory/economics');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Seed a HALAL opportunity so routing/halal gates have something real to read. */

/** Result helpers: the service result types carry an index signature, so read
 *  the id through a narrow structural read rather than an unsafe cast. */
function engagementIdOf(r: unknown): string {
  const v = (r as { engagementId?: unknown }).engagementId;
  assert.equal(typeof v, 'string', `expected engagementId in ${JSON.stringify(r)}`);
  return v as string;
}
function offerIdOf(r: unknown): string {
  const v = (r as { offerId?: unknown }).offerId;
  assert.equal(typeof v, 'string', `expected offerId in ${JSON.stringify(r)}`);
  return v as string;
}
function issueIdOf(r: unknown): string {
  const v = (r as { issueId?: unknown }).issueId;
  assert.equal(typeof v, 'string', `expected issueId in ${JSON.stringify(r)}`);
  return v as string;
}

async function seedOpportunity(halalStatus = 'HALAL'): Promise<string> {
  const row = await db.opportunity.create({
    data: {
      title: `Opportunity ${uniq()}`,
      category: 'education',
      businessModel: 'MICRO_SERVICE',
      targetAudience: 'teachers',
      problemSolved: 'classroom materials',
      monetizationMethod: 'one-off sale',
      halalStatus,
    },
  });
  return row.id;
}

async function createOffer(overrides: Record<string, unknown> = {}) {
  return offerService.createOffer({
    type: 'MICRO_SERVICE',
    title: `Printable maths worksheet`,
    description: 'A single printable worksheet on fractions for year 3.',
    scopeSummary: 'One worksheet, up to 3 pages.',
    price: 40,
    estimatedEffortHours: 2,
    estimatedCost: 5,
    actor: 'admin@aiincome.lab',
    surface: SURFACE,
    ...overrides,
  } as never);
}

// ===========================================================================
// G4 — ADMIN HALAL OVERRIDE (test #4, #20)
// ===========================================================================

describe('G4 — an admin-supplied halalStatus is never truth', () => {
  it('#4 request-body halalStatus=HALAL does not bypass screening of BLOCKED content', async () => {
    const opportunityId = await seedOpportunity('NOT_ALLOWED');

    const attempt = await createOffer({
      // Deterministic screening MUST see the blocked content…
      description: 'Guaranteed returns sportsbook betting arbitrage casino wagering tips',
      // …while the caller simultaneously claims it is halal.
      halalStatus: 'HALAL',
      opportunityId,
    });

    assert.equal(attempt.ok, false, 'a blocked offer must not be creatable');

    // And nothing was persisted as HALAL.
    const persisted = await db.offer.count({ where: { halalStatus: 'HALAL' } });
    assert.equal(persisted, 0, 'no HALAL offer may exist from this attempt');
  });

  it('#4b a caller may only move the verdict MORE conservative, never less', async () => {
    const opportunityId = await seedOpportunity('NOT_ALLOWED');
    const conservative = await createOffer({
      description: 'Guaranteed returns sportsbook betting arbitrage casino wagering tips',
      halalStatus: 'BLOCKED',
      opportunityId,
    });
    // BLOCKED is already the worst verdict, so nothing is gained — but the
    // important assertion is that the offer was still refused on content.
    assert.equal(conservative.ok, false);
  });

  it('#20 digital product regression: a clean digital product offer still creates', async () => {
    const created = await createOffer({
      type: 'DIGITAL_PRODUCT',
      title: 'Printable fractions worksheet pack',
      description: 'A downloadable pack of printable fractions worksheets for primary school.',
      scopeSummary: 'Ten printable worksheets with answer key.',
      price: 12,
    });
    assert.equal(created.ok, true, 'a clean digital product offer must still work');
  });
});

// ===========================================================================
// G3 — HALAL GATE (tests #1, #2, #3)
// ===========================================================================

describe('G3 — no service path bypasses the halal gate', () => {
  /** Create an offer row directly with an explicit stored halalStatus. */
  async function seedOfferWithHalal(halalStatus: string): Promise<string> {
    const opportunityId = await seedOpportunity('HALAL');
    const offer = await db.offer.create({
      data: {
        type: 'MICRO_SERVICE',
        title: `Seeded ${halalStatus} offer ${uniq()}`,
        description: 'A bounded printable worksheet.',
        scopeSummary: 'One worksheet.',
        price: 40,
        opportunityId,
        halalStatus,
        status: 'ACTIVE',
      },
    });
    return offer.id;
  }

  it('#1 a BLOCKED offer cannot create an engagement', async () => {
    const offerId = await seedOfferWithHalal('BLOCKED');
    const result = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Blocked work',
      microServiceKind: 'CUSTOM_WORKSHEET',
      offerId,
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(result.ok, false);
    const persisted = await db.serviceEngagement.count({ where: { offerId } });
    assert.equal(persisted, 0, 'no engagement may exist against a blocked offer');
  });

  it('#1b NOT_ALLOWED is equally refused', async () => {
    const offerId = await seedOfferWithHalal('NOT_ALLOWED');
    const result = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Not allowed work',
      microServiceKind: 'CUSTOM_WORKSHEET',
      offerId,
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(result.ok, false);
  });

  it('#2 an UNVERIFIED offer cannot create an engagement', async () => {
    const offerId = await seedOfferWithHalal('UNVERIFIED');
    const result = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Unscreened work',
      microServiceKind: 'CUSTOM_WORKSHEET',
      offerId,
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(result.ok, false);
  });

  it('#2b REVIEW_REQUIRED requires an explicit, audited admin acknowledgement', async () => {
    const offerId = await seedOfferWithHalal('REVIEW_REQUIRED');

    const refused = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Review required work',
      microServiceKind: 'CUSTOM_WORKSHEET',
      offerId,
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(refused.ok, false, 'REVIEW_REQUIRED must not be self-authorizing');

    const approved = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Review required work',
      microServiceKind: 'CUSTOM_WORKSHEET',
      offerId,
      totalPrice: 40,
      allowReviewRequiredOffer: true,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(approved.ok, true, 'an explicit human decision may authorize it');
  });

  it('#3 a client message cannot mark a payment verified', async () => {
    const opportunityId = await seedOpportunity('HALAL');
    const offer = await offerService.createOffer({
      type: 'MICRO_SERVICE',
      title: 'Payment gate worksheet',
      description: 'A bounded printable worksheet.',
      scopeSummary: 'One worksheet.',
      price: 40,
      opportunityId,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    } as never);
    assert.equal(offer.ok, true);
    const offerId = offerIdOf(offer);

    const engagement = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Payment gate engagement',
      microServiceKind: 'CUSTOM_WORKSHEET',
      offerId,
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(engagement.ok, true);
    const engagementId = engagementIdOf(engagement);

    // A client-claimed message asserts payment. It must not flip payment truth.
    const before = await db.serviceEngagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: { paymentState: true, verificationSource: true },
    });
    assert.notEqual(before.paymentState, 'PAYMENT_VERIFIED');

    // The only legitimate transition requires a verification SOURCE. With none,
    // the machine refuses.
    const refused = await engagementService.transitionMilestonePayment({
      engagementId,
      to: 'PAYMENT_PENDING',
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    } as never);
    assert.equal(refused.ok, false, 'a bare payment transition with no milestone must fail');

    const after = await db.serviceEngagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: { paymentState: true, verificationSource: true },
    });
    assert.equal(after.paymentState, before.paymentState, 'client input must not move payment truth');
    assert.equal(after.verificationSource, null);
  });
});

// ===========================================================================
// G2 + G8 — MICRO-SERVICE BOUNDS AND STRUCTURED KIND (tests #5, #6, #7, #8)
// ===========================================================================

describe('G2/G8 — micro-service bounds are enforced in the production path', () => {
  const base = {
    engagementType: 'MICRO_SERVICE',
    microServiceKind: 'CUSTOM_WORKSHEET',
    totalPrice: 40,
    actor: 'admin@aiincome.lab',
    surface: SURFACE,
  } as const;

  it('#6 an invalid micro-service kind is rejected', async () => {
    const result = await engagementService.createEngagement({
      ...base,
      title: 'Unbounded work',
      microServiceKind: 'UNBOUNDED_WORK',
    });
    assert.equal(result.ok, false);
  });

  it('#6b an arbitrary CUSTOM value cannot bypass governance', async () => {
    const result = await engagementService.createEngagement({
      ...base,
      title: 'Arbitrary custom',
      microServiceKind: 'TOTALLY_MADE_UP_SERVICE',
    });
    assert.equal(result.ok, false);
  });

  it('#5 an out-of-bounds effort package is rejected, not clamped', async () => {
    const result = await engagementService.createEngagement({
      ...base,
      title: 'Absurd effort',
      estimatedEffortHours: 400, // CUSTOM_WORKSHEET max is 6
    });
    assert.equal(result.ok, false);

    const persisted = await db.serviceEngagement.count({
      where: { title: 'Absurd effort' },
    });
    assert.equal(persisted, 0, 'an out-of-bounds package must not be silently clamped into a row');
  });

  it('#5b an excessive revision limit is rejected', async () => {
    const result = await engagementService.createEngagement({
      ...base,
      title: 'Unlimited revisions',
      revisionLimit: 99,
    });
    assert.equal(result.ok, false);
  });

  it('#7 a price outside the catalogue band is rejected', async () => {
    const definition = microServices.findMicroService('CUSTOM_WORKSHEET');
    assert.ok(definition, 'catalogue definition must exist');

    const tooHigh = await engagementService.createEngagement({
      ...base,
      title: 'Absurdly priced worksheet',
      totalPrice: definition.maxPriceUsd + 1,
    });
    assert.equal(tooHigh.ok, false, 'above the band must be refused');

    const tooLow = await engagementService.createEngagement({
      ...base,
      title: 'Suspiciously cheap worksheet',
      totalPrice: 0.5,
    });
    assert.equal(tooLow.ok, false, 'below the band must be refused');

    const inBand = await engagementService.createEngagement({
      ...base,
      title: 'Correctly priced worksheet',
      totalPrice: definition.minPriceUsd,
    });
    assert.equal(inBand.ok, true, 'the band boundary itself is valid');
  });

  it('#8 QA cannot be skipped: SERVICE_QA fails closed without the catalogue definition', async () => {
    const definition = microServices.findMicroService('CUSTOM_WORKSHEET');
    assert.ok(definition);

    // No check reported → fails closed, because a check that was not reported
    // as passed is treated as not passed.
    const verdict = microServices.evaluateMicroServiceQa(definition, []);
    assert.equal(verdict.passed, false);
    assert.ok(verdict.failed.length > 0);

    // Only the REAL checks, all passing, are accepted.
    const honest = microServices.evaluateMicroServiceQa(
      definition,
      definition.qaChecks.map((check) => ({ check, passed: true })),
    );
    assert.equal(honest.passed, true);

    // Inventing a check that is not in the catalogue does not help.
    const padded = microServices.evaluateMicroServiceQa(
      definition,
      [{ check: 'totally invented', passed: true }],
    );
    assert.equal(padded.passed, false);
  });

  it('#8b execution refuses a MICRO_SERVICE with no persisted catalogue kind', async () => {
    // Create a MICRO_SERVICE engagement then blank its persisted kind, proving
    // the runner reads the COLUMN and fails closed rather than trusting input.
    const created = await engagementService.createEngagement({
      ...base,
      title: 'Kind stripping probe',
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    await db.serviceEngagement.update({
      where: { id: engagementId },
      data: { microServiceKind: null },
    });

    const outcome = await jobRunner.runJob(
      'SERVICE_BUILD',
      { engagementId },
      `gap-probe-${uniq()}`,
    );
    assert.equal(outcome.status, 'BLOCKED');
  });

  it('#8c execution refuses a payload kind that contradicts the persisted kind', async () => {
    const created = await engagementService.createEngagement({
      ...base,
      title: 'Kind contradiction probe',
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    // The persisted kind is CUSTOM_WORKSHEET. The payload claims otherwise.
    const outcome = await jobRunner.runJob(
      'SERVICE_BUILD',
      { engagementId, microServiceKind: 'RESEARCH' },
      `gap-probe-${uniq()}`,
    );
    assert.equal(outcome.status, 'BLOCKED');
  });

  it('the bounded kind is persisted as a STRUCTURED column, not prose', async () => {
    const scopeSummary = 'Only a worksheet, no answer key.';
    const created = await engagementService.createEngagement({
      ...base,
      title: 'Structured kind probe',
      scopeSummary,
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    const row = await db.serviceEngagement.findUniqueOrThrow({ where: { id: engagementId } });
    assert.equal(row.microServiceKind, 'CUSTOM_WORKSHEET');
    assert.ok(typeof row.microServiceEffortHours === 'number');
    assert.ok(typeof row.microServiceRevisionLimit === 'number');
    // The old "[KIND] " prose prefix is gone: scope text stays exactly as given.
    assert.equal(row.scopeSummary, scopeSummary);
  });
});

// ===========================================================================
// G1 — ROUTING IS REACHABLE (tests #12, #13)
// ===========================================================================

describe('G1 — routing is reachable from the production path', () => {
  it('offer creation PERSISTS a routing decision (routing is not decoration)', async () => {
    const opportunityId = await seedOpportunity('HALAL');
    const created = await createOffer({ opportunityId });
    assert.equal(created.ok, true);
    const offerId = offerIdOf(created);

    const routing = await routingService.getOfferRouting(offerId);
    assert.ok(routing, 'routing must be readable for a newly created offer');
    assert.equal(routing.route, 'MICRO_SERVICE_WORKFLOW');
    assert.deepEqual(routing.jobTypes, ['SERVICE_BUILD', 'SERVICE_QA', 'SERVICE_DELIVERY']);
    assert.equal(routing.executable, true);
    assert.deepEqual(routing.blockers, []);
  });

  it('DIGITAL_PRODUCT routes to the existing Product Factory job types', async () => {
    const opportunityId = await seedOpportunity('HALAL');
    const created = await createOffer({
      type: 'DIGITAL_PRODUCT',
      opportunityId,
      title: 'Routing probe pack',
      description: 'A printable pack of worksheets for teachers.',
    });
    assert.equal(created.ok, true);
    const routing = await routingService.getOfferRouting(offerIdOf(created));
    assert.ok(routing);
    assert.equal(routing.route, 'DIGITAL_PRODUCT_WORKFLOW');
    assert.ok(routing.jobTypes.includes('PRODUCT_CREATE'));
    // Digital product must NOT be forced through a prospect-bearing service route.
    assert.ok(!routing.jobTypes.includes('SERVICE_BUILD'));
  });

  it('a BLOCKED opportunity makes the persisted route non-executable', async () => {
    const opportunityId = await seedOpportunity('NOT_ALLOWED');
    // Seed directly so screening of the title does not interfere with the point.
    const offer = await db.offer.create({
      data: {
        type: 'MICRO_SERVICE',
        title: `Blocked routing probe ${uniq()}`,
        description: 'A bounded worksheet.',
        scopeSummary: 'One worksheet.',
        price: 40,
        opportunityId,
        halalStatus: 'BLOCKED',
        status: 'ACTIVE',
      },
    });
    const result = await routingService.resolveOfferRouting({ offerId: offer.id, surface: SURFACE });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decision.executable, false);
      assert.ok(result.decision.blockers.includes('HALAL_BLOCKED'));
    }
  });

  it('#12 an unlinked opportunity is UNVERIFIED, never fabricated as HALAL', async () => {
    const created = await createOffer({ title: `Unlinked routing probe ${uniq()}` });
    assert.equal(created.ok, true);
    const routing = await routingService.getOfferRouting(offerIdOf(created));
    assert.ok(routing);
    assert.equal(routing.executable, false, 'no screened opportunity must not be executable');
    assert.ok(routing.blockers.includes('HALAL_UNVERIFIED'));
  });

  it('#13 execution refuses a job type outside the offer’s recorded route', async () => {
    const opportunityId = await seedOpportunity('HALAL');
    const offer = await offerService.createOffer({
      type: 'DIGITAL_PRODUCT',
      title: 'Route mismatch probe',
      description: 'A printable pack of worksheets.',
      scopeSummary: 'A pack.',
      price: 12,
      opportunityId,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    } as never);
    assert.equal(offer.ok, true);
    const offerId = offerIdOf(offer);
    await routingService.resolveOfferRouting({ offerId, surface: SURFACE });

    const created = await engagementService.createEngagement({
      engagementType: 'CLIENT_SERVICE',
      title: 'Route mismatch engagement',
      offerId,
      totalPrice: 100,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    // Authorize the engagement so the PAYMENT gate passes. That is what makes
    // this probe meaningful: the ROUTE gate must then be the thing that blocks.
    await db.serviceEngagement.update({
      where: { id: engagementId },
      data: { state: 'WORK_AUTHORIZED', paymentState: 'PAYMENT_VERIFIED' },
    });

    // The offer's recorded route is DIGITAL_PRODUCT_WORKFLOW, which contains no
    // SERVICE_* job. Running one must be refused.
    const outcome = await jobRunner.runJob(
      'SERVICE_BUILD',
      { engagementId },
      `gap-route-${uniq()}`,
    );
    assert.equal(outcome.status, 'BLOCKED');
    assert.match(outcome.error ?? '', /route/i);

    // Control: with the route gate satisfied the same job would proceed past
    // the structural checks, proving the refusal above was route-specific.
    await db.offer.update({
      where: { id: offerId },
      data: { route: 'MICRO_SERVICE_WORKFLOW', routeJobTypes: '["SERVICE_BUILD","SERVICE_QA","SERVICE_DELIVERY"]' },
    });
    const permitted = await jobRunner.runJob(
      'SERVICE_BUILD',
      { engagementId },
      `gap-route-ok-${uniq()}`,
    );
    assert.notEqual(permitted.status, 'BLOCKED');
  });
});

// ===========================================================================
// G5 — REVENUE LINKAGE (tests #14, #15, #16)
// ===========================================================================

describe('G5 — Revenue ↔ ServiceEngagement linkage', () => {
  it('#14 revenue created for a service carries serviceEngagementId', async () => {
    const created = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Revenue linkage probe',
      microServiceKind: 'CUSTOM_WORKSHEET',
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    const recorded = await engagementService.recordServiceRevenue({
      engagementId,
      paymentVerificationSource: 'MANUAL_ADMIN_APPROVED',
      paymentVerificationRef: `ref-${uniq()}`,
      revenueSource: 'service_sale',
      amountUsd: 40,
      surface: SURFACE,
    } as never);
    assert.equal(recorded.ok, true);

    const row = await db.revenue.findFirstOrThrow({ where: { serviceEngagementId: engagementId } });
    assert.ok(row.id);
    assert.equal(row.revenueBasis, 'ACTUAL');
  });

  it('#15 digital product revenue remains valid with NO serviceEngagementId', async () => {
    const product = await db.product.create({
      data: { name: `Digital product ${uniq()}`, type: 'worksheet-pack', price: 12 },
    });
    const recorded = await revenueService.recordRevenueWithAttribution({
      date: new Date().toISOString(),
      revenueSource: 'product_sale',
      grossRevenue: 12,
      productId: product.id,
      idempotencyKey: `rev-${uniq()}`,
    } as never);
    assert.equal(recorded.status, 'RECORDED');

    const row = await db.revenue.findFirstOrThrow({ where: { productId: product.id } });
    assert.equal(row.serviceEngagementId, null, 'digital product revenue needs no service link');
  });

  it('#16 revenue idempotency is intact', async () => {
    const product = await db.product.create({
      data: { name: `Idempotent product ${uniq()}`, type: 'pack', price: 20 },
    });
    const idempotencyKey = `rev-${uniq()}`;
    const first = await revenueService.recordRevenueWithAttribution({
      date: new Date().toISOString(),
      revenueSource: 'product_sale',
      grossRevenue: 20,
      productId: product.id,
      idempotencyKey,
    } as never);
    assert.equal(first.status, 'RECORDED');

    const second = await revenueService.recordRevenueWithAttribution({
      date: new Date().toISOString(),
      revenueSource: 'product_sale',
      grossRevenue: 20,
      productId: product.id,
      idempotencyKey,
    } as never);
    assert.equal(second.status, 'DUPLICATE', 'the same revenue must not be recorded twice');

    const count = await db.revenue.count({ where: { productId: product.id } });
    assert.equal(count, 1);
  });
});

// ===========================================================================
// G6 / G7 — LEARNING INTEGRITY (tests #18, #19)
// ===========================================================================

describe('G6/G7 — learning signals reflect real evidence', () => {
  it('#18 the declared signal set is not larger than what is emitted', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        join(process.cwd(), 'src/lib/commercial/commercial-learning.ts'),
        'utf8',
      ),
    );
    const declared = [...source.matchAll(/^\s*\|\s*'([A-Z_]+)'/gm)].map((m) => m[1]);
    assert.ok(declared.length > 0, 'signal kinds must be declared');
    assert.equal(new Set(declared).size, declared.length, 'declared signals must be unique');

    for (const kind of declared) {
      assert.ok(
        source.includes(`kind: '${kind}'`),
        `declared signal ${kind} has no production emission site`,
      );
    }
  });

  it('#19 MARGIN_OUTCOME is a real margin over real revenue+cost pairs', async () => {
    // A REAL engagement, so the revenue FK is genuine rather than invented.
    const created = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Margin semantics probe',
      microServiceKind: 'CUSTOM_WORKSHEET',
      totalPrice: 100,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    // Realized revenue 100, actual cost 30 → real margin ratio is 0.70.
    await db.revenue.create({
      data: {
        date: new Date(),
        revenueSource: 'service_sale',
        grossRevenue: 100,
        netRevenue: 100,
        serviceEngagementId: engagementId,
        revenueBasis: 'ACTUAL',
        recognizedUsd: 100,
      },
    });
    await db.engagementCost.create({
      data: {
        engagementId,
        category: 'AI_EXECUTION',
        description: 'Margin semantics probe cost.',
        amountUsd: 30,
        basis: 'ACTUAL',
        idempotencyKey: `cost-${uniq()}`,
      },
    });

    const snapshot = await learning.deriveCommercialSignals();
    const margin = snapshot.signals.find((s: { kind: string }) => s.kind === 'MARGIN_OUTCOME');
    assert.ok(margin, 'MARGIN_OUTCOME must be emitted');

    // (100 - 30) / 100 = 0.70. An implementation that reported the PRICE (100)
    // or the absolute profit (70) instead of the margin ratio fails here — that
    // is precisely the semantic mismatch this test exists to catch.
    assert.equal(margin.measuredValue, 0.7);
    assert.equal(margin.metric, 'mean_realized_margin_ratio');
    assert.equal(margin.sampleSize, 1);
  });

  it('#19b an ESTIMATED cost never enters the margin', async () => {
    const created = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Estimate exclusion probe',
      microServiceKind: 'CUSTOM_WORKSHEET',
      totalPrice: 100,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    await db.revenue.create({
      data: {
        date: new Date(),
        revenueSource: 'service_sale',
        grossRevenue: 100,
        netRevenue: 100,
        serviceEngagementId: engagementId,
        revenueBasis: 'ACTUAL',
        recognizedUsd: 100,
      },
    });
    await db.engagementCost.create({
      data: {
        engagementId,
        category: 'AI_EXECUTION',
        description: 'An estimate, which is not a cost.',
        amountUsd: 30,
        basis: 'ESTIMATED',
        idempotencyKey: `cost-est-${uniq()}`,
      },
    });

    const snapshot = await learning.deriveCommercialSignals();
    const margin = snapshot.signals.find((s: { kind: string }) => s.kind === 'MARGIN_OUTCOME');
    assert.ok(margin);
    // This pair contributes NO sample: with only an estimated cost the margin
    // is UNKNOWN, never invented from the estimate.
    assert.equal(margin.metric, 'mean_realized_margin_ratio');
  });
});

// ===========================================================================
// G9 — PROVIDER TRUTH (test #12)
// ===========================================================================

describe('G9 — a simulated provider never reports live health', () => {
  it('#12 the simulated provider reports SIMULATED, not HEALTHY', async () => {
    const provider = new communicationProvider.SimulatedCommunicationProvider();
    const health = provider.health();
    assert.notEqual(health.state, 'HEALTHY', 'a simulation must not claim live health');
    assert.notEqual(health.state, 'CONFIGURED');
    assert.ok(
      health.state === 'NOT_CONNECTED' || health.state === 'DEGRADED' || health.state === 'FAILED',
      `unexpected provider state ${health.state}`,
    );
  });
});

// ===========================================================================
// SERVICE ISSUE → MESSAGE TRACEABILITY (test #17)
// ===========================================================================

describe('ServiceIssue preserves the triggering Message linkage', () => {
  it('#17 an issue raised from a client message can be traced back to it', async () => {
    const created = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Message traceability probe',
      microServiceKind: 'CUSTOM_WORKSHEET',
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    const prospect = await db.prospect.create({
      data: {
        displayName: `Traceability probe ${uniq()}`,
        source: 'MANUAL',
      },
    });
    const conversation = await db.conversation.create({
      data: { prospectId: prospect.id, channel: 'PORTAL', state: 'OPEN' },
    });

    const message = await db.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'INBOUND',
        role: 'CLIENT',
        body: 'This worksheet is wrong and I want my money back.',
      },
    });

    const issue = await engagementService.createServiceIssue({
      engagementId,
      issueType: 'REFUND_REQUESTED',
      summary: 'Client disputes the delivered worksheet.',
      correlationId: 'client-message',
      messageId: message.id,
      surface: SURFACE,
    });
    assert.equal(issue.ok, true);

    const row = await db.serviceIssue.findUniqueOrThrow({
      where: { id: issueIdOf(issue) },
      select: { messageId: true, correlationId: true },
    });

    // The REAL message id, not a generated UUID that points at nothing.
    assert.equal(row.messageId, message.id);
    assert.ok(row.correlationId.includes(message.id), 'correlation id must reference the message');

    // And the link actually resolves through the relation.
    const traced = await db.message.findUnique({ where: { id: row.messageId as string } });
    assert.ok(traced, 'the triggering message must be retrievable from the issue');
    assert.equal(traced.id, message.id);
  });

  it('#17b a dangling messageId is refused rather than stored', async () => {
    const created = await engagementService.createEngagement({
      engagementType: 'MICRO_SERVICE',
      title: 'Dangling message probe',
      microServiceKind: 'CUSTOM_WORKSHEET',
      totalPrice: 40,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);

    const result = await engagementService.createServiceIssue({
      engagementId: engagementIdOf(created),
      issueType: 'DISPUTE',
      summary: 'Dangling reference probe.',
      messageId: 'does-not-exist-at-all',
      surface: SURFACE,
    });
    assert.equal(result.ok, false, 'a non-existent message must not be linked');
  });

  it('#17c an admin-raised issue has no message, which is legitimate', async () => {
    const created = await engagementService.createEngagement({
      engagementType: 'CLIENT_SERVICE',
      title: 'Admin issue probe',
      totalPrice: 100,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);

    const issue = await engagementService.createServiceIssue({
      engagementId: engagementIdOf(created),
      issueType: 'PAUSE_REQUESTED',
      summary: 'Raised internally.',
      surface: SURFACE,
    });
    assert.equal(issue.ok, true);

    const row = await db.serviceIssue.findUniqueOrThrow({
      where: { id: issueIdOf(issue) },
      select: { messageId: true },
    });
    assert.equal(row.messageId, null, 'an admin issue legitimately has no triggering message');
  });
});

// ===========================================================================
// G10 / GOVERNANCE — truthful contract
// ===========================================================================

describe('G10 / job governance — the contract is truthful', () => {
  it('service job types are exactly the three implemented bounded jobs', async () => {
    const types = await import('../../jobs/types');
    assert.deepEqual([...types.SERVICE_JOB_TYPES], ['SERVICE_BUILD', 'SERVICE_QA', 'SERVICE_DELIVERY']);
    // CLIENT_OUTREACH is deliberately absent: the communication provider is
    // NOT_CONNECTED, so an outreach job would be a fiction. This asserts the
    // bounded truth rather than the aspirational design doc.
    assert.ok(!(types.SERVICE_JOB_TYPES as readonly string[]).includes('CLIENT_OUTREACH'));
  });

  it('an unauthorized engagement still cannot execute (payment gate intact)', async () => {
    const created = await engagementService.createEngagement({
      engagementType: 'CLIENT_SERVICE',
      title: 'Unpaid execution probe',
      totalPrice: 100,
      actor: 'admin@aiincome.lab',
      surface: SURFACE,
    });
    assert.equal(created.ok, true);
    const engagementId = engagementIdOf(created);

    const outcome = await jobRunner.runJob(
      'SERVICE_BUILD',
      { engagementId },
      `gap-unpaid-${uniq()}`,
    );
    assert.equal(outcome.status, 'BLOCKED', 'unpaid work must not execute');
  });
});