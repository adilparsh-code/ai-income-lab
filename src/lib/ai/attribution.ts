// Phase 5.4 — Per-product AI cost attribution (Part 5).
//
// Extends the LIVE business-wide AI usage layer with product/opportunity/
// experiment/job scope attribution. The SINGLE AI generation choke point and
// its controls (dedup, cache, token budgets, model routing, retries, early
// stopping, treasury) are untouched — attribution happens at the AgentLog
// aggregation layer, one row per execution, so the same AI execution can
// never be double-counted.
//
// Provenance: every figure here is ESTIMATED (token-based model pricing),
// never presented as a provider bill. Rows lacking attribution fields fall in
// the 'unattributed' bucket rather than being guessed at.

import { db } from '@/lib/db';

export interface AttributionScope {
  productId?: string | null;
  opportunityId?: string | null;
  experimentId?: string | null;
  jobId?: string | null;
  correlationId?: string | null;
}

export interface AttributedCostBucket {
  executions: number;
  inputTokens: number;
  outputTokens: number;
  /** ESTIMATED cost in USD (token-based), never a provider bill. */
  estimatedCostUsd: number;
}

export interface ProductAttributionSummary {
  basis: 'ESTIMATED_TOKEN_BASED';
  productId: string;
  aiInputCostUsd: number;
  aiOutputCostUsd: number;
  aiTotalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  executions: number;
}

/** Split an estimated cost between input and output tokens proportionally. */
function splitCost(row: { inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null }): {
  input: number;
  output: number;
} {
  const cost = row.estimatedCostUsd ?? 0;
  const inTok = row.inputTokens ?? 0;
  const outTok = row.outputTokens ?? 0;
  const total = inTok + outTok;
  if (total === 0 || cost === 0) return { input: 0, output: 0 };
  return { input: (cost * inTok) / total, output: (cost * outTok) / total };
}

/**
 * Aggregate AgentLog rows for one product. Idempotent by construction: reads
 * are pure aggregation over persisted rows — calling twice yields the same
 * numbers, and each execution's log row is counted exactly once.
 */
export async function getProductAiCostAttribution(productId: string): Promise<ProductAttributionSummary> {
  const rows = await db.agentLog.findMany({
    where: { productId },
    select: {
      inputTokens: true,
      outputTokens: true,
      estimatedCostUsd: true,
    },
  });

  let inputCost = 0;
  let outputCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    const split = splitCost(row);
    inputCost += split.input;
    outputCost += split.output;
    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
  }

  return {
    basis: 'ESTIMATED_TOKEN_BASED',
    productId,
    aiInputCostUsd: inputCost,
    aiOutputCostUsd: outputCost,
    aiTotalCostUsd: inputCost + outputCost,
    inputTokens,
    outputTokens,
    executions: rows.length,
  };
}

/**
 * Attribution breakdown by scope for dashboards/audits. Unattributed rows are
 * reported honestly as their own bucket.
 */
export async function getAiCostAttributionBreakdown(window: { start: Date; end: Date }): Promise<{
  basis: 'ESTIMATED_TOKEN_BASED';
  byProduct: Record<string, AttributedCostBucket>;
  byOpportunity: Record<string, AttributedCostBucket>;
  unattributed: AttributedCostBucket;
  totals: AttributedCostBucket;
}> {
  const rows = await db.agentLog.findMany({
    where: { createdAt: { gte: window.start, lte: window.end } },
    select: {
      productId: true,
      opportunityId: true,
      inputTokens: true,
      outputTokens: true,
      estimatedCostUsd: true,
    },
  });

  const emptyBucket = (): AttributedCostBucket => ({ executions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  const byProduct: Record<string, AttributedCostBucket> = {};
  const byOpportunity: Record<string, AttributedCostBucket> = {};
  const unattributed = emptyBucket();
  const totals = emptyBucket();

  const add = (bucket: AttributedCostBucket, row: { inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null }) => {
    bucket.executions += 1;
    bucket.inputTokens += row.inputTokens ?? 0;
    bucket.outputTokens += row.outputTokens ?? 0;
    bucket.estimatedCostUsd += row.estimatedCostUsd ?? 0;
  };

  for (const row of rows) {
    add(totals, row);
    if (row.productId) add(byProduct[row.productId] ??= emptyBucket(), row);
    if (row.opportunityId) add(byOpportunity[row.opportunityId] ??= emptyBucket(), row);
    if (!row.productId && !row.opportunityId) add(unattributed, row);
  }

  return { basis: 'ESTIMATED_TOKEN_BASED', byProduct, byOpportunity, unattributed, totals };
}
