// ============================================================================
// GET /api/tenant/context — the caller's authorized scope
// ============================================================================
// Returns what the server ACTUALLY resolved for this request: the principal's
// partition, the authorized tenant (if any) and the role. This is a read-only
// echo of an authorization decision made here, never a client-controlled value.
//
// `mode: "legacy"` means the principal has no tenant membership and can only
// see pre-tenancy (unattributed) rows. It is not a tenant fallback.

import { NextResponse } from 'next/server';
import { guardBrowserOrOperator } from '@/lib/security/guard';
import { resolveTenantScope, TENANT_COOKIE, TENANT_HEADER } from '@/lib/tenancy/scope';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:tenant:context', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const resolved = await resolveTenantScope(request, { permission: 'tenant:read', surface: 'api:tenant:context' });
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  const scope = resolved.scope;
  return NextResponse.json(
    {
      ok: true,
      context: scope.mode === 'tenant'
        ? { mode: 'tenant', tenant: { id: scope.tenantId, slug: scope.tenantSlug }, role: scope.role }
        : { mode: 'legacy', tenant: null, role: null },
      selection: { header: TENANT_HEADER, cookie: TENANT_COOKIE },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
