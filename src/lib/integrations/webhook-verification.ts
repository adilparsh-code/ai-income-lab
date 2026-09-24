// Phase 8 - Payment webhook verification boundary (Rule 8).
//
// Provider-agnostic verification layer implementing the Standard Webhooks
// signature scheme (used by Polar for secrets created after 2026-09-08, and by
// many other providers):
//
//   signed-content = {msg_id}.{timestamp}.{raw_body}
//   signature      = base64( HMAC-SHA256(secret, signed-content) )
//   headers        = webhook-id, webhook-timestamp, webhook-signature
//                    (v1,<base64sig>, possibly multiple space-separated)
//
// Guarantees:
//   - The raw request body (not a re-serialization) is what gets verified.
//   - The secret comes only from server-side env; it is never logged/returned.
//   - Replay protection: timestamps outside the tolerance window are refused.
//   - Comparison is constant-time per candidate signature.
//   - Legacy Polar HMAC scheme (hex, plain timestamp.body) is supported for
//     older secrets - both are attempted, and either a valid match verifies.
//
// This module knows nothing about products/revenue: it returns a verdict, and
// the caller decides what (verified) payload to do.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const POLAR_WEBHOOK_SECRET_ENV = 'POLAR_WEBHOOK_SECRET';

/** Default replay window: 5 minutes (Standard Webhooks recommendation). */
const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookVerificationVerdict =
  | { ok: true; msgId: string; timestamp: number }
  | { ok: false; reason: 'MISSING_SECRET' | 'MISSING_HEADERS' | 'BAD_TIMESTAMP' | 'STALE_TIMESTAMP' | 'BAD_SIGNATURE'; detail: string };

export interface WebhookHeaders {
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookSignature: string | null;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

function safeEqualBase64(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'base64');
  const bb = Buffer.from(b, 'base64');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

function parseTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Verify a Standard Webhooks signed request. `nowSec` is injectable for tests.
 * Supports multiple space-separated signatures in the webhook-signature header.
 */
export function verifyStandardWebhook(input: {
  secret: string;
  rawBody: string;
  headers: WebhookHeaders;
  nowSec?: number;
  toleranceSeconds?: number;
}): WebhookVerificationVerdict {
  const { secret, rawBody, headers } = input;
  if (!secret || secret.trim().length === 0) {
    return { ok: false, reason: 'MISSING_SECRET', detail: 'No webhook secret is configured server-side.' };
  }
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  const msgId = headers.webhookId?.trim() ?? '';
  const timestamp = parseTimestamp(headers.webhookTimestamp);
  const signatureHeader = headers.webhookSignature?.trim() ?? '';
  if (!msgId || timestamp === null || !signatureHeader) {
    return { ok: false, reason: 'MISSING_HEADERS', detail: 'webhook-id, webhook-timestamp and webhook-signature headers are required.' };
  }
  if (Math.abs(nowSec - timestamp) > tolerance) {
    return { ok: false, reason: 'STALE_TIMESTAMP', detail: `Timestamp ${timestamp} is outside the ±${tolerance}s replay window.` };
  }

  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(signedContent).digest('base64');
  const candidates = signatureHeader
    .split(/\s+/)
    .map((s) => s.replace(/^v1,/, '').trim())
    .filter((s) => s.length > 0);
  for (const candidate of candidates) {
    if (safeEqualBase64(candidate, expected)) {
      return { ok: true, msgId, timestamp };
    }
  }
  return { ok: false, reason: 'BAD_SIGNATURE', detail: 'No signature candidate matched the HMAC.' };
}

/**
 * Legacy Polar HMAC verification (hex digest over `{timestamp}.{raw_body}`,
 * header `polar-signature` or `x-polar-signature`). Used for older secrets.
 */
export function verifyLegacyPolarWebhook(input: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
  nowSec?: number;
  toleranceSeconds?: number;
}): WebhookVerificationVerdict {
  const { secret, rawBody, signatureHeader } = input;
  if (!secret || secret.trim().length === 0) {
    return { ok: false, reason: 'MISSING_SECRET', detail: 'No webhook secret is configured server-side.' };
  }
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const header = signatureHeader?.trim() ?? '';
  if (!header) {
    return { ok: false, reason: 'MISSING_HEADERS', detail: 'A signature header is required.' };
  }
  const [tsRaw, ...sigParts] = header.split(',');
  const timestamp = parseTimestamp(tsRaw?.trim() ?? null);
  const signature = sigParts.join(',').trim();
  if (timestamp === null || !signature) {
    return { ok: false, reason: 'MISSING_HEADERS', detail: 'Signature header must be "<timestamp>,<hex-signature>".' };
  }
  if (Math.abs(nowSec - timestamp) > tolerance) {
    return { ok: false, reason: 'STALE_TIMESTAMP', detail: `Timestamp ${timestamp} is outside the ±${tolerance}s replay window.` };
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if (safeEqualHex(signature.toLowerCase(), expected)) {
    return { ok: true, msgId: `legacy-${timestamp}`, timestamp };
  }
  return { ok: false, reason: 'BAD_SIGNATURE', detail: 'Signature did not match the HMAC.' };
}

/**
 * One-call boundary: reads the secret from server-side env, tries the Standard
 * Webhooks scheme first, then the legacy Polar scheme. Never throws; a
 * misconfigured secret is an honest MISSING_SECRET verdict.
 */
export function verifyProviderWebhook(input: {
  rawBody: string;
  standardHeaders: WebhookHeaders;
  legacySignatureHeader: string | null;
  nowSec?: number;
}): WebhookVerificationVerdict {
  const secret = process.env[POLAR_WEBHOOK_SECRET_ENV];
  if (!secret || secret.trim().length === 0) {
    return { ok: false, reason: 'MISSING_SECRET', detail: `${POLAR_WEBHOOK_SECRET_ENV} is not configured server-side; webhook refused (fail-closed).` };
  }
  const standard = verifyStandardWebhook({ secret: secret.trim(), rawBody: input.rawBody, headers: input.standardHeaders, nowSec: input.nowSec });
  if (standard.ok) return standard;
  // Legacy scheme only as fallback when the standard scheme failed on
  // signature (not on staleness - a stale request stays stale) AND a legacy
  // signature header was actually supplied. Without a legacy header the
  // correct verdict is BAD_SIGNATURE: reporting MISSING_HEADERS would
  // misdescribe a request that arrived with a signature and failed it.
  if (standard.reason === 'BAD_SIGNATURE') {
    const legacyHeader = input.legacySignatureHeader?.trim() ?? '';
    if (legacyHeader.length === 0) {
      return {
        ok: false,
        reason: 'BAD_SIGNATURE',
        detail: 'No signature candidate matched the HMAC (no legacy signature header was present).',
      };
    }
    const legacy = verifyLegacyPolarWebhook({
      secret: secret.trim(),
      rawBody: input.rawBody,
      signatureHeader: legacyHeader,
      nowSec: input.nowSec,
      toleranceSeconds: undefined,
    });
    if (legacy.ok) return legacy;
    if (legacy.reason === 'BAD_SIGNATURE') {
      return { ok: false, reason: 'BAD_SIGNATURE', detail: 'Neither Standard Webhooks nor legacy Polar signatures matched.' };
    }
    return legacy;
  }
  return standard;
}
