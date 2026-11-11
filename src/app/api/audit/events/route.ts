// ============================================================================
// GET /api/audit/events — tenant-scoped security audit visibility
// ============================================================================
// Requires an admin session AND an authorized tenant-admin permission. The
// query is scoped to the caller's partition: a tenant administrator can never
// read another tenant's events, and the legacy partition (global events) is
// only visible in legacy mode.
//
// Bounded output only: kind/outcome/surface/detail/createdAt. Detail is already
// a short classification and must never contain credentials.

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit } from '@/lib/security/guard';
import { listScopedSecurityEvents } from '@/lib/tenancy/scoped-reads';
import { resolveTenantScope } from '@/lib/tenancy/scope';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:audit:events';

export async function GET(request: Request) {
  const limit = await enforceRateLimit({ surface: SURFACE, identity: clientIpFrom(request), max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }

  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  // Audit visibility is administrative: a plain reader role is not enough.
  const resolved = await resolveTenantScope(request, { permission: 'tenant:admin', surface: SURFACE });
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') ?? undefined;
  const take = Number(url.searchParams.get('take') ?? '50');

  try {
    const events = await listScopedSecurityEvents(resolved.scope, {
      take: Number.isFinite(take) ? take : 50,
      ...(kind ? { kind: kind.slice(0, 80) } : {}),
    });
    return NextResponse.json(
      {
        ok: true,
        tenant: resolved.scope.mode === 'tenant' ? resolved.scope.tenantSlug : null,
        events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ ok: false, error: 'Audit log is temporarily unavailable.' }, { status: 503 });
  }
}
