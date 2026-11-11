// ============================================================================
// GET /api/research/results/:id — one scoped research artifact
// ============================================================================
// A research result owned by another tenant is reported as 404, exactly like a
// missing id. The stored findings are returned as parsed JSON only when the
// row is inside the caller's partition.

import { NextResponse } from 'next/server';
import { guardBrowserOrOperator } from '@/lib/security/guard';
import { getScopedResearchResult } from '@/lib/tenancy/scoped-reads';
import { resolveTenantScope } from '@/lib/tenancy/scope';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return NextResponse.json({ ok: false, error: 'Invalid research result id' }, { status: 400 });
  }

  const guard = await guardBrowserOrOperator(request, 'api:research:results:id', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const resolved = await resolveTenantScope(request, { permission: 'tenant:read', surface: 'api:research:results:id' });
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  try {
    const row = await getScopedResearchResult(resolved.scope, id);
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Research result not found' }, { status: 404 });
    }
    let findings: unknown = null;
    try { findings = JSON.parse(row.findings); } catch { findings = null; }
    return NextResponse.json(
      {
        ok: true,
        result: {
          id: row.id,
          opportunityId: row.opportunityId,
          pipelineRunId: row.pipelineRunId,
          jobId: row.jobId,
          correlationId: row.correlationId,
          objective: row.objective,
          findings,
          provenance: row.provenance,
          evidenceType: row.evidenceType,
          capabilityStatus: row.capabilityStatus,
          confidence: row.confidence,
          createdAt: row.createdAt.toISOString(),
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ ok: false, error: 'Research result lookup failed.' }, { status: 500 });
  }
}
