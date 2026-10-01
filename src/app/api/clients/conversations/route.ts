// ============================================================================
// PHASE 11.1 — CLIENTS API: CONVERSATIONS (admin-only)
// ============================================================================
// GET  /api/clients/conversations?prospectId=&limit=   → list for a prospect
// POST /api/clients/conversations { prospectId, channel } → create thread
//
// Object-level authorization: listing requires prospectId and every returned
// row is scoped to that prospect. No provider wiring — channels are recorded
// data (Phase 11.1 sends nothing).
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import {
  createConversation,
  getProspectById,
  listConversationsForProspect,
} from '@/lib/clients/client-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:clients:conversations';

export async function GET(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const prospectId = url.searchParams.get('prospectId');
  const prospect = await getProspectById(prospectId);
  if (!prospect) {
    return NextResponse.json({ ok: false, error: 'Prospect not found.' }, { status: 404 });
  }
  const conversations = await listConversationsForProspect(prospect.id, url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined);
  return NextResponse.json({ ok: true, conversations });
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 30, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 2_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  const result = await createConversation({
    prospectId: raw.prospectId,
    channel: raw.channel ?? 'EMAIL',
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, conversationId: result.conversationId }, { status: 201 });
}
