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
import { randomBytes, scryptSync } from 'node:crypto';

Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(mkdtempSync(join(tmpdir(), 'aill-lockout-')), 'unused.db'),
  NODE_ENV: 'test',
});

import {
  ACCOUNT_LOCKOUT,
  __setAccountLockStoreForTests,
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

describe('per-account lockout', () => {
  it('is not locked until maxFailures failures are recorded, then locks', async () => {
    __setAccountLockStoreForTests(memoryStore());
    for (let i = 0; i < ACCOUNT_LOCKOUT.maxFailures - 1; i += 1) {
      await recordAccountLoginFailure();
      assert.equal((await accountLockState()).locked, false);
    }
    await recordAccountLoginFailure();
    const verdict = await accountLockState();
    assert.equal(verdict.locked, true);
    assert.ok(verdict.locked && verdict.retryAfterSeconds >= 1);
  });

  it('checking the state does not consume attempts (read-only)', async () => {
    const store = memoryStore();
    __setAccountLockStoreForTests(store);
    for (let i = 0; i < 50; i += 1) await accountLockState();
    assert.equal(store.counts.size, 0);
  });

  it('fails CLOSED when the counter store is unavailable', async () => {
    __setAccountLockStoreForTests({
      read: async () => { throw new Error('db down'); },
      increment: async () => { throw new Error('db down'); },
    });
    const verdict = await accountLockState();
    assert.equal(verdict.locked, true);
    assert.ok(verdict.locked && verdict.unavailable === true);
  });

  it('recording a failure never throws even if storage is down', async () => {
    __setAccountLockStoreForTests({
      read: async () => null,
      increment: async () => { throw new Error('db down'); },
    });
    await assert.doesNotReject(() => recordAccountLoginFailure());
  });
});
