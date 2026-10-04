// Pure, hermetic tests (no DB, no network) for the non-secret login failure
// classifier. Uses dummy values only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { classifyAdminLoginFailure } from '../admin-login-diagnostics';

const EMAIL = 'admin@example.test';
const PASSWORD = 'dummy-password-for-tests';

function makeHash(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

describe('classifyAdminLoginFailure (non-secret reasons)', () => {
  it('admin-disabled when kill-switch is set', () => {
    const env = { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD, ADMIN_DISABLED: 'true' };
    assert.equal(classifyAdminLoginFailure(EMAIL, PASSWORD, env), 'admin-disabled');
  });

  it('no-credential-material when ADMIN_EMAIL or all password material is missing', () => {
    assert.equal(classifyAdminLoginFailure(EMAIL, PASSWORD, { ADMIN_PASSWORD: PASSWORD }), 'no-credential-material');
    assert.equal(classifyAdminLoginFailure(EMAIL, PASSWORD, { ADMIN_EMAIL: EMAIL }), 'no-credential-material');
    assert.equal(
      classifyAdminLoginFailure(EMAIL, PASSWORD, { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: '   ', ADMIN_PASSWORD_HASH: ' ' }),
      'no-credential-material',
    );
  });

  it('email-mismatch for a different email (case/whitespace-normalised like verify)', () => {
    const env = { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD };
    assert.equal(classifyAdminLoginFailure('other@example.test', PASSWORD, env), 'email-mismatch');
    assert.equal(classifyAdminLoginFailure('  ADMIN@EXAMPLE.TEST ', 'wrong-password-xx', env), 'password-mismatch');
  });

  it('password-mismatch for plaintext and for a well-formed hash', () => {
    assert.equal(
      classifyAdminLoginFailure(EMAIL, 'wrong-password-xx', { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD }),
      'password-mismatch',
    );
    assert.equal(
      classifyAdminLoginFailure(EMAIL, 'wrong-password-xx', { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD_HASH: makeHash(PASSWORD) }),
      'password-mismatch',
    );
  });

  it('hash-malformed for quoted, prefixed, wrong-prefix, non-hex, and wrong-part-count values', () => {
    const good = makeHash(PASSWORD);
    const bad = [
      `"${good}"`,
      `ADMIN_PASSWORD_HASH=${good}`,
      good.replace('scrypt:', 'bcrypt:'),
      good.replace(/.$/, 'z'),
      'scrypt:abcd',
      'not-a-hash',
    ];
    for (const hash of bad) {
      assert.equal(
        classifyAdminLoginFailure(EMAIL, PASSWORD, { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD_HASH: hash }),
        'hash-malformed',
        'malformed hash should be classified',
      );
    }
  });

  it('a malformed hash is NOT rescued by a correct ADMIN_PASSWORD (hash precedence preserved)', () => {
    const env = { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD, ADMIN_PASSWORD_HASH: `"${makeHash(PASSWORD)}"` };
    assert.equal(classifyAdminLoginFailure(EMAIL, PASSWORD, env), 'hash-malformed');
  });

  it('falls back to bad-credentials for missing input', () => {
    const env = { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD };
    assert.equal(classifyAdminLoginFailure(null, PASSWORD, env), 'bad-credentials');
    assert.equal(classifyAdminLoginFailure(EMAIL, null, env), 'bad-credentials');
  });

  it('never leaks email, password, or hash material in any returned reason', () => {
    const hash = makeHash(PASSWORD);
    const envs = [
      { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD_HASH: hash },
      { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD_HASH: `"${hash}"` },
      { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD },
    ];
    for (const env of envs) {
      for (const [e, p] of [[EMAIL, 'wrong-password-xx'], ['x@example.test', PASSWORD]] as const) {
        const reason = classifyAdminLoginFailure(e, p, env);
        assert.match(reason, /^[a-z]+(-[a-z]+)*$/);
        for (const secret of [EMAIL, PASSWORD, hash, 'wrong-password-xx']) {
          assert.equal(reason.includes(secret), false);
        }
      }
    }
  });
});
