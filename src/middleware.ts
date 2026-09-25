// ============================================================================
// EDGE MIDDLEWARE (Security Hardening Phase)
// ============================================================================
// Lightweight, allocation-light gate on every request:
//
//  1. SECURITY HEADERS — CSP, frame-ancestors, referrer policy, permissions
//     policy, and no-sniff. Applied to document requests; object-src 'none'
//     and base-uri 'self' harden every page against injected content.
//  2. ORIGIN TRUST — browser-originated state-changing requests (POST/PUT/
//     PATCH/DELETE) must be same-origin (Origin/Referer host == Host header)
//     or carry a valid operator credential. Server-to-server callers (no
//     origin evidence) fall through to the endpoint's own auth.
//  3. BOT TRAFFIC REJECTION — aggressive scripted scanners (python-requests,
//     curl, Go-http-client, etc.) are refused on ALL API routes with 403 and
//     a logged audit event. Real users are unaffected.
//
// Everything here runs at the edge before any route logic; DB access and
// rate limiting stay in the route-level guards (src/lib/security/guard.ts).
// ============================================================================

import { NextResponse, type NextRequest } from 'next/server';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-DNS-Prefetch-Control': 'off',
};

const CSP_DOCUMENT = [
  "default-src 'self'",
  // Next.js dev + production need inline scripts for hydration; allow nonce-
  // less inline only in dev. Production uses 'self' plus Next's hashed inline
  // scripts via 'unsafe-inline' on script-src (standard Next.js posture).
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const GENERIC_BOT_UA_PATTERNS: RegExp[] = [
  /^python-requests\//i,
  /^python-httpx\//i,
  /^curl\//i,
  /^Wget\//i,
  /^Go-http-client\//i,
  /^Java\//i,
  /^Apache-HttpClient\//i,
  /^scrapy/i,
  /^aiohttp\//i,
];

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = isApiPath(pathname);
  const isWebhook = pathname.startsWith('/api/webhooks/');

  // ------------------------------------------------------------------
  // 3. BOT TRAFFIC REJECTION (API routes only; webhooks exempt — provider
  //    payloads may arrive from server-side senders with arbitrary UAs).
  // ------------------------------------------------------------------
  if (isApi && !isWebhook) {
    const userAgent = request.headers.get('user-agent')?.trim() ?? '';
    if (GENERIC_BOT_UA_PATTERNS.some((p) => p.test(userAgent))) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'Bot traffic rejected at edge',
          path: pathname,
        }),
      );
      return NextResponse.json(
        { ok: false, error: 'Automated traffic is not accepted on this endpoint.' },
        { status: 403, headers: SECURITY_HEADERS },
      );
    }
  }

  // ------------------------------------------------------------------
  // 2. ORIGIN TRUST for browser-reachable state-changing requests.
  // ------------------------------------------------------------------
  if (isApi && STATE_CHANGING.has(request.method) && !isWebhook) {
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const originEvidence = origin ?? (referer ? safeOriginOf(referer) : null);

    if (originEvidence) {
      const host = request.headers.get('host');
      const evidenceHost = safeHostOf(originEvidence);
      const sameOrigin = Boolean(host && evidenceHost && evidenceHost === host);

      // Server-to-server callers with no browser origin fall through (they
      // must present the operator credential at the route). A request that
      // DOES present cross-origin browser evidence is refused here — this is
      // the CSRF boundary for every API route in one place.
      if (!sameOrigin) {
        // Operator-credentialed server callers are exempt: they authenticate
        // with a Bearer token and never send browser Origin headers. Any
        // request that sends BOTH a cross-origin Origin and no credential is
        // refused here.
        const hasCredential = request.headers.get('authorization')?.startsWith('Bearer ') ?? false;
        if (!hasCredential) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'Cross-origin state-changing request refused',
              path: pathname,
              origin: originEvidence.slice(0, 100),
            }),
          );
          return NextResponse.json(
            { ok: false, error: 'Cross-origin request refused.' },
            { status: 403, headers: SECURITY_HEADERS },
          );
        }
      }
    }
    // No origin evidence: server-to-server. The route's own operator gate
    // (requireOperator / guardOperatorEndpoint) enforces authentication.
  }

  // ------------------------------------------------------------------
  // 1. SECURITY HEADERS on every response.
  // ------------------------------------------------------------------
  const requestHeaders = new Headers(request.headers);
  const isDocument = !isApi && !pathname.startsWith('/_next/') && !pathname.includes('.');
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  if (isDocument) {
    response.headers.set('Content-Security-Policy', CSP_DOCUMENT);
  }
  return response;
}

function safeOriginOf(referer: string): string | null {
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function safeHostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export const config = {
  // Vercel was compiling this middleware as an Edge Function. The application
  // has server-only transitive dependencies elsewhere in the build graph
  // (node:crypto/node:dns), so run middleware on the Node.js runtime instead.
  runtime: 'nodejs',
  // Static assets and Next internals skip the middleware entirely.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
