// Phase 4.5.2 — Job API.
//
// POST /api/jobs  → queue + execute a job (type-validated, halal-gated).
// GET  /api/jobs  → recent job activity (safe, compact fields only).
//
// Safety: there is NO arbitrary execution path. jobType must be one of the
// registered job types; payloads are shallow-validated against their job
// definition; execution goes exclusively through runJob() → AgentRegistry /
// pipeline orchestrator, where the existing halal and human-review gates run.
// Responses never include agent input payloads, reasoning payloads beyond a
// truncated summary, or any configuration/secrets.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { runJob } from '@/lib/jobs/job-runner';
import { isJobType, type JobPayload } from '@/lib/jobs/types';
import { getRecentJobActivity } from '@/lib/jobs/job-registry';
import { guardOperatorEndpoint, guardBrowserOrOperator, readJsonBody } from '@/lib/security/guard';
import { resolveTenantScope, scopeTenantId } from '@/lib/tenancy/scope';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // SECURITY: operator-only control endpoint (rate-limited, fail-closed).
  const guard = await guardOperatorEndpoint(request, 'api:jobs', { max: 30, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:jobs' });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const raw = bodyGuard.value;
  const { jobType, payload, correlationId } = raw;

  if (!isJobType(jobType)) {
    return NextResponse.json(
      { ok: false, error: 'Unknown jobType. Use one of the registered job types.' },
      { status: 400 },
    );
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json({ ok: false, error: 'payload must be a JSON object' }, { status: 400 });
  }
  if (correlationId !== undefined && (typeof correlationId !== 'string' || correlationId.trim().length === 0 || correlationId.length > 200)) {
    return NextResponse.json({ ok: false, error: 'correlationId must be a non-empty string of at most 200 characters' }, { status: 400 });
  }

  // Phase 4.2D — the job is created INSIDE the caller's authorized tenant. A
  // body-supplied tenant is impossible: the payload has no such field and the
  // runner never reads one.
  const resolved = await resolveTenantScope(request, {
    permission: 'tenant:write',
    surface: 'api:jobs:post',
  });
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  logger.info('Job API dispatch', { jobType });

  try {
    const outcome = await runJob(jobType, payload as JobPayload, correlationId as string | undefined, {
      tenantId: scopeTenantId(resolved.scope),
    });
    return NextResponse.json({ ok: true, job: outcome }, { status: outcome.deduplicated ? 200 : 201 });
  } catch {
    logger.error('Job API execution failed', new Error('job dispatch failed'), { jobType: String(jobType) });
    return NextResponse.json({ ok: false, error: 'Job execution failed unexpectedly. Check the server logs.' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  // Read-only telemetry: rate-limited by IP and gated by the operator credential
  // or an admin session. Phase 4.2D — the list is scoped to the caller's
  // authorized tenant partition; there is no cross-tenant listing.
  const guard = await guardBrowserOrOperator(request, 'api:jobs:get', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  const resolved = await resolveTenantScope(request, {
    permission: 'tenant:read',
    surface: 'api:jobs:get',
  });
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }
  try {
    const activity = await getRecentJobActivity(20, scopeTenantId(resolved.scope));
    return NextResponse.json({
      ok: true,
      tenant: resolved.scope.mode === 'tenant' ? resolved.scope.tenantSlug : null,
      jobs: activity,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Job activity is temporarily unavailable.' }, { status: 500 });
  }
}
