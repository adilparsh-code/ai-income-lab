// Phase 5.4 — Event ingestion + funnel metrics + growth integration tests.
// Runs against a temporary libSQL file database (schema pushed via prisma) —
// the same hermetic pattern as the memory-store tests. Nothing is fabricated:
// metrics are computed from events this test actually recorded.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-ev-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma db push --schema prisma/schema.test.prisma', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* tmp cleanup best-effort */ }
});

const importEvents = () => import('../events');
const importDb = () => import('@/lib/db');

async function seedProduct(): Promise<string> {
  const { db } = await importDb();
  const opportunity = await db.opportunity.create({
    data: {
      title: 'Planner product event test',
      category: 'EDUCATION',
      businessModel: 'DIGITAL_PRODUCT',
      targetAudience: 'parents',
      problemSolved: 'Planning takes long',
      monetizationMethod: 'ONE_TIME',
      status: 'VALIDATED',
    },
  });
  const product = await db.product.create({
    data: { name: 'Event Test Planner', type: 'DIGITAL_PRODUCT', opportunityId: opportunity.id },
  });
  return product.id;
}

function eventKey(n: string): string {
  return `evt-${n}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('event ingestion', () => {
  it('validates required fields and rejects malformed events', async () => {
    const { recordProductEvent } = await importEvents();
    const bad = await recordProductEvent({
      eventType: 'SOMETHING_ELSE' as never,
      productId: '',
      idempotencyKey: '',
      source: '',
    });
    assert.equal(bad.status, 'INVALID');
    assert.ok(bad.errors.length >= 3);

    const negativeAmount = await recordProductEvent({
      eventType: 'PURCHASE',
      productId: 'p1',
      idempotencyKey: eventKey('neg'),
      source: 'test',
      amountUsd: -5,
    });
    assert.equal(negativeAmount.status, 'INVALID');
  });

  it('records events and prevents duplicates via idempotency key', async () => {
    const { recordProductEvent } = await importEvents();
    const productId = await seedProduct();
    const key = eventKey('dup');

    const first = await recordProductEvent({
      eventType: 'VISITOR',
      productId,
      sessionId: 'sess-1',
      idempotencyKey: key,
      source: 'test',
    });
    assert.equal(first.status, 'RECORDED');
    assert.ok(first.eventId);

    const duplicate = await recordProductEvent({
      eventType: 'VISITOR',
      productId,
      sessionId: 'sess-1',
      idempotencyKey: key,
      source: 'test',
    });
    assert.equal(duplicate.status, 'DUPLICATE');
    assert.equal(duplicate.eventId, null);
  });

  it('stores only contract fields (no PII surface)', async () => {
    const { recordProductEvent } = await importEvents();
    const productId = await seedProduct();
    const result = await recordProductEvent({
      eventType: 'PURCHASE',
      productId,
      sessionId: 'sess-2',
      idempotencyKey: eventKey('purchase'),
      source: 'test',
      amountUsd: 12.5,
      evidenceType: 'VERIFIED_DATA',
    });
    assert.equal(result.status, 'RECORDED');

    const { db } = await importDb();
    const row = await db.productEvent.findUnique({ where: { idempotencyKey: result.eventId ? undefined : '' } }).catch(() => null);
    // fetch via findFirst on the recorded event instead
    const stored = row ?? await db.productEvent.findFirst({ where: { productId, eventType: 'PURCHASE' } });
    assert.ok(stored);
    const serialized = JSON.stringify(stored);
    // The contract has no fields for IPs/emails/user agents; verify absence.
    assert.equal(/userAgent|ipAddress|email/i.test(serialized), false);
  });
});

describe('funnel metrics (deterministic over recorded events)', () => {
  it('reports INSUFFICIENT_DATA below the visitor threshold and null rates', async () => {
    const { recordProductEvent, computeProductFunnel } = await importEvents();
    const productId = await seedProduct();

    for (let i = 0; i < 5; i++) {
      const recorded = await recordProductEvent({
        eventType: 'VISITOR',
        productId,
        sessionId: `s-${i}`,
        idempotencyKey: eventKey(`v${i}`),
        source: 'test',
      });
      assert.equal(recorded.status, 'RECORDED');
    }
    await recordProductEvent({ eventType: 'PURCHASE', productId, sessionId: 's-0', idempotencyKey: eventKey('pu'), source: 'test', amountUsd: 9 });

    const end = new Date();
    const snapshot = await computeProductFunnel(productId, { start: new Date(end.getTime() - 86_400_000), end });
    assert.equal(snapshot.visitors, 5);
    assert.equal(snapshot.purchases, 1);
    assert.equal(snapshot.conversionRate, null);
    assert.equal(snapshot.evidenceStatus, 'INSUFFICIENT_DATA');
  });

  it('computes supported rates from enough recorded visitors', async () => {
    const { recordProductEvent, computeProductFunnel } = await importEvents();
    const productId = await seedProduct();

    for (let i = 0; i < 32; i++) {
      await recordProductEvent({
        eventType: 'VISITOR',
        productId,
        sessionId: `sv-${i}`,
        idempotencyKey: eventKey(`bv${i}`),
        source: 'test',
      });
    }
    for (let i = 0; i < 5; i++) {
      await recordProductEvent({
        eventType: 'PURCHASE',
        productId,
        sessionId: `sv-${i}`,
        idempotencyKey: eventKey(`bp${i}`),
        source: 'test',
        amountUsd: 20,
      });
    }
    await recordProductEvent({
      eventType: 'REFUND', productId, sessionId: 'sv-0', idempotencyKey: eventKey('br0'), source: 'test', amountUsd: 20,
    });

    const end = new Date();
    const snapshot = await computeProductFunnel(productId, { start: new Date(end.getTime() - 86_400_000), end });
    assert.equal(snapshot.visitors, 32);
    assert.equal(snapshot.evidenceStatus, 'SUPPORTED');
    assert.ok(Math.abs((snapshot.conversionRate ?? 0) - 5 / 32) < 1e-9);
    assert.ok(Math.abs((snapshot.refundRate ?? 0) - 1 / 5) < 1e-9);
    assert.equal(snapshot.grossRevenueUsd, 100);
    assert.equal(snapshot.refundedAmountUsd, 20);
  });
});

describe('growth classification (human decisions dominate)', () => {
  it('keeps PAUSED products paused regardless of metrics', async () => {
    const { assessProductGrowth } = await importEvents();
    const end = new Date();
    const assessment = assessProductGrowth({
      productId: 'p1',
      productStatus: 'PAUSED',
      funnel: {
        productId: 'p1', visitors: 500, productViews: 500, ctaClicks: 100, checkoutStarts: 50,
        purchases: 40, refunds: 0, grossRevenueUsd: 800, refundedAmountUsd: 0, conversionRate: 0.08,
        revenuePerVisitorUsd: 1.6, refundRate: 0, evidenceStatus: 'SUPPORTED',
        windowStart: end.toISOString(), windowEnd: end.toISOString(),
      },
      netRevenueMinor: 80_000,
    });
    assert.equal(assessment.state, 'PAUSED');
    assert.equal(assessment.recommendation, 'PAUSE');
    assert.match(assessment.basis, /human decision/i);
  });

  it('stays TESTING with insufficient data — never fabricates', async () => {
    const { assessProductGrowth } = await importEvents();
    const assessment = assessProductGrowth({
      productId: 'p1',
      productStatus: 'TESTING',
      funnel: {
        productId: 'p1', visitors: 3, productViews: 3, ctaClicks: 0, checkoutStarts: 0,
        purchases: 0, refunds: 0, grossRevenueUsd: 0, refundedAmountUsd: 0, conversionRate: null,
        revenuePerVisitorUsd: null, refundRate: null, evidenceStatus: 'INSUFFICIENT_DATA',
        windowStart: '', windowEnd: '',
      },
      netRevenueMinor: 0,
    });
    assert.equal(assessment.state, 'TESTING');
    assert.equal(assessment.evidenceStatus, 'INSUFFICIENT_DATA');
  });

  it('reaches PROVEN only above recorded revenue thresholds', async () => {
    const { assessProductGrowth } = await importEvents();
    const end = new Date();
    const base = {
      productId: 'p1', productViews: 900, ctaClicks: 300, checkoutStarts: 90, refunds: 0,
      refundedAmountUsd: 0, refundRate: 0, windowStart: end.toISOString(), windowEnd: end.toISOString(),
    };
    const strong = assessProductGrowth({
      productId: 'p1',
      productStatus: 'PUBLISHED',
      funnel: { ...base, visitors: 900, purchases: 90, grossRevenueUsd: 900, conversionRate: 0.1, revenuePerVisitorUsd: 1, evidenceStatus: 'SUPPORTED' },
      netRevenueMinor: 90_000,
    });
    assert.equal(strong.state, 'PROVEN');
    assert.equal(strong.recommendation, 'SCALE');

    const zero = assessProductGrowth({
      productId: 'p2',
      productStatus: 'PUBLISHED',
      funnel: { ...base, visitors: 100, purchases: 0, grossRevenueUsd: 0, conversionRate: 0, revenuePerVisitorUsd: null, evidenceStatus: 'SUPPORTED' },
      netRevenueMinor: 0,
    });
    assert.equal(zero.state, 'UNDERPERFORMING');
    assert.equal(zero.recommendation, 'IMPROVE');
  });
});
