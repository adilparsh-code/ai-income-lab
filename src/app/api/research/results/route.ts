// ============================================================================
// GET /api/research/results — scoped research artifacts
// ============================================================================
// Lists the RESEARCH -> VALIDATION provenance artifacts visible to the caller's
// authorized tenant. `?opportunityId=` narrows to one opportunity, but a foreign
// opportunity simply yields an empty list (no existence disclosure).

import { NextResponse } from 'next/server';
import { guardBrowserOrOperator } from '@/lib/security/guard';
import { listScopedResearchResults } from '@/lib/tenancy/scoped-reads';
import { resolveTenantScope } from '@/lib/tenancy/scope';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = await guardBrowserOrOperator(request, 'api:research:results', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const resolved = await resolveTenantScope(request, { permission: 'tenant:read', surface: 'api:research:results' });
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  const url = new URL(request.url);
  const opportunityId = url.searchParams.get('opportunityId') ?? undefined;
  const take = Number(url.searchParams.get('take') ?? '20');

  try {
    const rows = await listScopedResearchResults(resolved.scope, {
      ...(opportunityId ? { opportunityId: opportunityId.slice(0, 128) } : {}),
      take: Number.isFinite(take) ? take : 20,
    });
    return NextResponse.json(
      {
        ok: true,
        tenant: resolved.scope.mode === 'tenant' ? resolved.scope.tenantSlug : null,
        results: rows.map((r) => ({
          id: r.id,
          opportunityId: r.opportunityId,
          pipelineRunId: r.pipelineRunId,
          jobId: r.jobId,
          correlationId: r.correlationId,
          objective: r.objective,
          provenance: r.provenance,
          evidenceType: r.evidenceType,
          capabilityStatus: r.capabilityStatus,
          confidence: r.confidence,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ ok: false, error: 'Research results are temporarily unavailable.' }, { status: 503 });
  }
}
