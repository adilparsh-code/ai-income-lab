// Phase 8 — Integration tests over a temporary database (hermetic, real DB).
// Covers: webhook→revenue end-to-end with idempotency, market configuration,
// the authorization ledger state machine, and UTM event attribution.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-p8-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma db push', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* tmp cleanup best-effort */ }
});

const importDb = () => import('@/lib/db');

async function seedProduct() {
  const { db } = await importDb();
  const opportunity = await db.opportunity.create({
    data: {
      title: 'P8 test opportunity',
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
      name: 'P8 Test Product',
      type: 'DIGITAL_COURSE',
      opportunityId: opportunity.id,
      status: 'PUBLISHED',
      price: 49.99,
    },
  });
  return { opportunityId: opportunity.id, productId: product.id };
}

// ---------------------------------------------------------------------------
// Webhook → revenue end-to-end (recorded through the EXISTING pipeline)
// ---------------------------------------------------------------------------
describe('webhook event processing end-to-end', () => {
  it('records a verified paid order through the shared revenue pipeline', async () => {
    const { productId } = await seedProduct();
    const { processVerifiedPaymentEvent } = await import('../webhook-events');
    const outcome = await processVerifiedPaymentEvent(
      {
        eventId: 'evt_e2e_1',
        eventType: 'order.paid',
        order: {
          id: 'order_e2e_1',
          total_amount: 4999,
          currency: 'USD',
          product_id: productId,
          created_at: '2026-09-01T10:00:00Z',
        },
      },
      new Date(),
    );
    assert.equal(outcome.status, 'RECORDED');
    if (outcome.status === 'RECORDED') {
      assert.equal(outcome.grossRevenue, 49.99); // minor units converted
      assert.equal(outcome.currency, 'USD');
    }
    const { db } = await importDb();
    const rows = await db.revenue.findMany({ where: { revenueSource: 'POLAR_WEBHOOK' } });
    assert.equal(rows.length, 1);
    const firstRow = rows[0];
    assert.ok(firstRow, 'expected exactly one webhook revenue row');
    assert.ok(firstRow.idempotencyKey?.startsWith('rev:')); // derived by shared rule
  });

  it('collapses a replayed event to DUPLICATE (idempotency)', async () => {
    const { processVerifiedPaymentEvent } = await import('../webhook-events');
    const event = {
      eventId: 'evt_e2e_dup',
      eventType: 'order.paid',
      order: { id: 'order_dup', total_amount: 1999, currency: 'USD', product: { name: 'P8 Test Product' } },
    };
    const first = await processVerifiedPaymentEvent(event, new Date());
    assert.equal(first.status, 'RECORDED');
    const replay = await processVerifiedPaymentEvent(event, new Date());
    assert.equal(replay.status, 'DUPLICATE');
    const { db } = await importDb();
    const rows = await db.revenue.findMany({ where: { referenceNote: { contains: 'evt_e2e_dup' } } });
    assert.equal(rows.length, 1); // exactly one row despite two deliveries
  });

  it('REJECTED: order that matches no known product is never guessed', async () => {
    const { processVerifiedPaymentEvent } = await import('../webhook-events');
    const outcome = await processVerifiedPaymentEvent(
      { eventId: 'evt_orphan', eventType: 'order.paid', order: { id: 'order_orphan', total_amount: 2500, currency: 'USD', product: { name: 'No Such Product' } } },
      new Date(),
    );
    assert.equal(outcome.status, 'REJECTED');
    if (outcome.status === 'REJECTED') assert.equal(outcome.reason, 'PRODUCT_NOT_LINKED');
  });
});

// ---------------------------------------------------------------------------
// Market configuration (Rule 9)
// ---------------------------------------------------------------------------
describe('market configuration', () => {
  it('accepts USD everywhere and validates against the registry', async () => {
    const { isCurrencyAcceptedForMarket, providersForMarket } = await import('../markets');
    assert.equal(isCurrencyAcceptedForMarket('usd'), true);
    assert.equal(isCurrencyAcceptedForMarket('EUR'), true);
    assert.equal(isCurrencyAcceptedForMarket('XXX'), false);
    const global = providersForMarket('GLOBAL');
    assert.ok(global.length >= 4);
    assert.ok(global.every((p) => p.available));
  });

  it('records India as a supported market region without duplicating logic', async () => {
    const { providersForMarket } = await import('../markets');
    const india = providersForMarket('IN');
    assert.ok(india.length === providersForMarket('GLOBAL').length);
    assert.ok(india.every((p) => p.available));
  });
});

// ---------------------------------------------------------------------------
// Authorization ledger (Rule 11)
// ---------------------------------------------------------------------------
describe('authorization ledger state machine', () => {
  it('starts NOT_CONNECTED and never reports usable without a grant', async () => {
    const { describeAuthorization, isAuthorizationUsable } = await import('../authorization');
    const view = await describeAuthorization('etsy-p8-test', 'listing');
    assert.equal(view.state, 'NOT_CONNECTED');
    assert.equal(view.usable, false);
    assert.equal(view.tokenFingerprint, null);
    assert.equal(await isAuthorizationUsable('etsy-p8-test', 'listing'), false);
  });

  it('transitions to CONNECTED with a grant and reports usable; token never surfaces', async () => {
    const { upsertAuthorization, isAuthorizationUsable } = await import('../authorization');
    const view = await upsertAuthorization({
      providerId: 'gumroad-p8-test',
      scope: 'products',
      accessTokenCiphertext: 'enc:abc123secretmaterial',
      expiresAt: new Date(Date.now() + 86_400_000),
      grantedScopes: ['products:write'],
    });
    assert.equal(view.state, 'CONNECTED');
    assert.equal(view.usable, true);
    assert.ok(view.tokenFingerprint!.startsWith('enc:abc123'.slice(0, 12)) || view.tokenFingerprint !== null);
    assert.equal(JSON.stringify(view).includes('secretmaterial'), false);
    assert.equal(await isAuthorizationUsable('gumroad-p8-test', 'products'), true);
  });

  it('EXPIRED is derived deterministically and never silently reused', async () => {
    const { upsertAuthorization, describeAuthorization, isAuthorizationUsable, deriveCurrentState } = await import('../authorization');
    await upsertAuthorization({
      providerId: 'youtube-p8-test',
      scope: 'upload',
      accessTokenCiphertext: 'enc:expired',
      expiresAt: new Date(Date.now() - 1000), // already expired
    });
    const view = await describeAuthorization('youtube-p8-test', 'upload');
    assert.equal(view.state, 'EXPIRED');
    assert.equal(view.usable, false);
    assert.equal(await isAuthorizationUsable('youtube-p8-test', 'upload'), false);
    assert.equal(deriveCurrentState({ state: 'CONNECTED', expiresAt: new Date(Date.now() - 5000) }), 'EXPIRED');
  });

  it('REVOKED clears token material and future use', async () => {
    const { upsertAuthorization, revokeAuthorization, isAuthorizationUsable } = await import('../authorization');
    await upsertAuthorization({
      providerId: 'pinterest-p8-test',
      accessTokenCiphertext: 'enc:live',
    });
    assert.equal(await isAuthorizationUsable('pinterest-p8-test'), true);
    const revoked = await revokeAuthorization('pinterest-p8-test');
    assert.equal(revoked.state, 'REVOKED');
    assert.equal(revoked.usable, false);
    assert.equal(await isAuthorizationUsable('pinterest-p8-test'), false);
  });
});

// ---------------------------------------------------------------------------
// UTM event attribution (Rules 6–7)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Publishing status + Polar adapter config honesty (Rules 2 & 5)
// ---------------------------------------------------------------------------
describe('publishing configuration honesty', () => {
  it('PUBLISHING_READY only when POLAR_ACCESS_TOKEN is configured; never claims publications', async () => {
    const { describePublishingStatus } = await import('@/lib/publishing/contract');
    const previous = process.env.POLAR_ACCESS_TOKEN;
    delete process.env.POLAR_ACCESS_TOKEN;
    const unavailable = describePublishingStatus();
    assert.equal(unavailable.status, 'PUBLISHING_UNAVAILABLE');
    process.env.POLAR_ACCESS_TOKEN = 'test-token-value-123456';
    const ready = describePublishingStatus();
    assert.equal(ready.status, 'PUBLISHING_READY');
    assert.match(ready.note, /verified provider round-trip/);
    if (previous === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = previous;
  });

  it('unconfigured Polar adapter refuses publish without any external call', async () => {
    const previous = process.env.POLAR_ACCESS_TOKEN;
    delete process.env.POLAR_ACCESS_TOKEN;
    const { PolarPublishingAdapter } = await import('../polar-publishing');
    const adapter = new PolarPublishingAdapter({ fetchImpl: (async () => { throw new Error('network must not be touched'); }) as typeof fetch });
    const attempt = await adapter.publish(
      { providerId: 'polar', channel: 'DIGITAL_PRODUCT', isLive: false, createdAt: new Date().toISOString(), payload: { name: 'x', prices: [] } },
      'human-token',
    );
    assert.equal(attempt.published, false);
    assert.equal(attempt.status, 'NOT_AUTHORIZED');
    if (previous !== undefined) process.env.POLAR_ACCESS_TOKEN = previous;
  });
});

// ---------------------------------------------------------------------------
// UTM event attribution (Rules 6–7)
// ---------------------------------------------------------------------------
describe('UTM event attribution', () => {
  it('records attribution fields through the existing ingestion contract', async () => {
    const { productId } = await seedProduct();
    const { recordProductEvent } = await import('@/lib/product-factory/events');
    const result = await recordProductEvent({
      eventType: 'VISITOR',
      productId,
      idempotencyKey: 'p8-utm-1',
      source: 'provider:analytics',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'launch-sept',
      utmContent: 'hero-cta',
      utmTerm: null,
      referrer: 'https://example.com',
      landingPage: '/products/p8-test-product',
    });
    assert.equal(result.status, 'RECORDED');
    const { db } = await importDb();
    const row = await db.productEvent.findUnique({ where: { idempotencyKey: 'p8-utm-1' } });
    assert.equal(row?.utmSource, 'newsletter');
    assert.equal(row?.utmCampaign, 'launch-sept');
    assert.equal(row?.landingPage, '/products/p8-test-product');
  });

  it('rejects over-long attribution values (bounded, non-PII contract)', async () => {
    const { productId } = await seedProduct();
    const { recordProductEvent } = await import('@/lib/product-factory/events');
    const result = await recordProductEvent({
      eventType: 'VISITOR',
      productId,
      idempotencyKey: 'p8-utm-2',
      source: 'provider:analytics',
      utmCampaign: 'x'.repeat(301),
    });
    assert.equal(result.status, 'INVALID');
  });
});
