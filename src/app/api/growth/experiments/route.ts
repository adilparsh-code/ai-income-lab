// Phase 9 — Growth Experiments API.
//
// GET  /api/growth/experiments → recent bounded experiments (safe fields only).
// POST /api/growth/experiments → create a bounded experiment through the full
//                                 validation chain: budget hard caps → halal
//                                 gate → allocation-aware clamping → idempotent
//                                 persistence → Job Runner handoff. There is no
//                                 direct AI/agent execution path from this API.
//
// SECURITY: operator-only, rate-limited, bounded request bodies, idempotent on
// idempotencyKey; responses never include agent payloads or secrets.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { createGrowthExperiment, listGrowthExperiments } from '@/lib/growth';
import { guardOperatorEndpoint, readJsonBody } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = await guardOperatorEndpoint(request, 'api:growth:experiments:get', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const experiments = await listGrowthExperiments({ limit: 20 });
    return NextResponse.json({ ok: true, experiments });
  } catch (error) {
    logger.error('Growth experiments read failed', { error: String(error) });
    return NextResponse.json(
      { ok: false, error: 'Growth experiments are temporarily unavailable (data layer error).' },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  // SECURITY: creating an experiment spends real budget — operator-only,
  // tightly rate-limited, bounded body.
  const guard = await guardOperatorEndpoint(request, 'api:growth:experiments', { max: 10, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }

  const bodyGuard = await readJsonBody(request, { surface: 'api:growth:experiments', maxChars: 4_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }

  const raw = bodyGuard.value as Record<string, unknown>;
  const required = ['opportunityId', 'experimentType', 'hypothesis', 'metric', 'targetValue', 'requestedBudgetUsd', 'requestedDurationDays', 'idempotencyKey', 'correlationId'] as const;
  const missing = required.filter((k) => raw[k] === undefined);
  if (missing.length > 0) {
    return NextResponse.json(
      { ok: false, error: `Missing required fields: ${missing.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    const result = await createGrowthExperiment({
      opportunityId: String(raw.opportunityId),
      experimentType: String(raw.experimentType),
      hypothesis: String(raw.hypothesis),
      metric: String(raw.metric),
      targetValue: Number(raw.targetValue),
      requestedBudgetUsd: Number(raw.requestedBudgetUsd),
      requestedDurationDays: Number(raw.requestedDurationDays),
      idempotencyKey: String(raw.idempotencyKey),
      correlationId: String(raw.correlationId),
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error, errors: result.errors }, { status: result.status });
    }
    return NextResponse.json(
      { ok: true, experimentId: result.experimentId, status: result.status, deduplicated: result.deduplicated, notes: result.notes },
      { status: result.deduplicated ? 200 : 201 },
    );
  } catch (error) {
    logger.error('Growth experiment creation failed', { error: String(error) });
    return NextResponse.json(
      { ok: false, error: 'Experiment creation failed unexpectedly. Check the server logs.' },
      { status: 500 },
    );
  }
}
