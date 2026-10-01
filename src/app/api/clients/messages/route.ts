// ============================================================================
// PHASE 11.1 — CLIENTS API: MESSAGES (admin-only, THE security boundary)
// ============================================================================
// GET  /api/clients/messages?conversationId=&limit= → immutable history
// POST /api/clients/messages { conversationId, direction, role, body,
//                              providerMessageId? }
//
// POST runs the full security boundary (client-service.recordClientMessage):
// bounded body (10k chars — oversize refused, never truncated), deterministic
// classification into trust flags, immutable persistence, counter updates,
// SecurityEvents, HumanReview for suspected injection — and ZERO privileged
// effects. Messages are DATA, never authority.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import {
  getConversationScoped,
  listMessagesForConversation,
  recordClientMessage,
} from '@/lib/clients/client-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:clients:messages';

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
  const conversationId = url.searchParams.get('conversationId');
  const conversation = await getConversationScoped(conversationId);
  if (!conversation) {
    return NextResponse.json({ ok: false, error: 'Conversation not found.' }, { status: 404 });
  }
  const messages = await listMessagesForConversation(
    conversation.id,
    url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  );
  return NextResponse.json({ ok: true, messages });
}

export async function POST(request: Request) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 16_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;

  const result = await recordClientMessage({
    conversationId: raw.conversationId,
    direction: raw.direction,
    role: raw.role,
    body: raw.body,
    providerMessageId: raw.providerMessageId,
    actor: auth.session.email,
    surface: SURFACE,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      ok: true,
      messageId: result.messageId,
      duplicate: result.duplicate,
      trustFlags: result.flags,
      securityFlagged: result.securityFlagged,
    },
    { status: result.duplicate ? 200 : 201 },
  );
}
