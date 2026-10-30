// ============================================================================
// LOGIN LOCKOUT — REAL-STORE CONCURRENCY (database-backed)
// ============================================================================
// Unlike admin-lockout-and-hash-mode.test.ts (in-memory store), these tests run
// the DEFAULT Prisma-backed AccountLockStore (atomic upsert-increment with a
// one-shot retry for the first-hit unique-constraint race, and updateMany
// decrement for refunds) against an isolated temporary SQLite/libSQL database
// created from prisma/schema.test.prisma — the same setup as admin-login.test.ts.
//
// What this proves: with REAL parallel database traffic, no increment is lost,
// no concurrent first request makes the store throw (which would deny login as
// "unavailable"), and the number of admitted attempts is exactly the configured
// limit. What it does NOT prove: behaviour on the production PostgreSQL engine
// (this runs on libSQL), where lock/upsert semantics differ.
//
// Isolation: bucket keys embed the window length ("<start>-<windowSeconds>"),
// so every test uses its own LOGIN_LOCKOUT_WINDOW_SECONDS value and therefore
// its own counters. Each test also waits until it is safely inside a window so
// a window rollover cannot split its counts.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-lockout-db-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});
delete process.env.DIRECT_URL;

const WINDOW_ENV = 'LOGIN_LOCKOUT_WINDOW_SECONDS';
let savedWindow: string | undefined;

let adminAuth: typeof import('@/lib/agency/admin-auth');
let guard: typeof import('@/lib/security/guard');
let db: typeof import('@/lib/db').db;

before(async () => {
  execSync('npx prisma7 db push --schema=prisma/schema.test.prisma', {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: process.env,
  });
  adminAuth = await import('@/lib/agency/admin-auth');
  guard = await import('@/lib/security/guard');
  ({ db } = await import('@/lib/db'));
  savedWindow = process.env[WINDOW_ENV];
});

after(() => {
  if (savedWindow === undefined) delete process.env[WINDOW_ENV];
  else process.env[WINDOW_ENV] = savedWindow;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

// Bucket-key layout is internal to admin-auth.ts; coupling here is deliberate:
// if it is renamed these tests fail loudly instead of silently reading nothing.
const ipBucket = (ip: string) => 'admin-lockout-ip|' + guard.credentialFingerprint(`ip:${ip}`);
const accountBucket = () => 'admin-lockout-account|' + guard.credentialFingerprint('admin-account');

/** Sum of this bucket's counter for the CURRENT test's window length only. */
async function counted(bucketKey: string): Promise<number> {
  const suffix = `-${process.env[WINDOW_ENV]}`;
  const rows = await db.rateLimitWindow.findMany({ where: { bucketKey } });
  return rows
    .filter((row: { windowKey: string }) => row.windowKey.endsWith(suffix))
    .reduce((sum: number, row: { count: number }) => sum + row.count, 0);
}

/** Use a test-specific window length and start only when >= 15s remain in it. */
async function useWindow(seconds: number): Promise<void> {
  process.env[WINDOW_ENV] = String(seconds);
  const nowMs = Date.now();
  const remainingMs = seconds * 1000 - (nowMs % (seconds * 1000));
  if (remainingMs < 15_000) await new Promise((resolve) => setTimeout(resolve, remainingMs + 500));
}

describe('lockout store against a real database', () => {
  it('FIRST-HIT RACE: 60 parallel first requests from a fresh IP — none throw, none lost, exactly ipMax admitted', async () => {
    await useWindow(600);
    const { ipMaxFailures } = adminAuth.accountLockout();
    const ip = '198.51.100.10';
    const verdicts = await Promise.all(Array.from({ length: 60 }, () => adminAuth.reserveLoginAttempt(ip)));

    assert.equal(verdicts.filter((v) => !v.allowed && v.unavailable).length, 0, 'a lost first-hit race must be retried, not surface as "unavailable"');
    assert.equal(verdicts.filter((v) => v.allowed).length, ipMaxFailures);
    assert.equal(await counted(ipBucket(ip)), 60, 'every one of the 60 reservations was counted exactly once');
    // Only the admitted attempts may ever reach the account-wide bucket.
    assert.equal(await counted(accountBucket()), ipMaxFailures);
  });

  it('account-wide ceiling under parallel load from many IPs: exactly accountMax admitted, every reservation counted', async () => {
    await useWindow(601);
    const { accountMaxFailures } = adminAuth.accountLockout();
    const ips = Array.from({ length: 80 }, (_, i) => `203.0.113.${i + 1}`);
    const verdicts = await Promise.all(ips.map((ip) => adminAuth.reserveLoginAttempt(ip)));

    assert.equal(verdicts.filter((v) => !v.allowed && v.unavailable).length, 0);
    assert.equal(verdicts.filter((v) => v.allowed).length, accountMaxFailures);
    assert.equal(await counted(accountBucket()), 80, 'each of the 80 IPs passed the per-IP layer and was counted at account level');
  });

  it('refund after success decrements exactly one, never below zero, and keeps prior failures', async () => {
    await useWindow(602);
    const ip = '192.0.2.50';
    // three earlier FAILED attempts stay counted...
    for (let i = 0; i < 3; i += 1) assert.equal((await adminAuth.reserveLoginAttempt(ip)).allowed, true);
    // ...then a fourth attempt that SUCCEEDS is refunded.
    assert.equal((await adminAuth.reserveLoginAttempt(ip)).allowed, true);
    await adminAuth.refundLoginAttempt(ip);
    assert.equal(await counted(ipBucket(ip)), 3, 'only the successful attempt was given back');
    assert.equal(await counted(accountBucket()), 3);

    // Refunding an IP with nothing reserved must not drive ITS counter negative.
    // (Contract: callers refund only after a granted reservation, as the login
    // route does; an unmatched refund is not something the route can produce.)
    const empty = '192.0.2.51';
    await adminAuth.refundLoginAttempt(empty);
    await adminAuth.refundLoginAttempt(empty);
    assert.equal(await counted(ipBucket(empty)), 0);
  });

  it('parallel refunds never over-refund below the true count', async () => {
    await useWindow(603);
    const ip = '192.0.2.60';
    for (let i = 0; i < 4; i += 1) await adminAuth.reserveLoginAttempt(ip);
    await Promise.all(Array.from({ length: 10 }, () => adminAuth.refundLoginAttempt(ip)));
    assert.equal(await counted(ipBucket(ip)), 0, '10 refunds against 4 reservations floor at 0');
  });
});
