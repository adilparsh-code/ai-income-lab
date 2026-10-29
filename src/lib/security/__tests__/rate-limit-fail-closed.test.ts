// N4: when the durable rate-limit store cannot be read/written, protected
// operations are DENIED. No in-memory fallback exists to bypass.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test' });
process.env.OPERATOR_CONTROL_TOKEN = 'n4-control-token-for-tests-0001';
delete process.env.OPERATOR_REVENUE_TOKEN;

import {
  enforceRateLimit,
  guardOperatorEndpoint,
  guardBrowserOrOperator,
  requireOperator,
  __setRateLimitStoreForTests,
  type RateLimitStore,
} from '@/lib/security/guard';

const OPTS = { surface: 'test:n4', identity: '203.0.113.9', max: 5, windowSeconds: 60 };

function failingStore(): RateLimitStore & { calls: number } {
  const store = { calls: 0, upsert: async () => { store.calls += 1; throw new Error('database unavailable'); } };
  return store;
}
function countingStore(): RateLimitStore {
  const counts = new Map<string, number>();
  return {
    upsert: async ({ bucketKey, windowKey, expiresAt }) => {
      const k = `${bucketKey}|${windowKey}`;
      const count = (counts.get(k) ?? 0) + 1;
      counts.set(k, count);
      return { count, expiresAt };
    },
  };
}
const req = (headers: Record<string, string> = {}) => new Request('http://localhost/api/x', { headers: { 'x-forwarded-for': '203.0.113.9', ...headers } });

afterEach(() => __setRateLimitStoreForTests(null));

describe('enforceRateLimit fails closed', () => {
  it('denies (unavailable) when the store always errors', async () => {
    const store = failingStore();
    __setRateLimitStoreForTests(store);
    const verdict = await enforceRateLimit(OPTS);
    assert.equal(verdict.allowed, false);
    assert.equal((verdict as { unavailable?: boolean }).unavailable, true);
    assert.equal(store.calls, 2, 'exactly one retry for the unique-constraint race, then deny');
  });

  it('has NO in-memory fallback: 500 attempts during an outage are ALL denied', async () => {
    __setRateLimitStoreForTests(failingStore());
    let allowed = 0;
    for (let i = 0; i < 500; i += 1) if ((await enforceRateLimit({ ...OPTS, identity: `ip-${i % 3}` })).allowed) allowed += 1;
    assert.equal(allowed, 0);
  });

  it('a first-hit unique race is retried once and counted exactly once', async () => {
    let calls = 0;
    __setRateLimitStoreForTests({
      upsert: async ({ expiresAt }) => { calls += 1; if (calls === 1) throw new Error('unique constraint'); return { count: 1, expiresAt }; },
    });
    const verdict = await enforceRateLimit(OPTS);
    assert.equal(verdict.allowed, true);
    assert.equal(calls, 2);
  });

  it('still enforces the limit normally when the store is healthy', async () => {
    __setRateLimitStoreForTests(countingStore());
    const results = [] as boolean[];
    for (let i = 0; i < 7; i += 1) results.push((await enforceRateLimit(OPTS)).allowed);
    assert.deepEqual(results, [true, true, true, true, true, false, false]);
  });
});

describe('callers deny protected operations when enforcement fails', () => {
  it('guardOperatorEndpoint refuses with 503 even for a CORRECT operator token', async () => {
    __setRateLimitStoreForTests(failingStore());
    const result = await guardOperatorEndpoint(
      req({ authorization: 'Bearer n4-control-token-for-tests-0001' }), 'test:n4', { max: 10, windowSeconds: 60 });
    assert.ok('response' in result);
    if ('response' in result) assert.equal(result.status, 503);
  });

  it('guardBrowserOrOperator refuses with 503 even for a CORRECT operator token', async () => {
    __setRateLimitStoreForTests(failingStore());
    const result = await guardBrowserOrOperator(
      req({ authorization: 'Bearer n4-control-token-for-tests-0001' }), 'test:n4', { max: 10, windowSeconds: 60 });
    assert.ok('response' in result);
    if ('response' in result) assert.equal(result.status, 503);
  });

  it('requireOperator does not authenticate a correct token when the limiter is down', async () => {
    __setRateLimitStoreForTests(failingStore());
    const verdict = await requireOperator(req({ authorization: 'Bearer n4-control-token-for-tests-0001' }), 'test:n4');
    assert.equal(verdict.ok, false);
  });

  it('with a healthy store the same correct token IS accepted (control)', async () => {
    __setRateLimitStoreForTests(countingStore());
    const verdict = await requireOperator(req({ authorization: 'Bearer n4-control-token-for-tests-0001' }), 'test:n4');
    assert.equal(verdict.ok, true);
  });
});
