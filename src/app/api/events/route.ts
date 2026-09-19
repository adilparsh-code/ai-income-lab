// Phase 5.5 — Product events API (live traffic ingestion).
//
// POST /api/events  → ingest one product event (VISITOR … PURCHASE/REFUND).
//                     Idempotent by key; validated; provenance-tagged; never
//                     fabricated. Response reveals only the ingest status.
// GET  /api/events?productId=…&days=30 → deterministic funnel metrics computed
//                     from RECORDED events only, with honest
//                     SUPPORTED / INSUFFICIENT_DATA labelling.
//
// SECURITY: no PII — sessionId must already be anonymized by the caller;
// payloads are bounded; nothing is forwarded to AI providers.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { recordProductEvent, computeProductFunnel, PRODUCT_EVENT_TYPES } from '@/lib/product-factory/events';

export const dynamic = 'force-dynamic';

function isKnownEventType(value: unknown): value is (typeof PRODUCT_EVENT_TYPES)[number] {
  return typeof value === 'string' && (PRODUCT_EVENT_TYPES as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body must be valid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  if (!isKnownEventType(raw.eventType)) {
    return NextResponse.json(
      { ok: false, error: `eventType must be one of: ${PRODUCT_EVENT_TYPES.join(', ')}` },
      { status: 400 },
    );
  }
  if (typeof raw.productId !== 'string' || raw.productId.trim().length === 0 || raw.productId.length > 128) {
    return NextResponse.json({ ok: false, error: 'productId is required (max 128 chars)' }, { status: 400 });
  }
  if (typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.trim().length === 0 || raw.idempotencyKey.length > 200) {
    return NextResponse.json({ ok: false, error: 'idempotencyKey is required (max 200 chars)' }, { status: 400 });
  }
  if (typeof raw.source !== 'string' || raw.source.trim().length === 0 || raw.source.length > 120) {
    return NextResponse.json({ ok: false, error: 'source is required (max 120 chars)' }, { status: 400 });
  }
  if (raw.evidenceType !== undefined && raw.evidenceType !== 'VERIFIED_DATA' && raw.evidenceType !== 'USER_ENTERED') {
    return NextResponse.json({ ok: false, error: "evidenceType must be 'VERIFIED_DATA' or 'USER_ENTERED'" }, { status: 400 });
  }
  for (const field of ['sessionId', 'campaignId', 'opportunityId', 'experimentId', 'occurredAt', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'referrer', 'landingPage'] as const) {
    if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') {
      return NextResponse.json({ ok: false, error: `${field} must be a string when present` }, { status: 400 });
    }
  }

  const result = await recordProductEvent({
    eventType: raw.eventType,
    productId: raw.productId,
    idempotencyKey: raw.idempotencyKey,
    source: raw.source,
    sessionId: (raw.sessionId as string | undefined) ?? null,
    campaignId: (raw.campaignId as string | undefined) ?? null,
    opportunityId: (raw.opportunityId as string | undefined) ?? null,
    experimentId: (raw.experimentId as string | undefined) ?? null,
    evidenceType: raw.evidenceType === 'USER_ENTERED' ? 'USER_ENTERED' : 'VERIFIED_DATA',
    amountUsd: typeof raw.amountUsd === 'number' ? raw.amountUsd : null,
    utmSource: (raw.utmSource as string | undefined) ?? null,
    utmMedium: (raw.utmMedium as string | undefined) ?? null,
    utmCampaign: (raw.utmCampaign as string | undefined) ?? null,
    utmContent: (raw.utmContent as string | undefined) ?? null,
    utmTerm: (raw.utmTerm as string | undefined) ?? null,
    referrer: (raw.referrer as string | undefined) ?? null,
    landingPage: (raw.landingPage as string | undefined) ?? null,
    occurredAt: (raw.occurredAt as string | undefined) ?? null,
  });

  if (result.status === 'INVALID') {
    return NextResponse.json({ ok: false, status: result.status, errors: result.errors }, { status: 400 });
  }
  // RECORDED / DUPLICATE / STORAGE_UNAVAILABLE are all honest, expected outcomes.
  return NextResponse.json({ ok: true, status: result.status, eventId: result.eventId }, { status: 200 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const productId = url.searchParams.get('productId');
  if (!productId || productId.trim().length === 0 || productId.length > 128) {
    return NextResponse.json({ ok: false, error: 'productId query parameter is required' }, { status: 400 });
  }
  const daysRaw = url.searchParams.get('days');
  const days = daysRaw === null ? 30 : Number.parseInt(daysRaw, 10);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return NextResponse.json({ ok: false, error: 'days must be an integer between 1 and 365' }, { status: 400 });
  }

  try {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    const funnel = await computeProductFunnel(productId.trim(), { start, end });
    return NextResponse.json({ ok: true, funnel });
  } catch (error) {
    logger.error('Funnel computation failed', { error: String(error) });
    return NextResponse.json(
      { ok: false, error: 'Funnel metrics are temporarily unavailable (storage error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
