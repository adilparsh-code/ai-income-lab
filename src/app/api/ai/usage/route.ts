// Phase 4.5.1 — AI Usage & Cost API.
//
// Returns SAFE AGGREGATED information only: counters, token sums, estimated
// cost, latency averages, and group labels (provider/model/agent/purpose).
// Never returns API keys, authorization headers, secrets, raw environment
// values, or prompt contents — the aggregation layer deals exclusively in
// AgentLog metadata columns and never selects `input`/`output` payloads.
//
// Cost figures are ESTIMATES from the isolated price table (see
// src/lib/ai/models.ts) and are labelled as such in every response.
// Authentication/authorization reuses the app's existing posture: this is a
// server-only route, the aggregation never includes per-row prompt payloads,
// and no write operations exist here.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/server-log';
import {
  aggregateUsageForRange,
  isUsageTimeRange,
  type UsageTimeRange,
  type UsageLogRow,
} from '@/lib/ai/usage';
import { getEfficiencyViews } from '@/lib/ai/usage-server';
import { guardOperatorEndpoint } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // SECURITY: AI spend/cost telemetry is sensitive business information —
  // operator-only (rate-limited). The page view uses the same data via a
  // server component, so the UI is unaffected.
  const guard = await guardOperatorEndpoint(request, 'api:ai/usage', { max: 60, windowSeconds: 60 });
  if ('response' in guard) {
    return NextResponse.json(guard.response, { status: guard.status });
  }
  try {
    const url = new URL(request.url);
    const rawRange = url.searchParams.get('range') ?? '7d';
    const range: UsageTimeRange = isUsageTimeRange(rawRange) ? rawRange : '7d';

    // Select ONLY metadata columns. Prompt/response payloads (`input`,
    // `output`) and free-text reasoning are deliberately excluded from the
    // query itself so they can never leak into the response.
    const rows = (await db.agentLog.findMany({
      where: {
        // The start boundary is enforced here (all-time = no where filter).
        ...(range !== 'all'
          ? { createdAt: { gte: rangeStart(range) } }
          : {}),
      },
      select: {
        agentType: true,
        action: true,
        aiProvider: true,
        aiModel: true,
        inputTokens: true,
        outputTokens: true,
        estimatedCostUsd: true,
        fallbackUsed: true,
        purpose: true,
        latencyMs: true,
        success: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })) as unknown as UsageLogRow[];

    const summary = aggregateUsageForRange(rows, range);

    // Phase 4.5.3 — efficiency, token-budget, and treasury views. Efficiency
    // counters are PROCESS-LOCAL estimates; treasury is internal accounting
    // (no money movement). Any failure degrades to omitted fields, never a
    // fabricated number.
    let efficiencyViews: Awaited<ReturnType<typeof getEfficiencyViews>> | null = null;
    try {
      efficiencyViews = await getEfficiencyViews();
    } catch (efficiencyError) {
      logger.warn('Efficiency views unavailable; returning usage-only summary', {
        error: efficiencyError instanceof Error ? efficiencyError.message.slice(0, 150) : String(efficiencyError).slice(0, 150),
      });
    }

    return NextResponse.json({
      ok: true,
      ...summary,
      ...(efficiencyViews ?? {}),
      notes: [
        'Cost figures are ESTIMATES computed from an isolated price table, not billing data.',
        'Efficiency/savings figures are PROCESS-LOCAL estimates from dedup and cache hits in this server instance.',
        'The treasury view is internal accounting only: no bank accounts, wallets, or transfers exist.',
        'Executions without recorded AI metadata are counted as deterministic/mock runs.',
        'No prompt contents, API keys, or environment values are included in this response.',
      ],
    });
  } catch (error) {
    logger.error('AI usage endpoint failed', error, {});
    return NextResponse.json(
      {
        ok: false,
        error: 'AI usage summary is temporarily unavailable. Check the server logs.',
      },
      { status: 500 },
    );
  }
}

/** UTC day-boundary start for bounded ranges (mirrors the pure layer). */
function rangeStart(range: UsageTimeRange): Date {
  const now = new Date();
  if (range === 'today') {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }
  const daysBack = range === '7d' ? 6 : range === '30d' ? 29 : 0;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - daysBack);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}
