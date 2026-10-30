// ============================================================================
// N4 remainder — per-account lockout + plaintext-fallback migration switch
// ============================================================================
// Hermetic: no DB queries run. The lockout counter is exercised through its
// persistence seam, the credential logic through process.env.
// ============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';

Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(mkdtempSync(join(tmpdir(), 'aill-lockout-')), 'unused.db'),
  NODE_ENV: 'test',
});

import {
  __setAccountLockStoreForTests,
  accountLockout,
  accountLockState,
  adminCredentialMode,
  adminCredentialStatus,
  recordAccountLoginFailure,
  verifyAdminCredentials,
  type AccountLockStore,
} from '@/lib/agency/admin-auth';

const EMAIL = 'admin@aiincome.lab';
const PASSWORD = 'correct-horse-battery-staple'; // the SAME password in every mode below
const KEYS = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'ADMIN_REQUIRE_PASSWORD_HASH'] as const;
const SAVED: Record<string, string | undefined> = {};

function makeHash(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function memoryStore(): AccountLockStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async read({ bucketKey, windowKey }) {
      const c = counts.get(bucketKey + windowKey);
      return c === undefined ? null : { count: c, expiresAt: new Date(Date.now() + 60_000) };
    },
    async increment({ bucketKey, windowKey }) {
      counts.set(bucketKey + windowKey, (counts.get(bucketKey + windowKey) ?? 0) + 1);
    },
  };
}

beforeEach(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  process.env.ADMIN_EMAIL = EMAIL;
});
afterEach(() => {
  __setAccountLockStoreForTests(null);
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('credential mode — the password itself never has to change', () => {
  it('plaintext-only config keeps working by default (no surprise lockout on deploy)', () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    assert.equal(adminCredentialMode(), 'plaintext');
    assert.equal(adminCredentialStatus(), 'CONFIGURED');
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), true);
    assert.equal(verifyAdminCredentials(EMAIL, 'wrong-password-xx'), false);
  });

  it('the same password verifies against its scrypt hash', () => {
    process.env.ADMIN_PASSWORD_HASH = makeHash(PASSWORD);
    assert.equal(adminCredentialMode(), 'hash');
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), true);
    assert.equal(verifyAdminCredentials(EMAIL, 'wrong-password-xx'), false);
  });

  it('hash present: a stale ADMIN_PASSWORD is ignored (hash precedence)', () => {
    process.env.ADMIN_PASSWORD_HASH = makeHash('another-long-password-1');
    process.env.ADMIN_PASSWORD = PASSWORD;
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), false);
  });

  it('ADMIN_REQUIRE_PASSWORD_HASH disables the plaintext fallback (fail closed)', () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.ADMIN_REQUIRE_PASSWORD_HASH = 'true';
    assert.equal(adminCredentialMode(), 'none');
    assert.equal(adminCredentialStatus(), 'NOT_CONFIGURED');
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), false);
  });

  it('strict mode + hash of the same password: login still works', () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.ADMIN_PASSWORD_HASH = makeHash(PASSWORD);
    process.env.ADMIN_REQUIRE_PASSWORD_HASH = 'true';
    assert.equal(adminCredentialMode(), 'hash');
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), true);
  });
});

describe('hash verification fails CLOSED on malformed hashes', () => {
  // Regression: an empty / non-hex hash used to decode to a zero-length key and
  // timingSafeEqual(empty, empty) is true, so ANY password was accepted.
  const MALFORMED = [
    'scrypt:aa:', 'scrypt::', 'scrypt:zz:zz', 'scrypt:00:00', 'scrypt:aabbccdd:ee',
    'scrypt:aa', 'bcrypt:aa:bb', 'scrypt:' + 'a'.repeat(31) + ':' + 'b'.repeat(128),
    'scrypt:' + 'a'.repeat(32) + ':' + 'b'.repeat(8), 'scrypt:' + 'a'.repeat(32) + ':' + 'b'.repeat(127),
    `"${makeHash(PASSWORD)}"`, `ADMIN_PASSWORD_HASH=${makeHash(PASSWORD)}`,
  ];
  for (const bad of MALFORMED) {
    it(`rejects any password for malformed hash ${JSON.stringify(bad.slice(0, 36))}`, () => {
      process.env.ADMIN_PASSWORD_HASH = bad;
      assert.equal(verifyAdminCredentials(EMAIL, 'totally-wrong-password'), false);
      assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), false);
    });
  }

  it('a malformed hash is NOT rescued by a correct plaintext ADMIN_PASSWORD (no silent fallback)', () => {
    process.env.ADMIN_PASSWORD_HASH = 'scrypt:aa:';
    process.env.ADMIN_PASSWORD = PASSWORD;
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), false);
  });

  it('a hash generated by scripts/hash-admin-password.mjs verifies (algorithm/format match)', () => {
    const out = execFileSync('node', ['scripts/hash-admin-password.mjs'], { input: PASSWORD, cwd: process.cwd(), encoding: 'utf8' });
    const hash = /ADMIN_PASSWORD_HASH="([^"]+)"/.exec(out)?.[1] ?? '';
    assert.match(hash, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    process.env.ADMIN_PASSWORD_HASH = hash;
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD), true);
    assert.equal(verifyAdminCredentials(EMAIL, PASSWORD + 'x'), false);
    assert.equal(verifyAdminCredentials(' ' + EMAIL.toUpperCase() + ' ', PASSWORD), true);
  });
});

describe('failed-login lockout (per IP + account-wide)', () => {
  const IP = '198.51.100.7';
  const OTHER_IP = '198.51.100.8';
  const { ipMaxFailures, accountMaxFailures } = accountLockout();

  it('locks the attacking IP after ipMaxFailures, but NOT a different IP (owner stays in)', async () => {
    __setAccountLockStoreForTests(memoryStore());
    for (let i = 0; i < ipMaxFailures - 1; i += 1) {
      await recordAccountLoginFailure(IP);
      assert.equal((await accountLockState(IP)).locked, false);
    }
    await recordAccountLoginFailure(IP);
    const attacker = await accountLockState(IP);
    assert.equal(attacker.locked, true);
    assert.ok(attacker.locked && attacker.retryAfterSeconds >= 1);
    assert.equal((await accountLockState(OTHER_IP)).locked, false);
  });

  it('account-wide ceiling locks everyone when many different IPs fail', async () => {
    __setAccountLockStoreForTests(memoryStore());
    for (let i = 0; i < accountMaxFailures; i += 1) await recordAccountLoginFailure(`203.0.113.${i}`);
    assert.equal((await accountLockState('192.0.2.200')).locked, true);
  });

  it('env tuning is bounded: absurd values cannot disable the protection', () => {
    const saved = { ...process.env };
    try {
      process.env.LOGIN_LOCKOUT_IP_MAX_FAILURES = '100000';
      process.env.LOGIN_LOCKOUT_ACCOUNT_MAX_FAILURES = '999999';
      process.env.LOGIN_LOCKOUT_WINDOW_SECONDS = '1';
      const c = accountLockout();
      assert.equal(c.ipMaxFailures, 20);
      assert.equal(c.accountMaxFailures, 100);
      assert.equal(c.windowSeconds, 300);
      process.env.LOGIN_LOCKOUT_IP_MAX_FAILURES = '0';
      process.env.LOGIN_LOCKOUT_ACCOUNT_MAX_FAILURES = 'abc';
      assert.equal(accountLockout().ipMaxFailures, 5);
      assert.equal(accountLockout().accountMaxFailures, 20);
    } finally {
      for (const k of ['LOGIN_LOCKOUT_IP_MAX_FAILURES', 'LOGIN_LOCKOUT_ACCOUNT_MAX_FAILURES', 'LOGIN_LOCKOUT_WINDOW_SECONDS']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('checking the state does not consume attempts (read-only)', async () => {
    const store = memoryStore();
    __setAccountLockStoreForTests(store);
    for (let i = 0; i < 50; i += 1) await accountLockState(IP);
    assert.equal(store.counts.size, 0);
  });

  it('fails CLOSED when the counter store is unavailable', async () => {
    __setAccountLockStoreForTests({
      read: async () => { throw new Error('db down'); },
      increment: async () => { throw new Error('db down'); },
    });
    const verdict = await accountLockState(IP);
    assert.equal(verdict.locked, true);
    assert.ok(verdict.locked && verdict.unavailable === true);
  });

  it('recording a failure never throws even if storage is down', async () => {
    __setAccountLockStoreForTests({
      read: async () => null,
      increment: async () => { throw new Error('db down'); },
    });
    await assert.doesNotReject(() => recordAccountLoginFailure(IP));
  });
});
