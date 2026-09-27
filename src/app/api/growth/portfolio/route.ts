// Phase 9 — Growth Portfolio API (read-only).
//
// GET /api/growth/portfolio → deterministic portfolio evaluation from REAL
// recorded rows: traffic/conversions/revenue aggregates, health, trend,
// confidence, score, explanation, plus active experiments, recent decisions
// and learnings. No figures are invented; rows without recorded activity are
// labelled NEEDS_DATA rather than fabricated.
//
// SECURITY: operator-only, rate-limited, safe aggregates only — no prompts,
// no secrets, no raw event payloads.

import { NextResponse } from 'next/server';
import { logger } from '@/lib/server-log';
import { getGrowthDashboardView } from '@/lib/growth';
import { guardOperatorEndpoint } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guard = await guardOperatorEndpoint(request, 'api:growth:portfolio', { max: 30, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const view = await getGrowthDashboardView();
    return NextResponse.json({ ok: true, view });
  } catch (error) {
    logger.error('Growth portfolio read failed', { error: String(error) });
    return NextResponse.json(
      { ok: false, error: 'Growth portfolio is temporarily unavailable (data layer error). Nothing was fabricated.' },
      { status: 503 },
    );
  }
}
