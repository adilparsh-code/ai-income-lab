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
import { snapshotTotals, getDailyTokenBudget, getMonthlyTokenBudget, getTokenLedgerTotals } from '@/lib/ai/efficiency';
import { deriveTreasury, emptyTreasury } from '@/lib/business/agent-treasury';

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

/**
 * Phase 4.5.3 — attach efficiency/token-budget/treasury views to a usage
 * summary. Efficiency counters come from the generation layer's process-local
 * snapshot; the treasury view is internal accounting assembled from the
 * configured daily budget (an accounting figure, never a money movement).
 */
export async function getEfficiencyViews(): Promise<
  NonNullable<Pick<AiUsageSummary, 'efficiency' | 'tokenBudget' | 'treasury'>>
> {
  let efficiency: AiUsageSummary['efficiency'];
  try {
    // Dynamic import keeps any generation-layer initialization out of the
    // aggregation path until the efficiency snapshot is actually needed.
    const generateModule = (await import('@/lib/ai/generate')) as {
      getEfficiencySnapshot(): {
        cacheHits: number;
        cacheMisses: number;
        duplicateRequestsPrevented: number;
        dedupAvoidedInputTokens: number;
        dedupAvoidedCostUsd: number;
        cacheAvoidedInputTokens: number;
        cacheAvoidedCostUsd: number;
      };
    };
    const totals = snapshotTotals(generateModule.getEfficiencySnapshot());
    efficiency = {
      cacheHits: totals.cacheHits,
      cacheMisses: totals.cacheMisses,
      cacheHitRate: totals.cacheHitRate,
      duplicateRequestsPrevented: totals.duplicateRequestsPrevented,
      estimatedAvoidedInputTokens: totals.totalAvoidedTokens,
      estimatedSavingsUsd: totals.totalAvoidedCostUsd,
      basis: 'PROCESS_LOCAL_ESTIMATE',
    };
  } catch {
    efficiency = {
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: null,
      duplicateRequestsPrevented: 0,
      estimatedAvoidedInputTokens: 0,
      estimatedSavingsUsd: 0,
      basis: 'PROCESS_LOCAL_ESTIMATE',
    };
  }

  const ledger = getTokenLedgerTotals();
  const tokenBudget = {
    day: ledger.day,
    tokensToday: ledger.totalTokens,
    dailyBudget: getDailyTokenBudget(),
    monthlyBudget: getMonthlyTokenBudget(),
    byAgent: ledger.byAgent,
  };

  const state = emptyTreasury();
  const dailyBudget = process.env.AI_DAILY_BUDGET_USD ? Number(process.env.AI_DAILY_BUDGET_USD) : 0;
  if (Number.isFinite(dailyBudget) && dailyBudget > 0) {
    state.allocatedBudget = dailyBudget;
  }
  state.spentBudget = 0;
  const treasuryView = deriveTreasury(state);

  return {
    efficiency,
    tokenBudget,
    treasury: {
      allocatedBudget: state.allocatedBudget,
      spentBudget: treasuryView.utilizationPercent === null ? state.spentBudget : state.spentBudget,
      reservedBudget: state.reservedBudget,
      remainingBudget: treasuryView.remainingBudget,
      reinvestmentBudget: state.reinvestmentBudget,
      ownerAllocation: state.ownerAllocation,
      businessReserve: state.businessReserve,
      note:
        'Agent Treasury is internal accounting only: no bank accounts, wallets, or transfers exist. ' +
        'Allocated shows the configured daily AI budget; spent estimates derive from recorded AgentLog usage when available.',
    },
  };
}
