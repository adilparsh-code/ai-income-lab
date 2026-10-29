// ============================================================================
// AGENCY — SINGLE-ADMIN AUTH (Phase 1)
// ============================================================================
// AI Income Lab has NO public users and NO signup. Exactly one administrator
// exists, defined entirely by server-side environment configuration:
//
//   ADMIN_EMAIL          — the single admin identity (any non-empty string is
//                          accepted as the identity; it is never a secret).
//   ADMIN_PASSWORD_HASH  — scrypt hash "scrypt:<saltHex>:<hashHex>" generated
//                          by scripts/hash-admin-password.mjs (preferred).
//   ADMIN_PASSWORD       — bootstrap plaintext fallback (dev/bootstrap only).
//                          NEVER committed; fail-closed when neither is set.
//                          Ignored when ADMIN_PASSWORD_HASH is set, and ignored
//                          entirely when ADMIN_REQUIRE_PASSWORD_HASH is truthy.
//
// Sessions are durable rows in AdminSession. The cookie carries an opaque
// random token; only a keyed HMAC fingerprint of the token is stored, so a
// stolen database dump cannot mint valid cookies. Expiry is absolute (default
// 12h, bounded). Every login/logout is audited via auditSecurityEvent.
//
// There is deliberately NO user table, NO registration endpoint, and NO
// second authentication architecture — this composes the existing security
// primitives (constant-time comparison, fingerprinting, audit) from
// src/lib/security/guard.ts.
// ============================================================================

import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { auditSecurityEvent, credentialFingerprint } from '@/lib/security/guard';

export const ADMIN_SESSION_COOKIE = 'aill_admin_session';
/** Absolute session lifetime. Bounded: 30 minutes .. 7 days. */
export const ADMIN_SESSION_TTL_MS = boundedTtl(
  Number(process.env.ADMIN_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),
);

function boundedTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 12 * 60 * 60 * 1000;
  return Math.min(7 * 24 * 60 * 60 * 1000, Math.max(30 * 60 * 1000, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Credential verification (server-side only, constant time)
// ---------------------------------------------------------------------------

function verifyScryptHash(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export type AdminCredentialStatus = 'CONFIGURED' | 'NOT_CONFIGURED';
export type AdminCredentialMode = 'hash' | 'plaintext' | 'none';

function truthyEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Which credential material is actually in force. The hash always wins. The
 * plaintext fallback is honoured only until the operator opts into strict mode
 * with ADMIN_REQUIRE_PASSWORD_HASH=true (migration switch: it can only REMOVE
 * a weaker path, never add one, and it never changes the password itself).
 */
export function adminCredentialMode(): AdminCredentialMode {
  if (process.env.ADMIN_PASSWORD_HASH?.trim()) return 'hash';
  if (truthyEnv('ADMIN_REQUIRE_PASSWORD_HASH')) return 'none';
  if (process.env.ADMIN_PASSWORD?.trim()) return 'plaintext';
  return 'none';
}

/**
 * Kill-switch: when ADMIN_DISABLED is set to a truthy value, the single
 * administrator account is treated as DISABLED — login is refused and every
 * existing session fails closed on its next request. Fail-safe direction:
 * the flag can only ever REMOVE access, never grant it. This is the only
 * "account status" in the single-admin model (there is no User table).
 */
export function adminDisabled(): boolean {
  const raw = process.env.ADMIN_DISABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Truthful readiness of the admin credential configuration. */
export function adminCredentialStatus(): AdminCredentialStatus {
  return adminCredentialMode() === 'none' ? 'NOT_CONFIGURED' : 'CONFIGURED';
}

/**
 * Verify presented credentials against the server-side configuration.
 * Fail-closed: with no configured credential, verification always fails.
 * The comparison is constant-time; failures are audited by the caller.
 */
export function verifyAdminCredentials(email: string | null, password: string | null): boolean {
  if (!email || !password) return false;
  const expectedEmail = process.env.ADMIN_EMAIL?.trim() ?? '';
  if (expectedEmail.length === 0) return false;
  if (!constantTimeTextEquals(email.trim().toLowerCase(), expectedEmail.toLowerCase())) return false;

  const mode = adminCredentialMode();
  if (mode === 'hash') return verifyScryptHash(password, process.env.ADMIN_PASSWORD_HASH!.trim());
  if (mode === 'plaintext') return constantTimeTextEquals(password, process.env.ADMIN_PASSWORD!.trim());

  return false; // nothing configured (or plaintext disallowed) → fail closed
}

function constantTimeTextEquals(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const dbh = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, dbh);
}

// ---------------------------------------------------------------------------
// Sessions (DB-backed, opaque token, fingerprint stored)
// ---------------------------------------------------------------------------

export type AdminSessionInfo = {
  sessionId: string;
  email: string;
  expiresAt: Date;
};

/** Create a durable session row; returns the opaque cookie token (once). */
export async function createAdminSession(
  email: string,
  context: string,
): Promise<{ token: string; session: AdminSessionInfo }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS);
  const row = await db.adminSession.create({
    data: {
      tokenFingerprint: sessionFingerprint(token),
      email: email.slice(0, 120),
      expiresAt,
      createdBy: context.slice(0, 120),
    },
  });
  return { token, session: { sessionId: row.id, email, expiresAt } };
}

function sessionFingerprint(token: string): string {
  return credentialFingerprint(`admin-session:${token}`);
}

/**
 * Resolve a presented cookie token to a live session. Expired rows are never
 * accepted (and opportunistically pruned). Unknown tokens return null.
 */
export async function resolveAdminSession(token: string | null | undefined): Promise<AdminSessionInfo | null> {
  if (adminDisabled()) return null; // account DISABLED → all sessions fail closed
  if (!token || token.length === 0 || token.length > 256) return null;
  try {
    const row = await db.adminSession.findUnique({
      where: { tokenFingerprint: sessionFingerprint(token) },
    });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await db.adminSession.delete({ where: { id: row.id } }).catch(() => undefined);
      return null;
    }
    // Sliding last-seen for observability; never extends absolute expiry.
    await db.adminSession.update({
      where: { id: row.id },
      data: { lastSeenAt: new Date() },
    }).catch(() => undefined);
    return { sessionId: row.id, email: row.email, expiresAt: row.expiresAt };
  } catch {
    return null; // DB unavailable → fail closed for protected pages
  }
}

/**
 * True when the session row still exists, has not expired, and the admin
 * account is not disabled. Used to re-verify an approver at the moment an
 * approval is consumed (logout/expiry/disable between issue and use revokes it).
 */
export async function isAdminSessionLive(sessionId: string): Promise<boolean> {
  if (adminDisabled()) return false;
  if (!sessionId || sessionId.length > 128) return false;
  try {
    const row = await db.adminSession.findUnique({ where: { id: sessionId } });
    return Boolean(row && row.expiresAt.getTime() > Date.now());
  } catch {
    return false; // fail closed
  }
}

/** Revoke one session (logout). Audited by the route. */
export async function revokeAdminSession(token: string): Promise<boolean> {
  try {
    const row = await db.adminSession.findUnique({
      where: { tokenFingerprint: sessionFingerprint(token) },
    });
    if (!row) return false;
    await db.adminSession.delete({ where: { id: row.id } });
    return true;
  } catch {
    return false;
  }
}

/** Login rate limiting: 10 attempts / 5 min per IP (DB-backed, shared). */
export const LOGIN_RATE_LIMIT = { max: 10, windowSeconds: 300 } as const;

// ---------------------------------------------------------------------------
// Per-ACCOUNT lockout (N4). The per-IP throttle alone lets a distributed
// attacker make unlimited guesses; this caps total FAILED guesses against the
// single admin account regardless of source IP. Only failures count, the check
// runs before any credential work (so no scrypt cost while locked), and a
// storage error DENIES login (fail closed — no in-memory fallback).
// Trade-off (documented): an attacker can deliberately keep the account locked
// for the window; the kill-switch/recovery path is the env, not this counter.
// ---------------------------------------------------------------------------

export const ACCOUNT_LOCKOUT = { maxFailures: 8, windowSeconds: 15 * 60 } as const;

export interface AccountLockStore {
  read(args: { bucketKey: string; windowKey: string }): Promise<{ count: number; expiresAt: Date } | null>;
  increment(args: { bucketKey: string; windowKey: string; expiresAt: Date }): Promise<void>;
}

const prismaAccountLockStore: AccountLockStore = {
  read: ({ bucketKey, windowKey }) =>
    db.rateLimitWindow.findUnique({ where: { bucketKey_windowKey: { bucketKey, windowKey } } }),
  increment: async ({ bucketKey, windowKey, expiresAt }) => {
    await db.rateLimitWindow.upsert({
      where: { bucketKey_windowKey: { bucketKey, windowKey } },
      create: { bucketKey, windowKey, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });
  },
};

let accountLockStore: AccountLockStore = prismaAccountLockStore;
/** TEST SEAM ONLY (null restores the default). */
export function __setAccountLockStoreForTests(store: AccountLockStore | null): void {
  accountLockStore = store ?? prismaAccountLockStore;
}

function lockWindow(): { bucketKey: string; windowKey: string; expiresAt: Date; retryAfterSeconds: number } {
  const now = Math.floor(Date.now() / 1000);
  const { windowSeconds } = ACCOUNT_LOCKOUT;
  const start = now - (now % windowSeconds);
  return {
    // One account → one bucket, independent of the (attacker-chosen) email string.
    bucketKey: 'admin-account-lockout|' + credentialFingerprint('admin-account'),
    windowKey: `${start}-${windowSeconds}`,
    expiresAt: new Date((start + windowSeconds) * 1000 + 5_000),
    retryAfterSeconds: Math.max(1, start + windowSeconds - now),
  };
}

export type AccountLockVerdict =
  | { locked: false }
  | { locked: true; retryAfterSeconds: number; unavailable?: true };

/** Read-only: does NOT consume an attempt. */
export async function accountLockState(): Promise<AccountLockVerdict> {
  const w = lockWindow();
  try {
    const row = await accountLockStore.read({ bucketKey: w.bucketKey, windowKey: w.windowKey });
    if (row && row.count >= ACCOUNT_LOCKOUT.maxFailures) {
      return { locked: true, retryAfterSeconds: w.retryAfterSeconds };
    }
    return { locked: false };
  } catch {
    return { locked: true, retryAfterSeconds: 5, unavailable: true };
  }
}

/** Count one FAILED login against the account. Never throws. */
export async function recordAccountLoginFailure(): Promise<void> {
  const w = lockWindow();
  try {
    await accountLockStore.increment({ bucketKey: w.bucketKey, windowKey: w.windowKey, expiresAt: w.expiresAt });
  } catch {
    /* the next accountLockState() will fail closed if storage is down */
  }
}

export async function auditAdminEvent(kind: string, outcome: 'ok' | 'refused' | 'error', detail?: string): Promise<void> {
  await auditSecurityEvent({ kind, surface: 'admin', outcome, detail: detail?.slice(0, 200) });
}
