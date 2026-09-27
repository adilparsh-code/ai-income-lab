// ============================================================================
// AGENCY — SESSION GUARD (Phase 1/2)
// ============================================================================
// Server-side helpers that turn the opaque session cookie into a verified
// admin identity. Composes admin-auth.ts (DB-backed sessions) with
// next/headers. Fail-closed: unknown/expired/DB-unavailable → no access.
// Never logs or returns the cookie token.
// ============================================================================

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  ADMIN_SESSION_COOKIE,
  resolveAdminSession,
  type AdminSessionInfo,
} from './admin-auth';

/** Read the presented session cookie (server-side only). */
export async function presentedSessionToken(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(ADMIN_SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/** Resolve the current admin session, or null when absent/expired/invalid. */
export async function currentAdminSession(): Promise<AdminSessionInfo | null> {
  const token = await presentedSessionToken();
  if (!token) return null;
  return resolveAdminSession(token);
}

/**
 * Require an authenticated admin for a server component page. Returns the
 * session, or a redirect Response to /login (preserving the return path).
 */
export async function requireAdminPage(returnTo: string): Promise<AdminSessionInfo | { redirect: Response }> {
  const session = await currentAdminSession();
  if (session) return session;
  const target = new URL('/login', 'http://local');
  target.searchParams.set('returnTo', returnTo.slice(0, 200));
  return { redirect: NextResponse.redirect(new URL(`/login?returnTo=${encodeURIComponent(returnTo.slice(0, 200))}`, 'http://local')) };
}

/**
 * API guard for admin-only endpoints: verifies the session cookie. Returns
 * null when authenticated, or a 401 NextResponse to return immediately.
 * Rate limiting stays in the route (guard.ts) — this check is authorization,
 * not throttling.
 */
export async function requireAdminApi(): Promise<{ session: AdminSessionInfo } | { response: NextResponse }> {
  const session = await currentAdminSession();
  if (!session) {
    return {
      response: NextResponse.json(
        { ok: false, error: 'Admin session required. Sign in at /login.' },
        { status: 401 },
      ),
    };
  }
  return { session };
}

/** Safe redirect target: only same-site relative paths are honored. */
export function safeReturnTo(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  return raw.slice(0, 200);
}
