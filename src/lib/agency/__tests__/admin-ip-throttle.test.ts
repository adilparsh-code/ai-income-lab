// Phase 14 regression: admin login rate limiting is attacker-IP-bound and
// bounded, and login still fails closed when the rate-limiter is unavailable.
// These tests drive the REAL POST /api/admin/session handler against a hermetic
// SQLite DB and an injectable counting rate-limit store, so they prove the
// observed production behavior deterministically.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-admin-ip-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});
delete process.env.DIRECT_URL;

before(async () => {
  execSync('npx prisma7 db push --schema=prisma/schema.test.prisma', {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: process.env,
  });
});
after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
});

const SAVED: Record<string, string | undefined> = {};
function setAdminEnv() {
  SAVED.ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  SAVED.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  SAVED.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
  SAVED.ADMIN_DISABLED = process.env.ADMIN_DISABLED;
  process.env.ADMIN_EMAIL = 'admin@aiincome.lab';
  process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_DISABLED;
}
function restoreAdminEnv() {
  for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'ADMIN_DISABLED']) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
}

import { __setRateLimitStoreForTests } from '@/lib/security/guard';
import { POST } from '@/app/api/admin/session/route';

function countingStore() {
  const counts = new Map<string, number>();
  return {
    upsert: async ({ bucketKey, windowKey, expiresAt }: { bucketKey: string; windowKey: string; expiresAt: Date }) => {
      const k = `${bucketKey}|${windowKey}`;
      const count = (counts.get(k) ?? 0) + 1;
      counts.set(k, count);
      return { count, expiresAt };
    },
  };
}

function loginRequest(ip: string, body: Record<string, unknown>) {
  return new Request('http://localhost/api/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('admin login: attacker-IP throttling and lockout protection', () => {
  before(setAdminEnv);
  beforeEach(() => __setRateLimitStoreForTests(null));
  afterEach(() => __setRateLimitStoreForTests(null));
  after(restoreAdminEnv);

  it('correct credentials succeed on the first attempt', async () => {
    __setRateLimitStoreForTests(countingStore());
    const res = await POST(loginRequest('203.0.113.1', {
      email: 'admin@aiincome.lab',
      password: 'correct-horse-battery-staple',
    }));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.authenticated, true);
  });

  it('wrong passwords fail with a generic 401', async () => {
    __setRateLimitStoreForTests(countingStore());
    const res = await POST(loginRequest('203.0.113.2', {
      email: 'admin@aiincome.lab',
      password: 'wrong-password-value',
    }));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Invalid credentials.');
  });

  it('a few failures do not block legitimate login later', async () => {
    __setRateLimitStoreForTests(countingStore());
    for (let i = 0; i < 3; i += 1) {
      const res = await POST(loginRequest('198.51.100.20', {
        email: 'admin@aiincome.lab',
        password: 'wrong-' + i,
      }));
      assert.equal(res.status, 401);
    }
    const good = await POST(loginRequest('203.0.113.99', {
      email: 'admin@aiincome.lab',
      password: 'correct-horse-battery-staple',
    }));
    assert.equal(good.status, 200, 'legitimate IP B can still authenticate');
    assert.equal((await good.json()).authenticated, true);
  });

  it('repeated failures from attacker IP A eventually throttle IP A only', async () => {
    __setRateLimitStoreForTests(countingStore());
    let blocked = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await POST(loginRequest('198.51.100.10', {
        email: 'admin@aiincome.lab',
        password: 'wrong-' + i,
      }));
      if (res.status === 429) blocked = true;
    }
    assert.equal(blocked, true, 'attacker IP A was eventually rate limited');
  });

  it('attacker IP A cannot impersonate legitimate IP B via headers', async () => {
    __setRateLimitStoreForTests(countingStore());
    for (let i = 0; i < 12; i += 1) {
      await POST(loginRequest('198.51.100.10', { email: 'x@y.z', password: 'wrong-' + i }));
    }
    const ipB = await POST(loginRequest('203.0.113.77', {
      email: 'admin@aiincome.lab',
      password: 'correct-horse-battery-staple',
    }));
    assert.equal(ipB.status, 200, 'IP B still authenticates after IP A was throttled');
    assert.equal((await ipB.json()).authenticated, true);
  });

  it('IP A cannot bypass throttling by claiming to be IP B via x-real-ip', async () => {
    __setRateLimitStoreForTests(countingStore());
    for (let i = 0; i < 12; i += 1) {
      await POST(loginRequest('198.51.100.10', { email: 'x@y.z', password: 'wrong-' + i }));
    }
    const spoofed = await POST(
      new Request('http://localhost/api/admin/session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.10',
          'x-real-ip': '203.0.113.77',
        },
        body: JSON.stringify({ email: 'admin@aiincome.lab', password: 'correct-horse-battery-staple' }),
      }),
    );
    assert.equal(spoofed.status, 429, 'spoofed IP B identity is not honored when x-forwarded-for is attacker A');
  });

  it('an attacker cannot permanently lock the admin account', async () => {
    __setRateLimitStoreForTests(countingStore());
    for (let i = 0; i < 50; i += 1) {
      await POST(loginRequest('198.51.100.10', { email: 'admin@aiincome.lab', password: 'wrong-' + i }));
    }
    const good = await POST(loginRequest('203.0.113.123', {
      email: 'admin@aiincome.lab',
      password: 'correct-horse-battery-staple',
    }));
    assert.equal(good.status, 200, 'admin account is not permanently locked by attacker attempts');
    assert.equal((await good.json()).authenticated, true);
  });

  it('missing or malformed IP is normalized to unknown and rate limited like any other IP', async () => {
    __setRateLimitStoreForTests(countingStore());
    for (let i = 0; i < 12; i += 1) {
      const res = await POST(
        new Request('http://localhost/api/admin/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '' },
          body: JSON.stringify({ email: 'admin@aiincome.lab', password: 'wrong-' + i }),
        }),
      );
      if (res.status === 429) {
        const later = await POST(loginRequest('203.0.113.99', {
          email: 'admin@aiincome.lab',
          password: 'correct-horse-battery-staple',
        }));
        assert.equal(later.status, 200, 'a real IP B can still authenticate after unknown-IP throttling');
        return;
      }
    }
    assert.fail('unknown-IP login should have been throttled');
  });

  it('rate-limiter storage failure fails closed on login', async () => {
    __setRateLimitStoreForTests({ upsert: async () => { throw new Error('db down'); } });
    const res = await POST(loginRequest('203.0.113.1', { email: 'admin@aiincome.lab', password: 'correct-horse-battery-staple' }));
    assert.equal(res.status, 429, 'when the rate limiter is unavailable, login fails closed (throttled)');
  });
});
