// Phase 8 — Payment webhook endpoint (Rule 8).
//
// POST /api/webhooks/polar
//
// SECURITY MODEL (fail-closed, deliberate):
// - The RAW request body is read as text and passed to the verification
//   boundary unchanged — never re-serialized, or signatures would break.
// - The raw body is bounded BEFORE verification (streaming cap, not just a
//   Content-Length check), so an oversized or chunked body cannot exhaust
//   memory ahead of the signature check. Oversized/oversized-due-to-chunking
//   requests are refused with 413 and audited.
// - Without POLAR_WEBHOOK_SECRET configured server-side, every request is
//   refused with 503. Nothing is processed, nothing is fabricated.
// - Bad signatures/timestamps → 401 with a generic verdict; detail strings
//   never contain the secret or the full body.
// - Safe failure: a malformed-but-signed payload returns 200 with an IGNORED
//   verdict so providers do not retry non-retryable validation errors
//   forever; only transport-level problems (5xx) invite retries.
// - Replay protection and idempotency live in the verification/processing
//   layers; a replayed paid order collapses to DUPLICATE, never double-counted
//   revenue.
// - Client-asserted payment success is never consulted: revenue is recorded
//   only from a signature-verified provider payload whose amount, currency and
//   product pass validation.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { verifyProviderWebhook } from '@/lib/integrations/webhook-verification';
import { parseVerifiedEventBody, processVerifiedPaymentEvent } from '@/lib/integrations/webhook-events';
import { readBoundedText } from '@/lib/security/body';
import { auditSecurityEvent } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

/** Providers can be chatty, but the raw signed body is still bounded (1 MiB). */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const SURFACE = 'webhooks.polar';

export async function POST(request: Request) {
  const bounded = await readBoundedText(request, MAX_WEBHOOK_BODY_BYTES);
  if (!bounded.ok) {
    const tooLarge = bounded.reason === 'TOO_LARGE';
    await auditSecurityEvent({
      kind: tooLarge ? 'REQUEST_TOO_LARGE' : 'WEBHOOK_UNREADABLE',
      surface: SURFACE,
      outcome: 'refused',
      detail: tooLarge ? `body>${MAX_WEBHOOK_BODY_BYTES}` : 'body-unreadable',
    });
    return NextResponse.json(
      { ok: false, error: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'UNREADABLE_BODY' },
      { status: bounded.status },
    );
  }
  const rawBody = bounded.text;

  const verdict = verifyProviderWebhook({
    rawBody,
    standardHeaders: {
      webhookId: request.headers.get('webhook-id'),
      webhookTimestamp: request.headers.get('webhook-timestamp'),
      webhookSignature: request.headers.get('webhook-signature'),
    },
    legacySignatureHeader: request.headers.get('polar-signature') ?? request.headers.get('x-polar-signature'),
  });

  if (!verdict.ok) {
    const status = verdict.reason === 'MISSING_SECRET' ? 503 : 401;
    logger.warn('Payment webhook refused', { reason: verdict.reason });
    await auditSecurityEvent({
      kind: 'WEBHOOK_REFUSED',
      surface: SURFACE,
      outcome: verdict.reason === 'MISSING_SECRET' ? 'error' : 'refused',
      detail: verdict.reason,
    });
    return NextResponse.json({ ok: false, error: verdict.reason, detail: verdict.detail }, { status });
  }

  const parsed = parseVerifiedEventBody(rawBody);
  if ('error' in parsed) {
    // Verified but unusable: safe failure, no retry storm.
    return NextResponse.json({ ok: true, status: 'IGNORED', reason: 'UNPARSEABLE', detail: parsed.error });
  }

  try {
    const outcome = await processVerifiedPaymentEvent(
      { eventId: parsed.eventId, eventType: parsed.eventType, order: parsed.order },
      new Date(),
    );
    // 200 for RECORDED/DUPLICATE/IGNORED; 422 for REJECTED (validated refusal).
    const status = outcome.status === 'REJECTED' ? 422 : 200;
    if (outcome.status === 'REJECTED') {
      await auditSecurityEvent({
        kind: 'WEBHOOK_REJECTED',
        surface: SURFACE,
        outcome: 'refused',
        detail: outcome.reason,
      });
    }
    return NextResponse.json({ ok: outcome.status !== 'REJECTED', status: outcome.status, outcome }, { status });
  } catch (error) {
    logger.error('Payment webhook processing failure', { error: String(error) });
    return NextResponse.json({ ok: false, error: 'PROCESSING_FAILED' }, { status: 500 });
  }
}
