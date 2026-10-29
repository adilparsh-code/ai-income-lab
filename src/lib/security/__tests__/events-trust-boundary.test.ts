// N2 at the HTTP boundary, DB-free: refusals happen before any storage access.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test' });
process.env.OPERATOR_CONTROL_TOKEN = 'n2-control-token-for-tests-0001';
delete process.env.OPERATOR_REVENUE_TOKEN;

import { __setRateLimitStoreForTests } from '@/lib/security/guard';

const store = () => {
  const counts = new Map<string, number>();
  return { upsert: async ({ bucketKey, windowKey, expiresAt }: { bucketKey: string; windowKey: string; expiresAt: Date }) => {
    const k = `${bucketKey}|${windowKey}`; counts.set(k, (counts.get(k) ?? 0) + 1); return { count: counts.get(k)!, expiresAt };
  } };
};
afterEach(() => __setRateLimitStoreForTests(null));

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20', ...headers },
    body: JSON.stringify(body),
  });
const forged = (eventType: string, extra: Record<string, unknown> = {}) => ({
  eventType, productId: 'prod_1', idempotencyKey: `k-${eventType}-1`, source: 'attacker', amountUsd: 9999, evidenceType: 'VERIFIED_DATA', ...extra,
});

describe('POST /api/events trust boundary (no storage needed)', () => {
  it('anonymous PURCHASE, REFUND → 403', async () => {
    __setRateLimitStoreForTests(store());
    const { POST } = await import('@/app/api/events/route');
    for (const t of ['PURCHASE', 'REFUND']) assert.equal((await POST(post(forged(t)))).status, 403, t);
  });
  it('a wrong bearer token is 401 — never downgraded to anonymous handling', async () => {
    __setRateLimitStoreForTests(store());
    const { POST } = await import('@/app/api/events/route');
    for (const t of ['PURCHASE', 'PRODUCT_VIEW']) {
      assert.equal((await POST(post(forged(t), { authorization: 'Bearer nope' }))).status, 401, t);
    }
  });
  it('the REVENUE operator token cannot authorize events (privileges stay separate)', async () => {
    process.env.OPERATOR_REVENUE_TOKEN = 'n2-revenue-token-for-tests-0002';
    try {
      __setRateLimitStoreForTests(store());
      const { POST } = await import('@/app/api/events/route');
      assert.equal((await POST(post(forged('PURCHASE'), { authorization: 'Bearer n2-revenue-token-for-tests-0002' }))).status, 401);
    } finally { delete process.env.OPERATOR_REVENUE_TOKEN; }
  });
  it('fails closed (503) when rate-limit storage is down', async () => {
    __setRateLimitStoreForTests({ upsert: async () => { throw new Error('db down'); } });
    const { POST } = await import('@/app/api/events/route');
    const status = (await POST(post(forged('PRODUCT_VIEW')))).status;
    assert.ok(status === 503 || status === 429, `expected deny, got ${status}`);
  });
});
