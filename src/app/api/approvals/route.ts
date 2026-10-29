// ============================================================================
// POST /api/approvals — mint a single-use human approval
// ============================================================================
// Admin session ONLY. The operator bearer token deliberately cannot mint
// approvals: an approval represents a human decision. Body:
//   { action: ApprovalAction, subjectId: string }
// The server resolves and binds the subject's current state itself. The
// returned token is shown once, expires in 10 minutes, and is spent by the
// first successful publish/deploy/rollback/transition it authorizes.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import {
  auditSecurityEvent,
  clientIpFrom,
  enforceRateLimit,
  readJsonBody,
  requireSameOriginIfBrowser,
} from '@/lib/security/guard';
import { APPROVAL_ACTIONS, isApprovalAction } from '@/lib/security/approvals-core';
import { issueApproval } from '@/lib/security/approvals';
import { resolveApprovalScope } from '@/lib/security/approval-scope';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:approvals:issue';

export async function POST(request: Request) {
  const limit = await enforceRateLimit({ surface: SURFACE, identity: clientIpFrom(request), max: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, {
      status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) },
    });
  }

  const origin = await requireSameOriginIfBrowser(request, SURFACE);
  if (!origin.ok) return NextResponse.json({ ok: false, error: origin.error }, { status: origin.status });

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 1_000 });
  if (!bodyGuard.ok) return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  const { action, subjectId } = bodyGuard.value;

  if (!isApprovalAction(action)) {
    return NextResponse.json({ ok: false, error: `action must be one of: ${Object.keys(APPROVAL_ACTIONS).join(', ')}` }, { status: 400 });
  }
  if (typeof subjectId !== 'string' || subjectId.length === 0 || subjectId.length > 128) {
    return NextResponse.json({ ok: false, error: 'subjectId is required (max 128 chars).' }, { status: 400 });
  }

  const scope = await resolveApprovalScope(action, subjectId);
  if (!scope.ok) return NextResponse.json({ ok: false, error: scope.error }, { status: 404 });

  const issued = await issueApproval({
    action,
    subjectId,
    scopeHash: scope.scopeHash,
    approver: { sessionId: auth.session.sessionId, email: auth.session.email },
  });
  await auditSecurityEvent({
    kind: 'APPROVAL_ISSUED',
    surface: SURFACE,
    outcome: 'ok',
    detail: `action=${action} subject=${subjectId.slice(0, 24)} grant=${issued.grantId.slice(0, 12)}`.slice(0, 300),
  });

  return NextResponse.json(
    { ok: true, approval: { token: issued.token, action, subjectId, expiresAt: issued.expiresAt.toISOString(), singleUse: true } },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}
