// Phase 8 — Payment webhook endpoint (Rule 8).
//
// POST /api/webhooks/polar
//
// SECURITY MODEL (fail-closed, deliberate):
// - The RAW request body is read as text and passed to the verification
//   boundary unchanged — never re-serialized, or signatures would break.
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

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { verifyProviderWebhook } from '@/lib/integrations/webhook-verification';
import { parseVerifiedEventBody, processVerifiedPaymentEvent } from '@/lib/integrations/webhook-events';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const rawBody = await request.text();

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
    return NextResponse.json({ ok: outcome.status !== 'REJECTED', status: outcome.status, outcome }, { status });
  } catch (error) {
    logger.error('Payment webhook processing failure', { error: String(error) });
    return NextResponse.json({ ok: false, error: 'PROCESSING_FAILED' }, { status: 500 });
  }
}
