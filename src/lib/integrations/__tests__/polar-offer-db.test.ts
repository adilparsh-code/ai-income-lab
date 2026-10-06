// ============================================================================
// POLAR FIRST-SALE — focused tests for the Offer → Polar → webhook → Revenue
// chain added for the human-gated publication bridge + offer webhook mapping.
//
// STEP 9 matrix covered here (route-level signature verdicts for
// invalid/missing/malformed also appear in security/webhook-boundary.test.ts
// and integrations/webhook-verification.test.ts, which this file extends with
// full signed-route E2E):
//   config valid/invalid · human approval required · inactive offer rejected ·
//   non-halal rejected · zero price rejected · successful publish path ·
//   missing/bad signature rejected · malformed signed webhook ignored ·
//   valid signed webhook accepted · duplicate idempotent · unknown event/
//   product/offer rejected · revenue created exactly once.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTestDatabase } from '@/test-utils/install-test-database';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-polar-offer-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

// Credentials for tests are FAKE local values, never real secrets.
const FAKE_POLAR_TOKEN = 'polar_test_token_abcdef1234567890';
const FAKE_WEBHOOK_SECRET = 'whsec_test_secret_do_not_use_in_prod';
const SAVED: Record<string, string | undefined> = {
  POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN,
  POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
};
delete process.env.POLAR_ACCESS_TOKEN;
delete process.env.POLAR_WEBHOOK_SECRET;

before(() => {
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const importDb = () => import('@/lib/db');

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface SeedOptions {
  offerStatus?: string;
  halalStatus?: string;
  price?: number;
  title?: string;
  description?: string;
  scopeSummary?: string;
  linkProduct?: boolean;
}

async function seedOffer(options: SeedOptions = {}) {
  const { db } = await importDb();
  const opportunity = await db.opportunity.create({
    data: {
      title: `Polar offer opp ${Math.random().toString(36).slice(2, 8)}`,
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'testers',
      problemSolved: 'testing',
      monetizationMethod: 'ONE_TIME_PURCHASE',
      status: 'VALIDATED',
      halalStatus: 'HALAL',
    },
  });
  const product = await db.product.create({
    data: {
      name: options.title ?? 'Polar Offer Product',
      type: 'DIGITAL_PRODUCT',
      opportunityId: opportunity.id,
      status: 'READY',
      price: options.price ?? 29,
    },
  });
  const offer = await db.offer.create({
    data: {
      type: 'DIGITAL_PRODUCT',
      title: options.title ?? 'Polar Offer Product',
      description: options.description ?? 'A complete planner kit delivered as a download.',
      scopeSummary: options.scopeSummary ?? 'One-time template download with one update.',
      price: options.price ?? 29,
      currency: 'USD',
      status: options.offerStatus ?? 'ACTIVE',
      halalStatus: options.halalStatus ?? 'HALAL',
      riskState: 'LOW_RISK',
      opportunityId: opportunity.id,
      ...(options.linkProduct === false ? {} : { productId: product.id }),
    },
  });
  return { opportunityId: opportunity.id, productId: product.id, offerId: offer.id };
}

// ---------------------------------------------------------------------------
// STEP 4 gates (pure): ACTIVE · HALAL · price · screening · product · delivery
// ---------------------------------------------------------------------------

describe('offer publication gates (fail-closed, pure)', () => {
  const base = {
    id: 'off_gate_1',
    type: 'DIGITAL_PRODUCT',
    title: 'Focus Planner Kit',
    description: 'A downloadable planner for weekly execution.',
    scopeSummary: 'Instant download.',
    price: 29,
    currency: 'USD',
    status: 'ACTIVE',
    halalStatus: 'HALAL',
    productId: 'prod_gate_1',
    product: { name: 'Focus Planner Kit', platform: '', productUrl: '' },
  };

  it('allows a clean ACTIVE + HALAL + priced offer with product and delivery info', async () => {
    const { evaluateOfferPublication } = await import('../offer-publishing');
    const result = evaluateOfferPublication(base);
    assert.deepEqual(result, { ok: true, errors: [] });
  });

  it('rejects an offer that is not ACTIVE', async () => {
    const { evaluateOfferPublication } = await import('../offer-publishing');
    for (const status of ['DRAFT', 'REVIEW_REQUIRED', 'RETIRED', 'BLOCKED']) {
      const result = evaluateOfferPublication({ ...base, status });
      assert.equal(result.ok, false, `status ${status} must be refused`);
      assert.ok(result.errors.some((e) => e.includes('ACTIVE')));
    }
  });

  it('rejects non-HALAL offers (UNVERIFIED / REVIEW_REQUIRED / BLOCKED)', async () => {
    const { evaluateOfferPublication } = await import('../offer-publishing');
    for (const halalStatus of ['UNVERIFIED', 'REVIEW_REQUIRED', 'BLOCKED']) {
      const result = evaluateOfferPublication({ ...base, halalStatus });
      assert.equal(result.ok, false, `halalStatus ${halalStatus} must be refused`);
      assert.ok(result.errors.some((e) => e.includes('Halal status')));
    }
  });

  it('rejects zero or negative price', async () => {
    const { evaluateOfferPublication } = await import('../offer-publishing');
    for (const price of [0, -1]) {
      const result = evaluateOfferPublication({ ...base, price });
      assert.equal(result.ok, false, `price ${price} must be refused`);
    }
  });

  it('rejects an offer with no linked product or no product name', async () => {
    const { evaluateOfferPublication } = await import('../offer-publishing');
    assert.equal(evaluateOfferPublication({ ...base, productId: null, product: null }).ok, false);
    assert.equal(evaluateOfferPublication({ ...base, product: { name: '   ', platform: '', productUrl: '' } }).ok, false);
  });

  it('rejects an offer with no buyer-facing delivery information', async () => {
    const { evaluateOfferPublication } = await import('../offer-publishing');
    const result = evaluateOfferPublication({ ...base, description: '', scopeSummary: '' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('delivery information')));
  });

  it('re-screens customer-facing text: a stored-HALAL offer with prohibited terms is refused', async () => {
    const { evaluateOfferPublication } = await import('../offer-publishing');
    const result = evaluateOfferPublication({ ...base, title: 'Casino bankroll planner', description: 'Betting progression worksheets.' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith('Screening blocks')));
  });

  it('detects an existing Polar publication and builds an offer-priced spec', async () => {
    const { isAlreadyPublishedOnPolar, buildOfferPublishSpec } = await import('../offer-publishing');
    assert.equal(isAlreadyPublishedOnPolar({ platform: 'polar', productUrl: 'https://polar.sh/products/x' }), true);
    assert.equal(isAlreadyPublishedOnPolar({ platform: '', productUrl: 'https://polar.sh/products/x' }), false);
    assert.equal(isAlreadyPublishedOnPolar({ platform: 'polar', productUrl: 'https://example.com/x' }), false);
    assert.equal(isAlreadyPublishedOnPolar(null), false);

    const spec = buildOfferPublishSpec({
      id: 'off_gate_1',
      type: 'DIGITAL_PRODUCT',
      title: 'Focus Planner Kit',
      description: 'A downloadable planner.',
      scopeSummary: 'Instant download.',
      price: 29,
    });
    assert.equal(spec.pricingHypothesis, '$29');
    assert.ok(spec.mvpFeatures.length >= 1);
    assert.equal(spec.evidenceProvenance, 'USER_ENTERED');
  });
});

// ---------------------------------------------------------------------------
// STEP 4 + STEP 8 — the human-gated publication service against a fake
// provider transport (create + verification round-trip), with DB persistence.
// ---------------------------------------------------------------------------

describe('human-gated Polar publication service', () => {
  it('requires an explicit human approval token before consulting any adapter', async () => {
    const { publishOfferToPolar } = await import('../offer-publishing');
    const { offerId } = await seedOffer();
    let adapterTouched = false;
    const result = await publishOfferToPolar({
      offerId,
      humanApprovalToken: '   ',
      actor: 'test',
      surface: 'test:polar',
      createAdapter: () => {
        adapterTouched = true;
        throw new Error('adapter must not be constructed without a token');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'VALIDATION');
    assert.equal(adapterTouched, false);
  });

  it('refuses an unknown offer', async () => {
    const { publishOfferToPolar } = await import('../offer-publishing');
    const result = await publishOfferToPolar({
      offerId: 'off_does_not_exist',
      humanApprovalToken: 'approve-1',
      actor: 'test',
      surface: 'test:polar',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'NOT_FOUND');
  });

  it('refuses an inactive offer at the gates (adapter never consulted)', async () => {
    const { publishOfferToPolar } = await import('../offer-publishing');
    const { offerId } = await seedOffer({ offerStatus: 'DRAFT' });
    let adapterTouched = false;
    const result = await publishOfferToPolar({
      offerId,
      humanApprovalToken: 'approve-1',
      actor: 'test',
      surface: 'test:polar',
      createAdapter: () => {
        adapterTouched = true;
        throw new Error('adapter must not be constructed for a gate failure');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'VALIDATION');
    assert.ok((result.errors ?? []).length > 0);
    assert.equal(adapterTouched, false);
  });

  it('reports AUTH_REQUIRED (naming the variable) when no credential is configured', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    const { publishOfferToPolar } = await import('../offer-publishing');
    const { offerId } = await seedOffer({ title: 'Unconfigured Offer' });
    let adapterTouched = false;
    const result = await publishOfferToPolar({
      offerId,
      humanApprovalToken: 'approve-1',
      actor: 'test',
      surface: 'test:polar',
      createAdapter: () => {
        adapterTouched = true;
        throw new Error('adapter must not be constructed when unconfigured');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'AUTH_REQUIRED');
    assert.ok((result.errors ?? []).some((e) => e.includes('POLAR_ACCESS_TOKEN')));
    assert.equal(adapterTouched, false);
  });

  it('successful publish: verified round-trip → persisted URL, offer metadata, audited fingerprint only', async () => {
    process.env.POLAR_ACCESS_TOKEN = FAKE_POLAR_TOKEN;
    try {
      const { offerId, productId, opportunityId } = await seedOffer({ title: 'Round Trip Planner', price: 29 });
      const calls: Array<{ url: string; method: string; body?: string }> = [];
      const providerPayload = { id: 'pol_prod_rt1', name: 'Round Trip Planner' };
      const fakeFetch = async (input: unknown, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: String(input), method, body: init?.body });
        return new Response(JSON.stringify(providerPayload), { status: 200 });
      };

      const { publishOfferToPolar } = await import('../offer-publishing');
      const { PolarPublishingAdapter } = await import('../polar-publishing');
      const result = await publishOfferToPolar({
        offerId,
        humanApprovalToken: 'approve-round-trip',
        actor: 'admin@aiincome.lab',
        surface: 'test:polar',
        createAdapter: () => new PolarPublishingAdapter({ fetchImpl: fakeFetch as unknown as typeof fetch }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 'PUBLISHED');
      assert.equal(result.publicationId, 'pol_prod_rt1');
      assert.equal(result.publicationUrl, 'https://polar.sh/products/pol_prod_rt1');

      // Provider was called exactly as the contract requires: POST create +
      // GET verification round-trip, price derived from the OFFER in cents,
      // and OUR linkage stamped into metadata for the webhook.
      const post = calls.find((c) => c.method === 'POST');
      assert.ok(post, 'expected a product creation call');
      const sent = JSON.parse(post!.body ?? '{}') as { prices?: { price_amount?: number }[]; metadata?: Record<string, unknown> };
      assert.equal(sent.prices?.[0]?.price_amount, 2900);
      assert.equal(sent.metadata?.offerId, offerId);
      assert.equal(sent.metadata?.productId, productId);
      assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('pol_prod_rt1')));

      // Persisted into EXISTING fields only (storefront Buy link source).
      const { db } = await importDb();
      const product = await db.product.findUnique({ where: { id: productId } });
      assert.equal(product?.platform, 'polar');
      assert.equal(product?.productUrl, 'https://polar.sh/products/pol_prod_rt1');
      assert.ok(opportunityId);

      // Audit: outcome ok, token FINGERPRINT only — never the raw token.
      const events = await db.securityEvent.findMany({ where: { kind: 'POLAR_PUBLICATION', outcome: 'ok' } });
      assert.ok(events.length >= 1, 'expected an audit row');
      const detail = events[events.length - 1]?.detail ?? '';
      assert.equal(detail.includes(FAKE_POLAR_TOKEN), false, 'token must never be audited');
      assert.equal(detail.includes('approve-round-trip'), false, 'approval token must never be audited raw');
      assert.match(detail, /approved=[0-9a-f]{16}/);
    } finally {
      delete process.env.POLAR_ACCESS_TOKEN;
    }
  });

  it('never creates a second provider product for an already-published offer', async () => {
    process.env.POLAR_ACCESS_TOKEN = FAKE_POLAR_TOKEN;
    try {
      const { db } = await importDb();
      const { offerId, productId } = await seedOffer({ title: 'Already Published Kit' });
      await db.product.update({ where: { id: productId }, data: { platform: 'polar', productUrl: 'https://polar.sh/products/pol_existing' } });

      let adapterTouched = false;
      const { publishOfferToPolar } = await import('../offer-publishing');
      const result = await publishOfferToPolar({
        offerId,
        humanApprovalToken: 'approve-1',
        actor: 'test',
        surface: 'test:polar',
        createAdapter: () => {
          adapterTouched = true;
          throw new Error('adapter must not be constructed for an already-published offer');
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'ALREADY_PUBLISHED');
      assert.equal(result.publicationUrl, 'https://polar.sh/products/pol_existing');
      assert.equal(adapterTouched, false);
    } finally {
      delete process.env.POLAR_ACCESS_TOKEN;
    }
  });

  it('provider HTTP failure is reported honestly and the product stays unpublished', async () => {
    process.env.POLAR_ACCESS_TOKEN = FAKE_POLAR_TOKEN;
    try {
      const { offerId, productId } = await seedOffer({ title: 'Failed Publish Kit' });
      const fakeFetch = async () => new Response('provider rejected', { status: 400 });
      const { publishOfferToPolar } = await import('../offer-publishing');
      const { PolarPublishingAdapter } = await import('../polar-publishing');
      const result = await publishOfferToPolar({
        offerId,
        humanApprovalToken: 'approve-1',
        actor: 'test',
        surface: 'test:polar',
        createAdapter: () => new PolarPublishingAdapter({ fetchImpl: fakeFetch as unknown as typeof fetch }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'PROVIDER_FAILED');
      const { db } = await importDb();
      const product = await db.product.findUnique({ where: { id: productId } });
      assert.equal(product?.platform, '');
      assert.equal(product?.productUrl, '');
    } finally {
      delete process.env.POLAR_ACCESS_TOKEN;
    }
  });

  it('a failed verification round-trip never claims publication (Rule 2)', async () => {
    process.env.POLAR_ACCESS_TOKEN = FAKE_POLAR_TOKEN;
    try {
      const { offerId, productId } = await seedOffer({ title: 'Unverified Round Trip Kit' });
      const fakeFetch = async (input: unknown, init?: { method?: string }) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return new Response(JSON.stringify({ id: 'pol_unverified', name: 'Unverified Round Trip Kit' }), { status: 200 });
        }
        return new Response('verification unavailable', { status: 500 });
      };
      const { publishOfferToPolar } = await import('../offer-publishing');
      const { PolarPublishingAdapter } = await import('../polar-publishing');
      const result = await publishOfferToPolar({
        offerId,
        humanApprovalToken: 'approve-1',
        actor: 'test',
        surface: 'test:polar',
        createAdapter: () => new PolarPublishingAdapter({ fetchImpl: fakeFetch as unknown as typeof fetch }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'PROVIDER_FAILED');
      assert.equal(result.publicationUrl, undefined, 'no publication URL may be claimed without the round-trip');
      const { db } = await importDb();
      const product = await db.product.findUnique({ where: { id: productId } });
      assert.equal(product?.platform, '');
    } finally {
      delete process.env.POLAR_ACCESS_TOKEN;
    }
  });
});

// ---------------------------------------------------------------------------
// STEP 5 + STEP 6 — webhook offer mapping into the EXISTING revenue pipeline.
// ---------------------------------------------------------------------------

describe('webhook offer mapping → verified revenue (exactly once)', () => {
  it('records a paid order with offer metadata once; replay collapses to DUPLICATE', async () => {
    const { offerId, productId, opportunityId } = await seedOffer({ title: 'Webhook Offer One', price: 33 });
    const { processVerifiedPaymentEvent } = await import('../webhook-events');
    const event = {
      eventId: 'evt_offer_ok',
      eventType: 'order.paid',
      order: {
        id: 'order_offer_ok',
        total_amount: 3300,
        currency: 'USD',
        metadata: { offerId, productId },
        created_at: '2026-09-02T10:00:00Z',
      },
    };
    const first = await processVerifiedPaymentEvent(event, new Date());
    assert.equal(first.status, 'RECORDED');
    const replay = await processVerifiedPaymentEvent(event, new Date());
    assert.equal(replay.status, 'DUPLICATE');

    const { db } = await importDb();
    const rows = await db.revenue.findMany({ where: { referenceNote: { contains: 'evt_offer_ok' } } });
    assert.equal(rows.length, 1, 'exactly one revenue row despite two deliveries');
    assert.ok(rows[0].referenceNote.includes(`offer:${offerId}`));
    assert.equal(rows[0].productId, productId);
    assert.equal(rows[0].opportunityId, opportunityId);
    assert.equal(rows[0].revenueSource, 'POLAR_WEBHOOK');
  });

  it('REJECTED: metadata offerId that matches no offer is never guessed', async () => {
    const { processVerifiedPaymentEvent } = await import('../webhook-events');
    const outcome = await processVerifiedPaymentEvent(
      {
        eventId: 'evt_offer_unknown',
        eventType: 'order.paid',
        order: { id: 'order_offer_unknown', total_amount: 4400, currency: 'USD', metadata: { offerId: 'off_no_such_offer' } },
      },
      new Date(),
    );
    assert.equal(outcome.status, 'REJECTED');
    if (outcome.status === 'REJECTED') assert.equal(outcome.reason, 'OFFER_NOT_LINKED');
    const { db } = await importDb();
    const rows = await db.revenue.findMany({ where: { referenceNote: { contains: 'evt_offer_unknown' } } });
    assert.equal(rows.length, 0);
  });

  it('REJECTED: a paid order on a non-HALAL offer is not verified revenue', async () => {
    const { offerId } = await seedOffer({ title: 'Webhook Non Halal Offer', halalStatus: 'UNVERIFIED', price: 44 });
    const { processVerifiedPaymentEvent } = await import('../webhook-events');
    const outcome = await processVerifiedPaymentEvent(
      {
        eventId: 'evt_offer_nonhalal',
        eventType: 'order.paid',
        order: { id: 'order_offer_nonhalal', total_amount: 5500, currency: 'USD', metadata: { offerId } },
      },
      new Date(),
    );
    assert.equal(outcome.status, 'REJECTED');
    if (outcome.status === 'REJECTED') assert.equal(outcome.reason, 'OFFER_NOT_ELIGIBLE');
    const { db } = await importDb();
    const rows = await db.revenue.findMany({ where: { referenceNote: { contains: 'evt_offer_nonhalal' } } });
    assert.equal(rows.length, 0);
  });

  it('REJECTED: an order whose offer and product disagree is never recorded', async () => {
    const { db } = await importDb();
    const { offerId } = await seedOffer({ title: 'Mismatch Product A', price: 66 });
    const otherProduct = await db.product.create({
      data: { name: 'Mismatch Product B', type: 'DIGITAL_PRODUCT', status: 'READY', price: 66 },
    });
    const { processVerifiedPaymentEvent } = await import('../webhook-events');
    const outcome = await processVerifiedPaymentEvent(
      {
        eventId: 'evt_offer_mismatch',
        eventType: 'order.paid',
        order: { id: 'order_offer_mismatch', total_amount: 6600, currency: 'USD', metadata: { offerId }, product: { name: 'Mismatch Product B' } },
      },
      new Date(),
    );
    assert.equal(outcome.status, 'REJECTED');
    if (outcome.status === 'REJECTED') assert.equal(outcome.reason, 'OFFER_PRODUCT_MISMATCH');
    const rows = await db.revenue.findMany({ where: { referenceNote: { contains: 'evt_offer_mismatch' } } });
    assert.equal(rows.length, 0);
    assert.ok(otherProduct.id);
  });
});

// ---------------------------------------------------------------------------
// STEP 5/6 route-level: real signature boundary + real route handlers.
// ---------------------------------------------------------------------------

function signStandard(body: string, secret: string): Record<string, string> {
  const id = `msg_${Math.random().toString(36).slice(2, 12)}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${sig}`,
  };
}

describe('polar payment webhook route — signed E2E', () => {
  before(() => { process.env.POLAR_WEBHOOK_SECRET = FAKE_WEBHOOK_SECRET; });
  after(() => { delete process.env.POLAR_WEBHOOK_SECRET; });

  const routeRequest = (body: string, headers: Record<string, string>) =>
    new Request('http://localhost/api/webhooks/polar', { method: 'POST', headers, body });

  it('rejects a request with no signature headers (401)', async () => {
    const route = await import('../../../app/api/webhooks/polar/route');
    const res = await route.POST(routeRequest('{}', { 'content-type': 'application/json' }));
    assert.equal(res.status, 401);
    const json = (await res.json()) as { error?: string };
    assert.equal(json.error, 'MISSING_HEADERS');
  });

  it('rejects an invalid signature (401 BAD_SIGNATURE)', async () => {
    const route = await import('../../../app/api/webhooks/polar/route');
    const body = JSON.stringify({ id: 'evt_bad_sig', type: 'order.paid' });
    const headers = signStandard(body, FAKE_WEBHOOK_SECRET);
    headers['webhook-signature'] = 'v1,aW52YWxpZC1zaWduYXR1cmU=';
    const res = await route.POST(routeRequest(body, headers));
    assert.equal(res.status, 401);
    const json = (await res.json()) as { error?: string };
    assert.equal(json.error, 'BAD_SIGNATURE');
  });

  it('ignores a correctly signed but malformed payload (safe 200 IGNORED, no retry storm)', async () => {
    const route = await import('../../../app/api/webhooks/polar/route');
    const body = 'this is not json';
    const res = await route.POST(routeRequest(body, signStandard(body, FAKE_WEBHOOK_SECRET)));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { status?: string; reason?: string };
    assert.equal(json.status, 'IGNORED');
    assert.equal(json.reason, 'UNPARSEABLE');
  });

  it('ignores a signed non-paid event without touching the ledger', async () => {
    const route = await import('../../../app/api/webhooks/polar/route');
    const body = JSON.stringify({ id: 'evt_route_refundish', type: 'subscription.canceled', data: { id: 'x', total_amount: 100 } });
    const res = await route.POST(routeRequest(body, signStandard(body, FAKE_WEBHOOK_SECRET)));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { status?: string };
    assert.equal(json.status, 'IGNORED');
  });

  it('accepts a valid signed paid order with offer metadata and records revenue exactly once', async () => {
    const { offerId, productId } = await seedOffer({ title: 'Signed Route Offer', price: 77 });
    const route = await import('../../../app/api/webhooks/polar/route');
    const body = JSON.stringify({
      id: 'evt_route_paid_1',
      type: 'order.paid',
      data: { id: 'order_route_paid_1', total_amount: 7700, currency: 'USD', metadata: { offerId, productId }, created_at: '2026-09-03T09:00:00Z' },
    });
    const first = await route.POST(routeRequest(body, signStandard(body, FAKE_WEBHOOK_SECRET)));
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as { status?: string };
    assert.equal(firstJson.status, 'RECORDED');

    const replay = await route.POST(routeRequest(body, signStandard(body, FAKE_WEBHOOK_SECRET)));
    assert.equal(replay.status, 200);
    const replayJson = (await replay.json()) as { status?: string };
    assert.equal(replayJson.status, 'DUPLICATE');

    const { db } = await importDb();
    const rows = await db.revenue.findMany({ where: { referenceNote: { contains: 'evt_route_paid_1' } } });
    assert.equal(rows.length, 1, 'a replayed signed event must never double-count revenue');
    assert.ok(rows[0].referenceNote.includes(`offer:${offerId}`));
  });
});

// ---------------------------------------------------------------------------
// Admin authorization on the publish route (existing auth, unchanged).
// ---------------------------------------------------------------------------

describe('offer publish route — admin boundary', () => {
  before(() => {
    process.env.ADMIN_EMAIL = 'admin@aiincome.lab';
    process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
    delete process.env.ADMIN_PASSWORD_HASH;
    delete process.env.POLAR_ACCESS_TOKEN;
  });

  let cookie: string | null = null;
  async function adminCookie(): Promise<string> {
    if (cookie) return cookie;
    const session = await import('../../../app/api/admin/session/route');
    const res = await session.POST(
      new Request('http://localhost/api/admin/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.44' },
        body: JSON.stringify({ email: 'admin@aiincome.lab', password: 'correct-horse-battery-staple' }),
      }),
    );
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, `admin login failed (${res.status})`);
    cookie = setCookie.split(';')[0];
    return cookie;
  }

  const publishRequest = (offerId: string, body: unknown, cookieHeader?: string) =>
    new Request(`http://localhost/api/commercial/offers/${offerId}/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.44',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify(body),
    });

  it('refuses without an admin session (401)', async () => {
    const route = await import('../../../app/api/commercial/offers/[offerId]/publish/route');
    const res = await route.POST(publishRequest('off_x', { humanApprovalToken: 'approve-1' }), { params: Promise.resolve({ offerId: 'off_x' }) });
    assert.equal(res.status, 401);
  });

  it('refuses a session request without an explicit human approval token (400)', async () => {
    const route = await import('../../../app/api/commercial/offers/[offerId]/publish/route');
    const c = await adminCookie();
    const res = await route.POST(publishRequest('off_x', {}, c), { params: Promise.resolve({ offerId: 'off_x' }) });
    assert.equal(res.status, 400);
  });

  it('reports AUTH_REQUIRED (503) with configuration VARIABLE NAMES only when unconfigured', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    const route = await import('../../../app/api/commercial/offers/[offerId]/publish/route');
    const c = await adminCookie();
    const { offerId } = await seedOffer({ title: 'Route Auth Required Offer' });
    const res = await route.POST(publishRequest(offerId, { humanApprovalToken: 'approve-1' }, c), { params: Promise.resolve({ offerId }) });
    assert.equal(res.status, 503);
    const text = JSON.stringify(await res.json());
    assert.ok(text.includes('POLAR_ACCESS_TOKEN'));
    assert.equal(text.includes(FAKE_POLAR_TOKEN), false, 'no credential value may appear');
  });
});
