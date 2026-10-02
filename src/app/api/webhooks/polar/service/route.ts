// ============================================================================
// PHASE 11.4 — SERVICE PAYMENT WEBHOOK
// ============================================================================
// POST /api/webhooks/polar/service
//
// This is the PROVIDER_WEBHOOK source the Phase 11.3 audit found missing: until
// now only MANUAL_ADMIN_APPROVED was reachable, so every service payment had to
// be approved by hand. This route adds the provider path WITHOUT weakening
// anything, because every hard step is already in place and this route only
// orders them:
//
//   1. bounded raw body read      (security/body.ts — streams with a cap)
//   2. signature verification     (webhook-verification.ts — the Phase 8
//                                  boundary; MISSING_SECRET ⇒ 503, nothing
//                                  processed, nothing fabricated)
//   3. strict parsing            (webhook-events.ts parseVerifiedEventBody)
//   4. evidence classification   (payment-evidence.ts — replay window, event
//                                  type, amount/currency, ownership)
//   5. governed state transition (payment-service.ts → engagement-states.ts)
//
// There is deliberately NO branch here that reads a browser flag, a client
// message, or an arbitrary payload and treats it as paid. If the signature
// cannot be verified, this route returns an error and changes nothing.
// ============================================================================

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { verifyProviderWebhook } from '@/lib/integrations/webhook-verification';
import { parseVerifiedEventBody } from '@/lib/integrations/webhook-events';
import { readBoundedText } from '@/lib/security/body';
import { auditSecurityEvent } from '@/lib/security/guard';
import { applyVerifiedPaymentEvent } from '@/lib/commercial/payment-service';

export const dynamic = 'force-dynamic';

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const SURFACE = 'webhooks:polar:service';

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

  // --- 2. Signature verification (fail-closed) ---------------------------
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
    // MISSING_SECRET means the provider is NOT configured. We report 503 and
    // change nothing. We do not fabricate a success, and we do not fall back to
    // manual approval on the client's behalf.
    const status = verdict.reason === 'MISSING_SECRET' ? 503 : 401;
    logger.warn('Service payment webhook refused', { reason: verdict.reason });
    await auditSecurityEvent({
      kind: 'WEBHOOK_REFUSED',
      surface: SURFACE,
      outcome: verdict.reason === 'MISSING_SECRET' ? 'error' : 'refused',
      detail: verdict.reason,
    });
    return NextResponse.json(
      {
        ok: false,
        error: verdict.reason,
        detail: verdict.detail,
        providerStatus: 'NOT_CONNECTED',
        note: verdict.reason === 'MISSING_SECRET'
          ? 'No webhook secret is configured server-side, so no service payment can be verified. Nothing was processed.'
          : 'Signature verification failed. Nothing was processed.',
      },
      { status },
    );
  }

  // --- 3. Strict parse ---------------------------------------------------
  const parsed = parseVerifiedEventBody(rawBody);
  if ('error' in parsed) {
    // Verified but unusable: safe failure so the provider does not retry a
    // permanently-invalid payload forever.
    await auditSecurityEvent({
      kind: 'WEBHOOK_REJECTED',
      surface: SURFACE,
      outcome: 'refused',
      detail: `unparseable verified payload: ${parsed.error.slice(0, 80)}`,
    });
    return NextResponse.json({ ok: true, status: 'IGNORED', reason: 'UNPARSEABLE', detail: parsed.error });
  }

  // --- 4 + 5. Evidence → governed state ----------------------------------
  try {
    // The engagement/milestone target is read from the payload METADATA, which
    // the provider echoes from checkout metadata set on our side. It is used
    // only to SELECT the intended target; ownership is then verified against
    // the real rows, and an unknown engagement is refused rather than created.
    const metadata = (parsed.order.metadata ?? {}) as Record<string, unknown>;
    const outcome = await applyVerifiedPaymentEvent({
      provider: 'POLAR',
      providerEventId: parsed.eventId,
      eventType: parsed.eventType,
      signatureVerified: true,
      amount: typeof parsed.order.total_amount === 'number' ? parsed.order.total_amount : parsed.order.amount,
      amountUnit: typeof parsed.order.total_amount === 'number' ? 'MINOR' : 'MAJOR',
      currency: parsed.order.currency ?? 'USD',
      eventTimestampMs: verdict.timestamp ? verdict.timestamp * 1000 : undefined,
      engagementId: typeof metadata.engagementId === 'string' ? metadata.engagementId : undefined,
      milestoneId: typeof metadata.milestoneId === 'string' ? metadata.milestoneId : undefined,
      offerId: typeof metadata.offerId === 'string' ? metadata.offerId : undefined,
      evidenceRefs: [{ type: 'PROVIDER_EVENT', id: parsed.eventId }],
      surface: SURFACE,
    });

    if (!outcome.ok) {
      await auditSecurityEvent({
        kind: 'WEBHOOK_REJECTED',
        surface: SURFACE,
        outcome: 'refused',
        detail: outcome.error.slice(0, 100),
      });
      // 422 = a validated refusal. The provider should not retry it.
      return NextResponse.json({ ok: false, status: 'REJECTED', error: outcome.error }, { status: 422 });
    }

    return NextResponse.json({
      ok: true,
      status: outcome.duplicate ? 'DUPLICATE' : 'RECORDED',
      outcome,
    });
  } catch (error) {
    logger.error('Service payment webhook processing failure', { error: String(error) });
    return NextResponse.json({ ok: false, error: 'PROCESSING_FAILED' }, { status: 500 });
  }
}

/**
 * Truthful provider status. This never claims a connection; it reports whether
 * the verification secret is present, which is the only thing this repository
 * can honestly observe about its own configuration.
 */
export async function GET() {
  const configured = Boolean(process.env.POLAR_WEBHOOK_SECRET?.trim());
  return NextResponse.json({
    ok: true,
    provider: 'POLAR',
    capability: 'SERVICE_PAYMENT_VERIFICATION',
    state: configured ? 'CONFIGURED' : 'NOT_CONNECTED',
    liveE2EVerified: false,
    detail: configured
      ? 'A webhook secret is present server-side, so signed service payment events can be verified. No live '
        + 'provider round trip has been performed in this environment, so this is NOT live E2E verified.'
      : 'POLAR_WEBHOOK_SECRET is not configured, so no service payment can be verified from a provider event. '
        + 'The only reachable source is MANUAL_ADMIN_APPROVED.',
  });
}
