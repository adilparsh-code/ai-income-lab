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

/** Truthful readiness of the admin credential configuration. */
export function adminCredentialStatus(): AdminCredentialStatus {
  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (hash) return 'CONFIGURED';
  const plain = process.env.ADMIN_PASSWORD?.trim();
  if (plain) return 'CONFIGURED';
  return 'NOT_CONFIGURED';
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

  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (hash) return verifyScryptHash(password, hash);

  const plain = process.env.ADMIN_PASSWORD?.trim();
  if (plain) return constantTimeTextEquals(password, plain);

  return false; // nothing configured → fail closed
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

export async function auditAdminEvent(kind: string, outcome: 'ok' | 'refused' | 'error', detail?: string): Promise<void> {
  await auditSecurityEvent({ kind, surface: 'admin', outcome, detail: detail?.slice(0, 200) });
}
