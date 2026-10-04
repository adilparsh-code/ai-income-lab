// ============================================================================
// SINGLE-ADMIN LOGIN — deterministic hermetic tests
// ============================================================================
// Exercises the REAL login/logout/status route handlers and the REAL session
// core (admin-auth.ts / session-guard.ts) against a temporary SQLite
// database. The admin identity is bootstrapped exactly as in production: via
// environment variables — no plaintext fixtures, no fake success paths, and
// no second auth system under test.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-admin-login-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

delete process.env.DIRECT_URL;

before(async () => {
  // Pin the v7 CLI (same convention as the other hermetic suites): the default
  // `prisma` binary's Prisma 8 "agent skills" gate fails non-interactive runs.
  execSync('npx prisma7 db push --schema=prisma/schema.test.prisma', {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: process.env,
  });
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

// ---------------------------------------------------------------------------
// Env bootstrap helpers — always restored in finally so tests stay ordered.
// ---------------------------------------------------------------------------

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

function clearAdminEnv() {
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_DISABLED;
}

function restoreAdminEnv() {
  for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'ADMIN_DISABLED']) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
}

function loginRequest(body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

let sessionRoute: typeof import('../../../app/api/admin/session/route');
let adminAuth: typeof import('../../../lib/agency/admin-auth');
let guard: typeof import('../../../lib/security/guard');

before(async () => {
  sessionRoute = await import('../../../app/api/admin/session/route');
  adminAuth = await import('../../../lib/agency/admin-auth');
  guard = await import('../../../lib/security/guard');
});

// ---------------------------------------------------------------------------

describe('single-admin login (hermetic DB)', () => {
  it('fails closed with 503 when credentials are NOT_CONFIGURED', async () => {
    clearAdminEnv();
    try {
      const res = await sessionRoute.POST(loginRequest({ email: 'x@y.z', password: 'whatever' }));
      assert.equal(res.status, 503);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.error, /NOT_CONFIGURED/);
    } finally {
      restoreAdminEnv();
    }
  });

  it('valid admin credentials succeed and set an httpOnly session cookie', async () => {
    setAdminEnv();
    try {
      const res = await sessionRoute.POST(loginRequest({ email: 'admin@aiincome.lab', password: 'correct-horse-battery-staple' }));
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.authenticated, true);
      const cookie = res.headers.get('set-cookie') ?? '';
      assert.match(cookie, /aill_admin_session=/);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      // The raw token must never appear in the response body.
      const token = /aill_admin_session=([^;]+)/.exec(cookie)?.[1] ?? '';
      assert.ok(token.length > 0);
      assert.equal(JSON.stringify(json).includes(token), false);
    } finally {
      restoreAdminEnv();
    }
  });

  it('invalid password fails with a generic 401 (no oracle)', async () => {
    setAdminEnv();
    try {
      const res = await sessionRoute.POST(loginRequest({ email: 'admin@aiincome.lab', password: 'wrong-password-value' }));
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.error, 'Invalid credentials.');
      assert.equal(JSON.stringify(json).toLowerCase().includes('password'), false);
    } finally {
      restoreAdminEnv();
    }
  });

  it('unknown email fails with the SAME generic 401 (no account oracle)', async () => {
    setAdminEnv();
    try {
      const wrongEmail = await sessionRoute.POST(loginRequest({ email: 'nobody@else.where', password: 'correct-horse-battery-staple' }));
      const wrongPassword = await sessionRoute.POST(loginRequest({ email: 'admin@aiincome.lab', password: 'wrong-password-value' }));
      assert.equal(wrongEmail.status, 401);
      assert.equal(wrongPassword.status, 401);
      const a = await wrongEmail.json();
      const b = await wrongPassword.json();
      assert.equal(a.error, b.error); // indistinguishable refusals
    } finally {
      restoreAdminEnv();
    }
  });

  it('missing credentials fail without throwing internals', async () => {
    setAdminEnv();
    try {
      const noEmail = await sessionRoute.POST(loginRequest({ password: 'x'.repeat(16) }));
      const noPassword = await sessionRoute.POST(loginRequest({ email: 'admin@aiincome.lab' }));
      for (const res of [noEmail, noPassword]) {
        assert.equal(res.status, 401);
        const json = await res.json();
        assert.equal(json.ok, false);
        assert.equal(typeof json.error, 'string');
      }
    } finally {
      restoreAdminEnv();
    }
  });

  it('DISABLED admin cannot log in and the response matches bad-credentials', async () => {
    setAdminEnv();
    process.env.ADMIN_DISABLED = 'true';
    try {
      const res = await sessionRoute.POST(loginRequest({ email: 'admin@aiincome.lab', password: 'correct-horse-battery-staple' }));
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.error, 'Invalid credentials.');
    } finally {
      restoreAdminEnv();
    }
  });

  it('malformed JSON body is refused without leaking internals', async () => {
    setAdminEnv();
    try {
      const res = await sessionRoute.POST(
        new Request('http://localhost/api/admin/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        }),
      );
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(typeof json.error, 'string');
      assert.equal(json.error.includes('prisma'), false);
      assert.equal(json.error.toLowerCase().includes('sql'), false);
    } finally {
      restoreAdminEnv();
    }
  });
});

describe('session lifecycle (hermetic DB)', () => {
  it('login → status shows authenticated → logout invalidates → status unauthenticated', async () => {
    setAdminEnv();
    try {
      const login = await sessionRoute.POST(loginRequest({ email: 'admin@aiincome.lab', password: 'correct-horse-battery-staple' }));
      assert.equal(login.status, 200);
      const cookie = (login.headers.get('set-cookie') ?? '').match(/aill_admin_session=([^;]+)/)?.[1] ?? '';
      assert.ok(cookie.length > 0);

      const authedGet = new Request('http://localhost/api/admin/session', {
        headers: { cookie: `aill_admin_session=${cookie}` },
      });
      const statusAuthed = await sessionRoute.GET(authedGet);
      const statusAuthedJson = await statusAuthed.json();
      assert.equal(statusAuthedJson.authenticated, true);
      assert.equal(statusAuthedJson.email, 'admin@aiincome.lab');

      const logoutReq = new Request('http://localhost/api/admin/session', {
        method: 'DELETE',
        headers: { cookie: `aill_admin_session=${cookie}` },
      });
      const logout = await sessionRoute.DELETE(logoutReq);
      assert.equal(logout.status, 200);
      const logoutJson = await logout.json();
      assert.equal(logoutJson.loggedOut, true);
      assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/i);

      const statusAfter = await sessionRoute.GET(authedGet);
      const statusAfterJson = await statusAfter.json();
      assert.equal(statusAfterJson.authenticated, false);
    } finally {
      restoreAdminEnv();
    }
  });

  it('expired sessions are never accepted (absolute expiry enforced)', async () => {
    setAdminEnv();
    try {
      const { token, session } = await adminAuth.createAdminSession('admin@aiincome.lab', 'test:expiry');
      assert.ok(token.length > 0);
      assert.ok(session.expiresAt.getTime() > Date.now());
      // Age the row past its expiry directly in the temp database.
      type TestDb = { adminSession: { update: (args: { where: { id: string }; data: { expiresAt: Date } }) => Promise<unknown> }; $disconnect: () => Promise<void> };
      const { PrismaLibSql } = await import('@prisma/adapter-libsql');
      const { PrismaClient } = await import('../../../../prisma/test-client');
      const client = new PrismaClient({ adapter: new PrismaLibSql({ url: process.env.DATABASE_URL ?? '' }) }) as unknown as TestDb;
      try {
        await client.adminSession.update({
          where: { id: session.sessionId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      } finally {
        await client.$disconnect();
      }
      const resolved = await adminAuth.resolveAdminSession(token);
      assert.equal(resolved, null);
    } finally {
      restoreAdminEnv();
    }
  });

  it('guard rejects tokens that are unknown, oversized, or absent', async () => {
    setAdminEnv();
    try {
      assert.equal(await adminAuth.resolveAdminSession(null), null);
      assert.equal(await adminAuth.resolveAdminSession(''), null);
      assert.equal(await adminAuth.resolveAdminSession('x'.repeat(300)), null);
      assert.equal(await adminAuth.resolveAdminSession('not-a-real-session-token'), null);
    } finally {
      restoreAdminEnv();
    }
  });

  it('DISABLED admin invalidates live sessions server-side (kill-switch)', async () => {
    setAdminEnv();
    try {
      const { token } = await adminAuth.createAdminSession('admin@aiincome.lab', 'test:killswitch');
      assert.notEqual(await adminAuth.resolveAdminSession(token), null);
      process.env.ADMIN_DISABLED = '1';
      try {
        assert.equal(await adminAuth.resolveAdminSession(token), null);
      } finally {
        delete process.env.ADMIN_DISABLED;
      }
      assert.notEqual(await adminAuth.resolveAdminSession(token), null);
    } finally {
      restoreAdminEnv();
    }
  });
});

describe('authorization gates (hermetic DB)', () => {
  it('unauthenticated admin-API access is rejected with 401', async () => {
    setAdminEnv();
    try {
      const controlRoute = await import('../../../app/api/agency/control/route');
      const res = await controlRoute.GET(new Request('http://localhost/api/agency/control'));
      assert.equal(res.status, 401);
    } finally {
      restoreAdminEnv();
    }
  });

  it('authenticated admin passes requireAdminApi; unauthenticated job lookup is 401', async () => {
    setAdminEnv();
    try {
      const { token } = await adminAuth.createAdminSession('admin@aiincome.lab', 'test:api-gate');
      const jobRoute = await import('../../../app/api/jobs/[id]/route');
      const unauth = await jobRoute.GET(new Request('http://localhost/api/jobs/abc'), { params: Promise.resolve({ id: 'abc' }) });
      assert.equal(unauth.status, 401);

      const authed = await jobRoute.GET(
        new Request('http://localhost/api/jobs/abc', { headers: { cookie: `aill_admin_session=${token}` } }),
        { params: Promise.resolve({ id: 'abc' }) },
      );
      assert.equal(authed.status, 404); // authenticated → past the gate, job id unknown
    } finally {
      restoreAdminEnv();
    }
  });

  it('admin gate allows the configured admin and rejects everyone else (fail-closed)', async () => {
    setAdminEnv();
    try {
      const { requireAdminApi } = await import('../../../lib/agency/session-guard');
      const session = await adminAuth.createAdminSession('admin@aiincome.lab', 'test:page-gate');
      // Only the fingerprint-backed session is a valid identity; there is no
      // role escalation path: any other token simply resolves to nothing.
      const resolved = await adminAuth.resolveAdminSession(session.token);
      assert.equal(resolved?.email, 'admin@aiincome.lab');
      // requireAdminApi with an explicit Request is the unit-testable form of
      // the same guard the (admin) layout uses via currentAdminSession().
      const authed = await requireAdminApi(new Request('http://localhost/api/agency/control', {
        headers: { cookie: `aill_admin_session=${session.token}` },
      }));
      assert.equal('response' in authed ? true : false, false);
      assert.equal((authed as { session: { email: string } }).session.email, 'admin@aiincome.lab');
      const unauthed = await requireAdminApi(new Request('http://localhost/api/agency/control'));
      assert.equal('response' in unauthed ? true : false, true);
      assert.equal((unauthed as { response: Response }).response.status, 401);
    } finally {
      restoreAdminEnv();
    }
  });
});

describe('route surface & secret hygiene (static, deterministic)', () => {
  const read = (p: string): string => readFileSync(p, 'utf8');

  it('public registration does not exist (no register/signup pages or auth routes)', () => {
    const appDir = 'src/app';
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/page\.tsx$|route\.ts$/.test(entry)) offenders.push(p);
      }
    };
    walk(appDir);
    assert.equal(offenders.some((p) => /register|signup|sign-up/i.test(p)), false);
    assert.equal(readdirSync('src/app/api').includes('auth'), false);
  });

  it('auth secrets are never read through NEXT_PUBLIC_* anywhere in src', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry === 'node_modules' || entry === '.next' || entry === '.git') return;
          walk(p);
        } else if (/\.tsx?$/.test(entry)) offenders.push(p);
      }
    };
    walk('src');
    const bad = offenders
      .map((f) => ({ f, text: read(f) }))
      .filter(({ text }) => /NEXT_PUBLIC_[A-Z0-9_]*(ADMIN|PASSWORD|SESSION|TOKEN|SECRET)/.test(text));
    assert.deepEqual(bad, []);
  });

  it('login does not leak internals: error strings are generic', async () => {
    setAdminEnv();
    try {
      const bad = await sessionRoute.POST(loginRequest({ email: 'admin@aiincome.lab', password: 'nope-nope-nope' }));
      const json = await bad.json();
      const serialized = JSON.stringify(json).toLowerCase();
      for (const banned of ['stack', 'prisma', 'sqlite', 'scrypt', 'salt', 'hash:']) {
        assert.equal(serialized.includes(banned), false, `leaked "${banned}"`);
      }
    } finally {
      restoreAdminEnv();
    }
  });

  it('public endpoints remain public: health, login page, webhook route exist unwalled', () => {
    // Health + webhook stay outside the (admin) group by construction.
    assert.equal(statSync('src/app/api/health/route.ts').isFile(), true);
    assert.equal(statSync('src/app/api/webhooks/polar/route.ts').isFile(), true);
    assert.equal(statSync('src/app/login/page.tsx').isFile(), true);
    // Every console page lives inside the server-gated route group.
    const gated = readdirSync('src/app/(admin)').filter((e) => e !== 'layout.tsx');
    assert.ok(gated.length >= 12, `expected the gated group to hold the console pages, found: ${gated.join(',')}`);
  });

  it('middleware cannot loop: no (admin)/login or /api path rewriting exists', () => {
    const mw = read('src/middleware.ts');
    assert.equal(mw.includes('NextResponse.redirect('), false);
    assert.equal(mw.includes("rewrite("), false);
  });

  it('the (admin) layout gates server-side and the gate is not client-side only', () => {
    const layout = read('src/app/(admin)/layout.tsx');
    assert.match(layout, /currentAdminSession/);
    assert.match(layout, /AdminLoginGate/);
    assert.match(layout, /force-dynamic/);
    const gate = read('src/components/agents/admin-login-gate.tsx');
    assert.equal(gate.includes("'use client'"), false); // server component
  });

  it('cookie policy: httpOnly + SameSite + Secure-in-production + path', () => {
    const route = read('src/app/api/admin/session/route.ts');
    assert.match(route, /httpOnly: true/);
    assert.match(route, /sameSite: 'lax'/);
    assert.match(route, /secure: process\.env\.NODE_ENV === 'production'/);
    assert.match(route, /path: '\//);
  });

  it('operator token and admin password are never logged (audit events carry outcomes only)', () => {
    const sessionRoute = read('src/app/api/admin/session/route.ts');
    assert.equal(/console\.(log|info|debug|error|warn)/.test(sessionRoute), false);
    assert.match(sessionRoute, /auditAdminEvent\('ADMIN_LOGIN', 'refused', classifyAdminLoginFailure\(email, password\)\)/);
    // No logging call anywhere in src passes ADMIN_PASSWORD or a cookie value.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry === 'node_modules' || entry === '.next' || entry === '.git') return;
          walk(p);
        } else if (/\.tsx?$/.test(entry)) offenders.push(p);
      }
    };
    walk('src');
    const bad = offenders
      .map((f) => ({ f, text: read(f) }))
      .filter(({ text }) => /console\.(log|info|debug|error|warn)\([^)]*(ADMIN_PASSWORD|PASSWORD_HASH|aill_admin_session)/.test(text));
    assert.deepEqual(bad, []);
  });

  it('guard.ts exports the audited primitives reused by this flow', () => {
    assert.equal(typeof guard.clientIpFrom, 'function');
    assert.equal(typeof guard.credentialFingerprint, 'function');
  });
});
