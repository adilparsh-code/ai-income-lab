// ============================================================================
// PUBLIC API — STOREFRONT PURCHASE REQUESTS (unauthenticated intake)
// ============================================================================
// POST /api/store/inquiries { offerId, displayName, email, message,
//                             requestId, company? }
//
// The FIRST public write surface in the app. It is intentionally narrow:
//   - per-IP rate limit (DB-backed, shared across instances);
//   - same-origin browser evidence required (CSRF boundary, also enforced
//     centrally in src/middleware.ts);
//   - size-capped strict JSON parse;
//   - pure validation/normalization (src/lib/storefront/inquiry.ts);
//   - the offer is re-verified as publicly listable (halal fail-closed) in
//     recordStoreInquiry before anything is written;
//   - writes go through the EXISTING Prospect/Conversation/Message security
//     boundary — messages are DATA, never authority, and a payment claim in a
//     message is never treated as payment evidence;
//   - the response is identical for new/duplicate/honeypot outcomes so the
//     endpoint cannot be used to enumerate known buyers or offers.
// ============================================================================

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import {
  auditSecurityEvent,
  clientIpFrom,
  enforceRateLimit,
  readJsonBody,
  requireSameOriginIfBrowser,
} from '@/lib/security/guard';
import { validateStoreInquiry } from '@/lib/storefront/inquiry';
import { recordStoreInquiry } from '@/lib/storefront/store';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:store:inquiries';
const RECEIVED = { ok: true, status: 'RECEIVED' } as const;

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 10, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json(
      { ok: false, error: 'Rate limit exceeded. Retry later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const origin = await requireSameOriginIfBrowser(request, SURFACE);
  if (!origin.ok) {
    return NextResponse.json({ ok: false, error: origin.error }, { status: origin.status });
  }

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxBytes: 16 * 1024, maxChars: 8_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }

  const validated = validateStoreInquiry(bodyGuard.value);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  try {
    const result = await recordStoreInquiry({ inquiry: validated.value, surface: SURFACE });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    // Same body for new / duplicate / honeypot: no enumeration signal.
    return NextResponse.json(RECEIVED, { status: 200 });
  } catch (error) {
    logger.error('Storefront inquiry ingestion failed', { error: String(error) });
    await auditSecurityEvent({ kind: 'STOREFRONT_INQUIRY', surface: SURFACE, outcome: 'error', detail: 'unhandled storage failure' });
    return NextResponse.json(
      { ok: false, error: 'We could not record your request right now. Please try again shortly.' },
      { status: 503 },
    );
  }
}
