// Phase 5.5 — Product events API (live traffic ingestion).
//
// POST /api/events  → ingest one product event (VISITOR … PURCHASE/REFUND).
//                     Idempotent by key; validated; provenance-tagged; never
//                     fabricated. Response reveals only the ingest status.
// GET  /api/events?productId=…&days=30 → deterministic funnel metrics computed
//                     from RECORDED events only, with honest
//                     SUPPORTED / INSUFFICIENT_DATA labelling.
//
// TRUST MODEL: anonymous callers (the storefront) may record only top-of-funnel
// events, always as USER_ENTERED with no amount; PURCHASE/REFUND and
// VERIFIED_DATA require the operator credential. See event-policy.ts.
//
// SECURITY: no PII — sessionId must already be anonymized by the caller;
// payloads are bounded; nothing is forwarded to AI providers.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { recordProductEvent, computeProductFunnel, PRODUCT_EVENT_TYPES } from '@/lib/product-factory/events';
import { enforceRateLimit, clientIpFrom, readJsonBody, auditSecurityEvent, requireOperator, guardBrowserOrOperator } from '@/lib/security/guard';
import { isPublicEventType, sanitizePublicEvent } from '@/lib/product-factory/event-policy';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function isKnownEventType(value: unknown): value is (typeof PRODUCT_EVENT_TYPES)[number] {
  return typeof value === 'string' && (PRODUCT_EVENT_TYPES as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  // SECURITY: public ingestion endpoint — the abuse-protection surface.
  // Per-IP rate limit (shared, DB-backed) + size-capped strict body parse.
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:events', identity: ip, max: 120, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:events', outcome: 'refused' });
    return NextResponse.json(
      { ok: false, error: 'Rate limit exceeded. Retry later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:events', maxBytes: 16 * 1024, maxChars: 8_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
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

  // TRUST BOUNDARY. A request presenting an Authorization header must be a
  // valid operator (no silent fallback to anonymous). Anonymous callers may only
  // record top-of-funnel events, always labelled USER_ENTERED, never with an
  // amount, and never self-assigning opportunity/experiment linkage.
  let trusted = false;
  if (request.headers.get('authorization')) {
    const auth = await requireOperator(request, 'api:events');
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
    }
    trusted = true;
  }

  let publicOverrides: ReturnType<typeof sanitizePublicEvent> | null = null;
  if (!trusted) {
    if (!isPublicEventType(raw.eventType)) {
      await auditSecurityEvent({
        kind: 'EVENT_TYPE_REFUSED',
        surface: 'api:events',
        outcome: 'refused',
        detail: `anonymous ${String(raw.eventType).slice(0, 20)}`,
      });
      return NextResponse.json(
        { ok: false, error: 'This event type can only be recorded by a trusted server-side caller (operator credential).' },
        { status: 403 },
      );
    }
    const product = await db.product
      .findUnique({ where: { id: raw.productId.trim() }, select: { id: true, opportunityId: true } })
      .catch(() => null);
    if (!product) {
      return NextResponse.json({ ok: false, error: 'Unknown product.' }, { status: 404 });
    }
    publicOverrides = sanitizePublicEvent(product);
  }

  const result = await recordProductEvent({
    eventType: raw.eventType,
    productId: raw.productId,
    idempotencyKey: raw.idempotencyKey,
    source: raw.source,
    sessionId: (raw.sessionId as string | undefined) ?? null,
    campaignId: (raw.campaignId as string | undefined) ?? null,
    opportunityId: publicOverrides ? publicOverrides.opportunityId : (raw.opportunityId as string | undefined) ?? null,
    experimentId: publicOverrides ? publicOverrides.experimentId : (raw.experimentId as string | undefined) ?? null,
    evidenceType: publicOverrides
      ? publicOverrides.evidenceType
      : raw.evidenceType === 'USER_ENTERED' ? 'USER_ENTERED' : 'VERIFIED_DATA',
    amountUsd: publicOverrides ? publicOverrides.amountUsd : typeof raw.amountUsd === 'number' ? raw.amountUsd : null,
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
  // SECURITY (N3): funnel metrics include purchase counts and revenue — admin
  // session or operator credential required.
  const guard = await guardBrowserOrOperator(request, 'api:events:get', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
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
