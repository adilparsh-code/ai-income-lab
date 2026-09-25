// Phase 5.5 — Events + Revenue ingestion API route tests.
//
// Handlers are exercised directly over a temporary libSQL database. Proves:
// - POST /api/events validates input, records idempotently (RECORDED →
//   DUPLICATE on replay), and serves deterministic funnel metrics.
// - POST /api/revenue fails closed (503) without OPERATOR_REVENUE_TOKEN,
//   rejects bad tokens (401), records verified rows for the operator (200),
//   and never double-records a replayed payment.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-api-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma7 db push --schema prisma/schema.test.prisma', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* tmp cleanup best-effort */ }
});

const importDb = () => import('@/lib/db');

async function seedProduct(): Promise<string> {
  const { db } = await importDb();
  const product = await db.product.create({ data: { name: 'API Test Product', type: 'DIGITAL_PRODUCT', status: 'PUBLISHED' } });
  return product.id;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/events', () => {
  it('rejects invalid input with 400 and a specific error', async () => {
    const { POST } = await import('@/app/api/events/route');
    const res = await POST(jsonRequest('http://localhost/api/events', { eventType: 'NOT_A_TYPE', productId: '', idempotencyKey: '', source: '' }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('eventType'));
  });

  it('records an event, then reports DUPLICATE for the identical replay', async () => {
    const { POST } = await import('@/app/api/events/route');
    const productId = await seedProduct();
    const payload = {
      eventType: 'VISITOR',
      productId,
      idempotencyKey: `visit-${productId}-session-1`,
      source: 'test-suite',
      sessionId: 'anon-session-1',
    };

    const first = await POST(jsonRequest('http://localhost/api/events', payload));
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { ok: boolean; status: string };
    assert.equal(firstBody.status, 'RECORDED');

    const replay = await POST(jsonRequest('http://localhost/api/events', payload));
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as { status: string };
    assert.equal(replayBody.status, 'DUPLICATE');
  });

  it('records a PURCHASE with amount and serves funnel metrics via GET', async () => {
    const events = await import('@/app/api/events/route');
    const { db } = await importDb();
    const product = await db.product.create({ data: { name: 'Funnel Product', type: 'DIGITAL_PRODUCT', status: 'PUBLISHED' } });

    const post = (i: number) => events.POST(jsonRequest('http://localhost/api/events', {
      eventType: i % 2 === 0 ? 'VISITOR' : 'PURCHASE',
      productId: product.id,
      idempotencyKey: `funnel-${product.id}-${i}`,
      source: 'test-suite',
      sessionId: `session-${i}`,
      amountUsd: i % 2 === 0 ? undefined : 25,
    }));
    for (let i = 0; i < 6; i++) await post(i);

    const url = new URL(`http://localhost/api/events?productId=${product.id}&days=30`);
    const res = await events.GET(new Request(url));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; funnel: { productId: string; purchases: number; visitors: number } };
    assert.equal(body.ok, true);
    assert.equal(body.funnel.productId, product.id);
    assert.ok(body.funnel.visitors >= 3);
    assert.ok(body.funnel.purchases >= 3);
  });
});

describe('POST /api/revenue', () => {
  it('fails closed with 503 when no operator token is configured', async () => {
    delete process.env.OPERATOR_REVENUE_TOKEN;
    const { POST } = await import('@/app/api/revenue/route');
    const res = await POST(jsonRequest('http://localhost/api/revenue', { date: new Date().toISOString(), revenueSource: 'X', grossRevenue: 5 }));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('NOT_CONFIGURED'));
  });

  it('rejects missing and wrong tokens with 401 when configured', async () => {
    process.env.OPERATOR_REVENUE_TOKEN = 'op-secret-token-for-tests';
    const { POST, verifyOperatorToken } = await import('@/app/api/revenue/route');

    const noAuth = await POST(jsonRequest('http://localhost/api/revenue', { date: new Date().toISOString(), revenueSource: 'X', grossRevenue: 5 }));
    assert.equal(noAuth.status, 401);

    const badAuth = await POST(jsonRequest('http://localhost/api/revenue',
      { date: new Date().toISOString(), revenueSource: 'X', grossRevenue: 5 },
      { Authorization: 'Bearer wrong-token' },
    ));
    assert.equal(badAuth.status, 401);

    assert.equal(verifyOperatorToken('op-secret-token-for-tests'), true);
    assert.equal(verifyOperatorToken('wrong'), false);
    assert.equal(verifyOperatorToken(null), false);
  });

  it('records verified revenue for the operator, with attribution, and deduplicates replays', async () => {
    const { POST } = await import('@/app/api/revenue/route');
    const { db } = await importDb();
    const product = await db.product.create({ data: { name: 'Rev API Product', type: 'DIGITAL_PRODUCT', status: 'PUBLISHED' } });
    const payload = {
      date: '2026-09-18T12:00:00.000Z',
      revenueSource: 'Stripe payout',
      grossRevenue: 79,
      fees: 2.37,
      productId: product.id,
      referenceNote: 'api-test',
    };

    const ok = await POST(jsonRequest('http://localhost/api/revenue', payload, { Authorization: 'Bearer op-secret-token-for-tests' }));
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { status: string; revenueId: string | null; attribution: { source: string; evidenceType: string } | null };
    assert.equal(okBody.status, 'RECORDED');
    assert.ok(okBody.revenueId);
    assert.equal(okBody.attribution!.source, 'PRODUCT');
    assert.equal(okBody.attribution!.evidenceType, 'VERIFIED');

    const replay = await POST(jsonRequest('http://localhost/api/revenue', payload, { Authorization: 'Bearer op-secret-token-for-tests' }));
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as { status: string };
    assert.equal(replayBody.status, 'DUPLICATE');

    const count = await db.revenue.count({ where: { productId: product.id } });
    assert.equal(count, 1, 'a replayed payment must never be recorded twice');
  });
});
