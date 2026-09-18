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

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
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

    return NextResponse.json({
      ok: true,
      ...summary,
      notes: [
        'Cost figures are ESTIMATES computed from an isolated price table, not billing data.',
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
