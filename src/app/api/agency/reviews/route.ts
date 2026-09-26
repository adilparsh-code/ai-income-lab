// ============================================================================
// AGENCY API — HUMAN REVIEW QUEUE (admin-only)
// ============================================================================
// GET  /api/agency/reviews?status=PENDING → the review queue.
// POST /api/agency/reviews                → record an admin decision.
//
// Decisions are audited (SecurityEvent) and never logged with credentials.
// Only PENDING reviews can be decided; decided rows are immutable history.
// ============================================================================

import { NextResponse } from 'next/server';
import { createHumanReview, decideHumanReview, listHumanReviews } from '@/lib/agency/runtime';
import { isHumanReviewCategory } from '@/lib/agency/types';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import { logger } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'RETIRED'] as const;
type ReviewStatusFilter = (typeof REVIEW_STATUSES)[number];

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:reviews', identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:reviews', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const status = statusParam && (REVIEW_STATUSES as readonly string[]).includes(statusParam)
    ? statusParam as ReviewStatusFilter
    : undefined;

  try {
    const reviews = await listHumanReviews(status);
    return NextResponse.json({ ok: true, reviews });
  } catch (error) {
    logger.warn('Human review queue unavailable', { error: String(error).slice(0, 150) });
    return NextResponse.json({ ok: false, error: 'Review queue is temporarily unavailable.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: 'api:agency:reviews:post', identity: ip, max: 30, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: 'api:agency:reviews:post', outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi();
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: 'api:agency:reviews', maxChars: 4_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  // Decision mode: { id, decision, note? }
  if (typeof raw.id === 'string') {
    const decision = typeof raw.decision === 'string' ? raw.decision.toUpperCase() : '';
    if (!['APPROVE', 'REJECT', 'PAUSE', 'RETRY'].includes(decision)) {
      return NextResponse.json({ ok: false, error: 'decision must be APPROVE | REJECT | PAUSE | RETRY.' }, { status: 400 });
    }
    try {
      const result = await decideHumanReview({
        id: raw.id,
        decision: decision as 'APPROVE' | 'REJECT' | 'PAUSE' | 'RETRY',
        decidedBy: auth.session.email,
        note: typeof raw.note === 'string' ? raw.note : undefined,
      });
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
      }
      return NextResponse.json({ ok: true, review: result.review });
    } catch (error) {
      logger.warn('Review decision failed', { error: String(error).slice(0, 150) });
      return NextResponse.json({ ok: false, error: 'Decision could not be recorded (storage error).' }, { status: 503 });
    }
  }

  // Creation mode: { category, title, detail?, requestedBy? }
  if (typeof raw.category !== 'string' || !isHumanReviewCategory(raw.category)) {
    return NextResponse.json({ ok: false, error: 'category must be a valid review category.' }, { status: 400 });
  }
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0 || raw.title.length > 200) {
    return NextResponse.json({ ok: false, error: 'title is required (at most 200 characters).' }, { status: 400 });
  }
  try {
    const result = await createHumanReview({
      category: raw.category,
      title: raw.title,
      detail: typeof raw.detail === 'string' ? raw.detail : undefined,
      requestedBy: typeof raw.requestedBy === 'string' ? raw.requestedBy : 'system',
      opportunityId: typeof raw.opportunityId === 'string' ? raw.opportunityId : null,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
  } catch (error) {
    logger.warn('Review creation failed', { error: String(error).slice(0, 150) });
    return NextResponse.json({ ok: false, error: 'Review could not be created (storage error).' }, { status: 503 });
  }
}
