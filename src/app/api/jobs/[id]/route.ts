// Phase 4.5.2 / 4.2D — Job inspection API.
// GET /api/jobs/:id → safe status detail for one job INSIDE the caller's
// authorized tenant partition. Returns job metadata and the compact output
// summary — never the raw agent input payload, prompts, or secrets.
//
// A job owned by another tenant is reported as 404, exactly like a missing id,
// so the endpoint cannot be used to discover foreign work.

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { getScopedJob } from '@/lib/tenancy/scoped-reads';
import { resolveTenantScope } from '@/lib/tenancy/scope';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return NextResponse.json({ ok: false, error: 'Invalid job id' }, { status: 400 });
  }

  // SECURITY: job metadata is admin data — session-gated (IDOR hardening: an
  // unauthenticated caller cannot enumerate job ids).
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const resolved = await resolveTenantScope(request, {
    permission: 'tenant:read',
    surface: 'api:jobs:id',
  });
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  try {
    const row = await getScopedJob(resolved.scope, id);
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 });
    }

    // output/resultRef were written by the runner as compact safe summaries.
    let output: unknown = null;
    try { output = row.output ? JSON.parse(row.output) : null; } catch { output = null; }
    let resultRef: unknown = null;
    try { resultRef = row.resultRef ? JSON.parse(row.resultRef) : null; } catch { resultRef = null; }

    return NextResponse.json({
      ok: true,
      job: {
        id: row.id,
        jobType: row.jobType,
        status: row.status,
        correlationId: row.correlationId,
        opportunityId: row.opportunityId,
        agentType: row.agentType,
        executionMode: row.executionMode,
        retryCount: row.retryCount,
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        error: row.error,
        output,
        resultRef,
        // Deliberately omitted: `input` (agent payload), raw output payloads.
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Job lookup failed. Check the server logs.' }, { status: 500 });
  }
}
