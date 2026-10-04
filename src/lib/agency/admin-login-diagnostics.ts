// ============================================================================
// ADMIN LOGIN — NON-SECRET FAILURE CLASSIFIER (observability only)
// ============================================================================
// Called by POST /api/admin/session ONLY AFTER verifyAdminCredentials() has
// already returned false. It never decides whether a login succeeds and its
// result is written to SecurityEvent.detail only — never to the HTTP response.
//
// Output is a closed set of fixed strings. It never returns, logs, or embeds
// the email, password, hash, or any env value. Pure (no DB, no I/O) so it can
// be tested hermetically.
// ============================================================================

import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export type AdminLoginFailureReason =
  | 'admin-disabled'
  | 'no-credential-material'
  | 'email-mismatch'
  | 'hash-malformed'
  | 'password-mismatch'
  /** Fallback: missing input, or classifier could not explain the failure. */
  | 'bad-credentials';

type EnvLike = Record<string, string | undefined>;

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function textEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

const HEX = /^[0-9a-f]+$/i;

/** Structural check only: "scrypt:<hex>:<hex>". Never inspects the password. */
// Exact shape emitted by scripts/hash-admin-password.mjs: 16-byte salt (32 hex)
// and 64-byte scrypt key (128 hex). Applied to the SAME trimmed env value that
// verifyAdminCredentials() uses, so quotes, an "ADMIN_PASSWORD_HASH=" prefix,
// or inner whitespace all fail here.
// NOTE: verifyScryptHash() itself is looser (it accepts any hex lengths); this
// classifier is stricter on purpose, so a non-standard hash that fails verify
// is reported as hash-malformed rather than password-mismatch.
const SALT_HEX = /^[0-9a-f]{32}$/i;
const HASH_HEX = /^[0-9a-f]{128}$/i;

/** Structural check only: "scrypt:<32 hex>:<128 hex>". Never inspects the password. */
function hashIsWellFormed(stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  return (
    HEX.test(saltHex) && saltHex.length % 2 === 0 &&
    HEX.test(hashHex) && hashHex.length % 2 === 0
  );
  return SALT_HEX.test(saltHex) && HASH_HEX.test(hashHex);
}

function scryptMatches(password: string, stored: string): boolean {
  try {
    const [, saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function classifyAdminLoginFailure(
  email: string | null,
  password: string | null,
  env: EnvLike = process.env,
): AdminLoginFailureReason {
  try {
    const disabled = env.ADMIN_DISABLED?.trim().toLowerCase();
    if (disabled === '1' || disabled === 'true' || disabled === 'yes' || disabled === 'on') {
      return 'admin-disabled';
    }

    if (!email || !password) return 'bad-credentials';

    const expectedEmail = env.ADMIN_EMAIL?.trim() ?? '';
    const hash = env.ADMIN_PASSWORD_HASH?.trim();
    const plain = env.ADMIN_PASSWORD?.trim();
    if (expectedEmail.length === 0 || (!hash && !plain)) return 'no-credential-material';

    if (!textEquals(email.trim().toLowerCase(), expectedEmail.toLowerCase())) return 'email-mismatch';

    // Same precedence as verifyAdminCredentials: a configured hash wins and
    // ADMIN_PASSWORD is never consulted as a fallback.
    if (hash) {
      if (!hashIsWellFormed(hash)) return 'hash-malformed';
      return scryptMatches(password, hash) ? 'bad-credentials' : 'password-mismatch';
    }

    return textEquals(password, plain as string) ? 'bad-credentials' : 'password-mismatch';
  } catch {
    return 'bad-credentials';
  }
}
