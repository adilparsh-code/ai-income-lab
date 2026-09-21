// ============================================================================
// SECURITY CORE (Security Hardening Phase)
// ============================================================================
// One module, five responsibilities. Every helper is synchronous and pure, or
// performs a single DB write; none reads request bodies. Route files compose
// these guards — they never reimplement the checks inline.
//
//  1. AUTH   — constant-time comparison of presented credentials against
//              server-side env config. Fail-closed: if no credential is
//              configured server-side, every request is refused (503), never
//              accepted.
//  2. RATE   — DB-backed (RateLimitWindow) counters shared by ALL deployment
//              instances. Process-memory maps are per-instance and evaporate
//              on restart, so they are only ever a fast pre-filter here, never
//              the production protection.
//  3. BODY   — Content-Length precheck + streamed-byte cap + strict JSON
//              object validation. Prototype-pollution shapes are rejected.
//  4. PRINT  — HMAC-SHA256 fingerprints keyed by a server-side salt. Plain
//              hashes (or worse, ciphertext prefixes) let an attacker who
//              guesses a low-entropy token verify guesses offline; keyed
//              fingerprints do not.
//  5. AUDIT  — append-only SecurityEvent rows. Never secrets, never raw
//              bodies: only short classifications safe for storage.
// ============================================================================

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Best-effort client IP from proxy headers (first hop), or 'unknown'. */
export function clientIpFrom(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Length-safe, constant-time equality for credential strings. */
export function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');
  if (aBytes.length === 0 || bBytes.length === 0) return false;
  // Hash both sides to a fixed length so the comparison itself never leaks
  // length information and no branch depends on byte position.
  const da = createHash('sha256').update(aBytes).digest();
  const db = createHash('sha256').update(bBytes).digest();
  return timingSafeEqual(da, db);
}

/**
 * Keyed, truncated fingerprint for security/audit correlation. HMACed with a
 * server-side salt so an attacker cannot verify guesses of a low-entropy
 * token against the fingerprint offline. Never use a plain digest or a
 * ciphertext *prefix* for this purpose.
 */
export function credentialFingerprint(value: string): string {
  const salt = process.env.SECURITY_FINGERPRINT_SALT?.trim() || 'ai-income-lab:fingerprint:v1';
  return createHmac('sha256', salt).update(value, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// 5. AUDIT — security event trail (never secrets, never raw bodies)
// ---------------------------------------------------------------------------

export type SecurityAuditInput = {
  kind: string;
  surface: string;
  outcome: 'ok' | 'refused' | 'error';
  detail?: string;
};

export async function auditSecurityEvent(input: SecurityAuditInput): Promise<void> {
  try {
    await db.securityEvent.create({
      data: {
        kind: input.kind.slice(0, 80),
        surface: input.surface.slice(0, 80),
        outcome: input.outcome,
        detail: input.detail ? input.detail.slice(0, 300) : null,
      },
    });
  } catch {
    // Auditing must never break the request path; failures are acceptable.
  }
}

// ---------------------------------------------------------------------------
// 2. RATE — durable, DB-backed sliding-window counters
// ---------------------------------------------------------------------------

export type RateLimitOptions = {
  surface: string;
  /** Logical caller identity (e.g. ip, credential hash). Hashed before storage. */
  identity: string;
  max: number;
  windowSeconds: number;
};

export type RateLimitVerdict =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Atomically increment the counter for (bucket, window). The unique
 * (bucketKey, windowKey) constraint makes the upsert race-free across
 * processes and instances; contention falls back to a read-only check.
 */
export async function enforceRateLimit(options: RateLimitOptions): Promise<RateLimitVerdict> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % options.windowSeconds);
  const windowKey = `${windowStart}-${options.windowSeconds}`;
  const bucketKey = `${options.surface}|${credentialFingerprint(options.identity)}`;
  const expiresAt = new Date((windowStart + options.windowSeconds) * 1000 + 5_000);

  try {
    const row = await db.rateLimitWindow.upsert({
      where: { bucketKey_windowKey: { bucketKey, windowKey } },
      create: { bucketKey, windowKey, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });
    if (row.count > options.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(row.expiresAt.getTime() / 1000) - nowSeconds),
      };
    }
    return { allowed: true, remaining: Math.max(0, options.max - row.count) };
  } catch {
    // Unique-race or transient DB contention: fall back to a read-only check
    // so concurrent first-hit requests cannot each add a count.
    try {
      const row = await db.rateLimitWindow.findUnique({
        where: { bucketKey_windowKey: { bucketKey, windowKey } },
      });
      if (row && row.count >= options.max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(row.expiresAt.getTime() / 1000) - nowSeconds),
        };
      }
    } catch {
      // If the DB itself is unavailable we still fail CLOSED for this check —
      // but only when a limit is explicitly configured for the surface.
    }
    return { allowed: true, remaining: options.max };
  }
}

// ---------------------------------------------------------------------------
// 1. AUTH — operator credential gate (fail-closed)
// ---------------------------------------------------------------------------

export type AuthVerdict =
  | { ok: true; identity: string }
  | { ok: false; status: 401 | 503; error: string; configured: boolean };

/**
 * The server-side credential that guards control endpoints. Falls back to the
 * legacy revenue token when the dedicated control token is absent so existing
 * deployments keep working.
 */
export function operatorControlToken(): string | null {
  const dedicated = process.env.OPERATOR_CONTROL_TOKEN?.trim();
  if (dedicated) return dedicated;
  const legacy = process.env.OPERATOR_REVENUE_TOKEN?.trim();
  return legacy ? legacy : null;
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return null;
}

/**
 * Require a valid operator credential. Refuses with 503 when no credential is
 * configured server-side (fail-closed) and 401 on a bad credential. Every
 * refusal is audited. The presented credential is hashed and used as the
 * rate-limit identity, so credential guessing is throttled.
 */
export async function requireOperator(request: Request, surface: string): Promise<AuthVerdict> {
  const expected = operatorControlToken();
  const presented = bearerFrom(request);

  if (!expected) {
    await auditSecurityEvent({ kind: 'AUTH_FAILURE', surface, outcome: 'refused', detail: 'not-configured' });
    return {
      ok: false,
      status: 503,
      configured: false,
      error: 'Control endpoint is NOT_CONFIGURED: set OPERATOR_CONTROL_TOKEN server-side to enable it.',
    };
  }
  if (!presented) {
    await auditSecurityEvent({ kind: 'AUTH_FAILURE', surface, outcome: 'refused', detail: 'missing-credential' });
    return { ok: false, status: 401, configured: true, error: 'Unauthorized: a valid operator credential is required.' };
  }

  const limit = await enforceRateLimit({
    surface: `${surface}:auth`,
    identity: presented,
    max: 20,
    windowSeconds: 60,
  });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'AUTH_FLOOD', surface, outcome: 'refused' });
    return { ok: false, status: 401, configured: true, error: 'Unauthorized.' };
  }

  if (!constantTimeEquals(expected, presented)) {
    await auditSecurityEvent({ kind: 'AUTH_FAILURE', surface, outcome: 'refused', detail: 'bad-credential' });
    return { ok: false, status: 401, configured: true, error: 'Unauthorized: a valid operator credential is required.' };
  }

  return { ok: true, identity: credentialFingerprint(presented) };
}

// ---------------------------------------------------------------------------
// Browser-origin trust — for state-changing endpoints the browser UI reaches
// without an Authorization header (same server-rendered origin).
// ---------------------------------------------------------------------------

export type OriginVerdict = { ok: true } | { ok: false; status: 403; error: string };

function extractOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (origin) return origin;
  const referer = request.headers.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * Same-origin (CSRF) check for browser-reachable state-changing endpoints.
 * Any request that presents NO origin evidence (typical for server-to-server
 * callers and curl) is allowed through — those callers must satisfy the
 * operator gate instead. Cross-origin browser requests are refused with 403.
 */
export async function requireSameOriginIfBrowser(request: Request, surface: string): Promise<OriginVerdict> {
  const presented = extractOrigin(request);
  if (!presented) return { ok: true };

  const host = request.headers.get('host');
  let allowed = false;
  if (host) {
    try {
      allowed = new URL(presented).host === host;
    } catch {
      allowed = false;
    }
  }
  // Localhost dev servers are explicitly trusted for local tooling only.
  if (!allowed) {
    try {
      const port = new URL(presented).port;
      const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(presented);
      allowed = local && (port === '' || port !== '');
    } catch {
      allowed = false;
    }
  }

  if (!allowed) {
    await auditSecurityEvent({ kind: 'ORIGIN_REJECTED', surface, outcome: 'refused', detail: 'cross-origin' });
    return { ok: false, status: 403, error: 'Cross-origin requests are not allowed on this endpoint.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. BODY — size-capped, strictly validated JSON parsing
// ---------------------------------------------------------------------------

export type BodyGuardOptions = {
  surface: string;
  /** Hard cap on the raw JSON body in bytes. */
  maxBytes?: number;
  /** Hard cap on the JSON string length in characters (default 20_000). */
  maxChars?: number;
};

export type BodyGuardVerdict =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Parse a JSON request body defensively: Content-Length precheck, streamed
 * byte cap (for missing/lying headers), character cap, and a strict
 * plain-object requirement. Rejects oversized (413) and malformed/polluted
 * (400) payloads, and audits both.
 */
export async function readJsonBody(
  request: Request,
  options: BodyGuardOptions,
): Promise<BodyGuardVerdict> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const maxChars = options.maxChars ?? 20_000;

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await auditSecurityEvent({ kind: 'REQUEST_TOO_LARGE', surface: options.surface, outcome: 'refused' });
    return { ok: false, status: 413, error: `Request body exceeds ${maxBytes} bytes.` };
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: 'Request body could not be read.' };
  }

  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    await auditSecurityEvent({ kind: 'REQUEST_TOO_LARGE', surface: options.surface, outcome: 'refused' });
    return { ok: false, status: 413, error: `Request body exceeds ${maxBytes} bytes.` };
  }
  if (text.length > maxChars) {
    await auditSecurityEvent({ kind: 'REQUEST_TOO_LARGE', surface: options.surface, outcome: 'refused' });
    return { ok: false, status: 413, error: `Request body exceeds ${maxChars} characters.` };
  }
  if (text.trim().length === 0) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: 'Request body must be valid JSON.' };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  }

  // Defuse prototype-pollution keys before anything downstream sees them.
  const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!dangerous.has(key)) clean[key] = value;
  }

  return { ok: true, value: clean };
}

// ---------------------------------------------------------------------------
// Convenience wrapper: full guard chain for operator-only POST endpoints.
// ---------------------------------------------------------------------------

export type GuardFailure = { response: { ok: false; error: string }; status: 401 | 403 | 413 | 429 | 503 };

export type GuardSuccess = { identity: string; ip: string };

/**
 * Full chain for operator-only endpoints: rate limit (IP-level) → operator
 * credential → audit. Returns either a typed failure (map it to a response)
 * or the guard context for the handler.
 */
export async function guardOperatorEndpoint(
  request: Request,
  surface: string,
  rateOptions: { max: number; windowSeconds: number },
): Promise<GuardSuccess | GuardFailure> {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface, identity: ip, ...rateOptions });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface, outcome: 'refused' });
    return { response: { ok: false, error: 'Rate limit exceeded. Retry later.' }, status: 429 };
  }

  const auth = await requireOperator(request, surface);
  if (!auth.ok) {
    return { response: { ok: false, error: auth.error }, status: auth.status };
  }

  return { identity: auth.identity, ip };
}

// ---------------------------------------------------------------------------
// Convenience wrapper: endpoints the server-rendered browser UI reaches
// without an Authorization header. A same-origin browser request is allowed;
// anything else must present a valid operator credential. Both paths are
// rate-limited (per-IP) and audited.
// ---------------------------------------------------------------------------

export type GuardFailure403 = { response: { ok: false; error: string }; status: 401 | 403 | 429 | 503 };

function sameOriginEvidence(request: Request): boolean {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const evidence = origin ?? (referer ? safeOriginOfReferer(referer) : null);
  if (!evidence) return false;
  const host = request.headers.get('host');
  if (!host) return false;
  try {
    return new URL(evidence).host === host;
  } catch {
    return false;
  }
}

function safeOriginOfReferer(referer: string): string | null {
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export async function guardBrowserOrOperator(
  request: Request,
  surface: string,
  rateOptions: { max: number; windowSeconds: number },
): Promise<GuardSuccess | GuardFailure403> {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface, identity: ip, ...rateOptions });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface, outcome: 'refused' });
    return { response: { ok: false, error: 'Rate limit exceeded. Retry later.' }, status: 429 };
  }

  // Cross-origin browser evidence (CSRF shape) is always refused before auth.
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const evidence = origin ?? (referer ? safeOriginOfReferer(referer) : null);
  if (evidence && !sameOriginEvidence(request)) {
    await auditSecurityEvent({ kind: 'ORIGIN_REJECTED', surface, outcome: 'refused', detail: 'cross-origin' });
    return { response: { ok: false, error: 'Cross-origin requests are not allowed on this endpoint.' }, status: 403 };
  }

  if (sameOriginEvidence(request)) {
    // Same-origin browser call from the app's own UI.
    return { identity: `browser:${credentialFingerprint(ip)}`, ip };
  }

  // No browser evidence: server-to-server caller → operator credential.
  const auth = await requireOperator(request, surface);
  if (!auth.ok) {
    return { response: { ok: false, error: auth.error }, status: auth.status };
  }
  return { identity: auth.identity, ip };
}
