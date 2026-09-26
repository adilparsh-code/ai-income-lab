// ============================================================================
// ADMIN SESSION API (Phase 1 — single-admin authentication)
// ============================================================================
// POST /api/admin/session  → verify credentials, create a durable session,
//                            set the httpOnly cookie, redirect target returned as JSON.
// DELETE /api/admin/session → logout (revoke the session row, clear cookie).
// GET  /api/admin/session   → truthful session status (never the token).
//
// Security:
// - Rate limited per-IP BEFORE any credential work (brute-force throttle).
// - Credentials verified with constant-time comparisons (admin-auth.ts).
// - Fail-closed: no ADMIN_EMAIL or password config → every login fails 503.
// - Audited via SecurityEvent: outcomes only, never credentials or tokens.
// - Cookie: httpOnly, sameSite=lax, secure in production, path=/.
// ============================================================================

import { NextResponse } from 'next/server';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  adminCredentialStatus,
  auditAdminEvent,
  createAdminSession,
  LOGIN_RATE_LIMIT,
  resolveAdminSession,
  revokeAdminSession,
  verifyAdminCredentials,
} from '@/lib/agency/admin-auth';
import { presentedSessionToken, safeReturnTo } from '@/lib/agency/session-guard';
import { clientIpFrom, enforceRateLimit, auditSecurityEvent, readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  };
}

export async function GET() {
  const token = await presentedSessionToken();
  const status = adminCredentialStatus();
  if (!token) {
    return NextResponse.json({ ok: true, authenticated: false, credentialStatus: status });
  }
  const session = await resolveAdminSession(token);
  if (!session) {
    return NextResponse.json({ ok: true, authenticated: false, credentialStatus: status });
  }
  return NextResponse.json({
    ok: true,
    authenticated: true,
    email: session.email,
    expiresAt: session.expiresAt.toISOString(),
    credentialStatus: status,
  });
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);

  // Brute-force throttle BEFORE touching credentials.
  const limit = await enforceRateLimit({
    surface: 'api:admin:session',
    identity: ip,
    max: LOGIN_RATE_LIMIT.max,
    windowSeconds: LOGIN_RATE_LIMIT.windowSeconds,
  });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'ADMIN_LOGIN_RATE_LIMITED', surface: 'api:admin:session', outcome: 'refused' });
    return NextResponse.json(
      { ok: false, error: 'Too many login attempts. Try again later.' },
      { status: 429 },
    );
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:admin:session', maxBytes: 4 * 1024, maxChars: 2_000 });
  if (!bodyGuard.ok) {
    await auditAdminEvent('ADMIN_LOGIN', 'refused', 'malformed-body');
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const email = typeof bodyGuard.value.email === 'string' ? bodyGuard.value.email : null;
  const password = typeof bodyGuard.value.password === 'string' ? bodyGuard.value.password : null;
  const returnTo = safeReturnTo(typeof bodyGuard.value.returnTo === 'string' ? bodyGuard.value.returnTo : null, '/');

  if (adminCredentialStatus() === 'NOT_CONFIGURED') {
    // Fail closed and tell the operator exactly what is missing (no fake success).
    await auditAdminEvent('ADMIN_LOGIN', 'refused', 'not-configured');
    return NextResponse.json(
      { ok: false, error: 'Admin access is NOT_CONFIGURED: set ADMIN_EMAIL and ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD) server-side.' },
      { status: 503 },
    );
  }

  if (!verifyAdminCredentials(email, password)) {
    await auditAdminEvent('ADMIN_LOGIN', 'refused', 'bad-credentials');
    return NextResponse.json({ ok: false, error: 'Invalid credentials.' }, { status: 401 });
  }

  try {
    const { token, session } = await createAdminSession(email as string, `ip:${clientIpFrom(request)}`);
    const response = NextResponse.json({
      ok: true,
      authenticated: true,
      email: session.email,
      expiresAt: session.expiresAt.toISOString(),
      returnTo,
    });
    response.cookies.set(ADMIN_SESSION_COOKIE, token, cookieOptions());
    await auditAdminEvent('ADMIN_LOGIN', 'ok');
    return response;
  } catch {
    await auditAdminEvent('ADMIN_LOGIN', 'error', 'session-storage-unavailable');
    return NextResponse.json(
      { ok: false, error: 'Login is temporarily unavailable (session storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}

export async function DELETE(request: Request) {
  const token = await presentedSessionToken();
  const response = NextResponse.json({ ok: true, loggedOut: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
  if (token) {
    const revoked = await revokeAdminSession(token);
    await auditAdminEvent('ADMIN_LOGOUT', revoked ? 'ok' : 'error');
  }
  void request;
  return response;
}
