// ============================================================================
// ADMIN API — HUMAN-GATED POLAR PUBLICATION OF ONE OFFER
// ============================================================================
// POST /api/commercial/offers/[offerId]/publish
//   body: { humanApprovalToken: string }
//
// The ONLY publish surface for offers. Safety order (fail-closed):
//   1. per-IP rate limit (DB-backed, shared across instances)
//   2. requireAdminApi — a real, audited admin session (existing auth, unchanged)
//   3. bounded strict JSON parse
//   4. explicit human approval token required (bounded, never logged/stored raw)
//   5. offer gates (ACTIVE + HALAL + price > 0 + display-time screening +
//      linked product + delivery info) inside publishOfferToPolar()
//   6. adapter re-checks config + token, verifies the provider round-trip,
//      then the verified URL is persisted into existing Product fields.
//
// Nothing here can publish autonomously: step 2 needs the single admin's
// session and step 4 needs an explicit per-publication token.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { publishOfferToPolar } from '@/lib/integrations/offer-publishing';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:offers:publish';

export async function POST(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 10, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json(
      { ok: false, error: 'Rate limit exceeded. Retry later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 4_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  if (typeof raw.humanApprovalToken !== 'string' || raw.humanApprovalToken.trim().length === 0 || raw.humanApprovalToken.length > 512) {
    return NextResponse.json(
      { ok: false, error: 'humanApprovalToken is required (explicit per-publication approval, max 512 chars).' },
      { status: 400 },
    );
  }

  const { offerId } = await params;
  const result = await publishOfferToPolar({
    offerId,
    humanApprovalToken: raw.humanApprovalToken,
    actor: auth.session.email,
    surface: SURFACE,
  });

  switch (result.status) {
    case 'PUBLISHED':
    case 'ALREADY_PUBLISHED':
      return NextResponse.json(
        {
          ok: true,
          status: result.status,
          publicationId: result.publicationId,
          publicationUrl: result.publicationUrl,
          reason: result.reason,
        },
        { status: 200 },
      );
    case 'NOT_FOUND':
      return NextResponse.json({ ok: false, status: result.status, error: result.errors?.[0] ?? 'Offer not found.' }, { status: 404 });
    case 'AUTH_REQUIRED':
      return NextResponse.json(
        {
          ok: false,
          status: result.status,
          error: result.errors?.[0] ?? 'Polar is not configured server-side.',
          configurationVariables: ['POLAR_ACCESS_TOKEN'],
        },
        { status: 503 },
      );
    case 'VALIDATION':
      return NextResponse.json({ ok: false, status: result.status, errors: result.errors ?? [] }, { status: 422 });
    case 'PROVIDER_FAILED':
    default:
      return NextResponse.json(
        { ok: false, status: result.status, error: result.reason ?? 'Provider publication failed; nothing was claimed as published.' },
        { status: 502 },
      );
  }
}
