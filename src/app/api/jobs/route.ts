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
import { guardOperatorEndpoint, readJsonBody } from '@/lib/security/guard';

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

  logger.info('Job API dispatch', { jobType });

  try {
    const outcome = await runJob(jobType, payload as JobPayload, correlationId as string | undefined);
    return NextResponse.json({ ok: true, job: outcome }, { status: outcome.deduplicated ? 200 : 201 });
  } catch {
    logger.error('Job API execution failed', new Error('job dispatch failed'), { jobType: String(jobType) });
    return NextResponse.json({ ok: false, error: 'Job execution failed unexpectedly. Check the server logs.' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  // Read-only operator telemetry: rate-limited by IP, credential required so
  // job activity (which can reveal workload patterns) is not publicly readable.
  const guard = await guardOperatorEndpoint(request, 'api:jobs:get', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const activity = await getRecentJobActivity(20);
    return NextResponse.json({ ok: true, jobs: activity });
  } catch {
    return NextResponse.json({ ok: false, error: 'Job activity is temporarily unavailable.' }, { status: 500 });
  }
}
