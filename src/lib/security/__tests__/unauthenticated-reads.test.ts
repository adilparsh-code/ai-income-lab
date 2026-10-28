// N3: sensitive GET endpoints must not answer anonymous callers.
// Part 1 is a STATIC invariant over every API route (fails the build when a new
// GET handler ships without an auth guard). Part 2 exercises the handlers.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

Object.assign(process.env, { NODE_ENV: 'test' });
process.env.OPERATOR_CONTROL_TOKEN = 'n3-control-token-for-tests-0001';
delete process.env.OPERATOR_REVENUE_TOKEN;

import { __setRateLimitStoreForTests } from '@/lib/security/guard';

const API_ROOT = join(process.cwd(), 'src', 'app', 'api');
function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routes(full));
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

// GET handlers that are public on purpose. Adding to this list is a security
// decision: the handler must return nothing sensitive to an anonymous caller.
const PUBLIC_GET_ALLOWLIST: Record<string, string> = {
  'health/route.ts': 'liveness probe: status + database ok/unavailable + timestamp only',
  'admin/session/route.ts': 'login-state probe: anonymous callers only learn authenticated:false',
};
const GUARD = /guardOperatorEndpoint|guardBrowserOrOperator|requireOperator|authenticateAgentRequest|requireRufloRuntime|requireAdmin\w*|currentAdminSession/;

describe('every GET handler is guarded or explicitly public', () => {
  for (const file of routes(API_ROOT)) {
    const rel = file.slice(API_ROOT.length + 1);
    const source = readFileSync(file, 'utf8');
    const match = /export async function GET\b[\s\S]*?(?=\nexport async function |$)/.exec(source);
    if (!match) continue;
    it(`${rel}`, () => {
      if (PUBLIC_GET_ALLOWLIST[rel]) return;
      assert.match(match[0], GUARD, `GET in ${rel} has no auth guard and is not on the public allowlist`);
    });
  }

  it('the public allowlist contains only routes that exist', () => {
    const rels = routes(API_ROOT).map((f) => f.slice(API_ROOT.length + 1));
    for (const key of Object.keys(PUBLIC_GET_ALLOWLIST)) assert.ok(rels.includes(key), key);
  });
});

function healthyStore() {
  const counts = new Map<string, number>();
  return {
    upsert: async ({ bucketKey, windowKey, expiresAt }: { bucketKey: string; windowKey: string; expiresAt: Date }) => {
      const k = `${bucketKey}|${windowKey}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      return { count: counts.get(k)!, expiresAt };
    },
  };
}
afterEach(() => __setRateLimitStoreForTests(null));

const anon = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { 'x-forwarded-for': '198.51.100.7', ...headers } });
const BAD = { authorization: 'Bearer definitely-not-the-token' };

describe('anonymous and wrong-credential callers are refused (401) — handlers', () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['income-loop state', async () => (await import('@/app/api/income-loop/[opportunityId]/route')).GET(anon('http://localhost/api/income-loop/opp_1'), { params: Promise.resolve({ opportunityId: 'opp_1' }) })],
    ['events funnel', async () => (await import('@/app/api/events/route')).GET(anon('http://localhost/api/events?productId=p1&days=30'))],
    ['ruflo connector', async () => (await import('@/app/api/ruflo/connector/route')).GET(anon('http://localhost/api/ruflo/connector'))],
    ['polar service status', async () => (await import('@/app/api/webhooks/polar/service/route')).GET(anon('http://localhost/api/webhooks/polar/service'))],
    ['ops missions', async () => (await import('@/app/api/ops/missions/route')).GET(anon('http://localhost/api/ops/missions'))],
  ];
  for (const [name, call] of cases) {
    it(`${name}: no credential → 401 with no data`, async () => {
      __setRateLimitStoreForTests(healthyStore());
      const res = await call();
      assert.equal(res.status, 401);
      const body = JSON.stringify(await res.json());
      assert.ok(!/"state"|"funnel"|"ruflo"|"missions"|"capability"|"liveE2EVerified"/.test(body), `${name} leaked data: ${body.slice(0, 120)}`);
    });
  }
  it('a cross-origin browser request with no session is refused (403)', async () => {
    __setRateLimitStoreForTests(healthyStore());
    const { GET } = await import('@/app/api/ruflo/connector/route');
    const res = await GET(anon('http://localhost/api/ruflo/connector', { origin: 'https://evil.example', host: 'localhost' }));
    assert.equal(res.status, 403);
  });
  it('the guard fails closed (503) when rate-limit storage is down, even with a valid operator token', async () => {
    __setRateLimitStoreForTests({ upsert: async () => { throw new Error('db down'); } });
    const { GET } = await import('@/app/api/ruflo/connector/route');
    const res = await GET(anon('http://localhost/api/ruflo/connector', { authorization: 'Bearer n3-control-token-for-tests-0001' }));
    assert.equal(res.status, 503);
  });
  for (const [name, headers] of [['wrong token', BAD]] as const) {
    it(`ruflo connector: ${name} → 401`, async () => {
      __setRateLimitStoreForTests(healthyStore());
      const { GET } = await import('@/app/api/ruflo/connector/route');
      assert.equal((await GET(anon('http://localhost/api/ruflo/connector', headers))).status, 401);
    });
  }
});

describe('authorized callers still work (control)', () => {
  it('operator token reads the ruflo connector status', async () => {
    __setRateLimitStoreForTests(healthyStore());
    const { GET } = await import('@/app/api/ruflo/connector/route');
    const res = await GET(anon('http://localhost/api/ruflo/connector', { authorization: 'Bearer n3-control-token-for-tests-0001' }));
    assert.equal(res.status, 200);
  });
  it('operator token passes the polar status guard', async () => {
    __setRateLimitStoreForTests(healthyStore());
    const { GET } = await import('@/app/api/webhooks/polar/service/route');
    const res = await GET(anon('http://localhost/api/webhooks/polar/service', { authorization: 'Bearer n3-control-token-for-tests-0001' }));
    assert.equal(res.status, 200);
  });
});

describe('public endpoints disclose nothing about the deployment', () => {
  it('/api/health exposes no app name, environment or deployed flag', async () => {
    const { GET } = await import('@/app/api/health/route');
    const body = (await (await GET()).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['database', 'status', 'timestamp']);
  });
  it('GET /api/admin/session (anonymous) does not reveal credential configuration', async () => {
    const { GET } = await import('@/app/api/admin/session/route');
    const body = (await (await GET(anon('http://localhost/api/admin/session'))).json()) as Record<string, unknown>;
    assert.deepEqual(body, { ok: true, authenticated: false });
  });
});
