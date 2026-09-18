// Phase 4.5.1 — server-side loader for AI usage summaries.
// Thin DB adapter over the pure aggregation layer: selects AgentLog metadata
// columns only (never input/output/reasoning payloads) and delegates all math
// to src/lib/ai/usage.ts.

import { db } from '@/lib/db';
import {
  aggregateUsageForRange,
  type AiUsageSummary,
  type UsageTimeRange,
  type UsageLogRow,
} from '@/lib/ai/usage';

export type { AiUsageSummary, UsageTimeRange };

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

/**
 * Aggregate recorded AI usage for a time range. Exported for dashboard/server
 * use; the API route and the /ai-usage page use the same selection strategy.
 */
export async function getAiUsageForRange(range: UsageTimeRange = '7d'): Promise<AiUsageSummary> {
  const rows = (await db.agentLog.findMany({
    where: range !== 'all' ? { createdAt: { gte: rangeStart(range) } } : {},
    select: {
      agentType: true,
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

  return aggregateUsageForRange(rows, range);
}
