// Phase 10.8 — Income & Profit Observatory.
//
// Deterministic aggregations over existing Revenue rows + AgentLog AI cost
// rows. Groupings without data stay empty; totals with no rows are UNKNOWN,
// never silently zero (Phase 10.15). Currency is treated as recorded: rows are
// summed per recorded currency and mixed currencies surface as UNKNOWN rather
// than a meaningless sum.

import { db } from '@/lib/db';
import type { DataQuality, PnlBreakdownRow, PnlObservatory } from './types';

interface RevenueSelectRow {
  id: string;
  date: Date;
  revenueSource: string;
  grossRevenue: number;
  fees: number;
  advertisingCost: number;
  otherCosts: number;
  netRevenue: number;
  currency: string;
  productId: string | null;
  opportunityId: string | null;
  createdAt: Date;
}

const selectFields = {
  id: true,
  date: true,
  revenueSource: true,
  grossRevenue: true,
  fees: true,
  advertisingCost: true,
  otherCosts: true,
  netRevenue: true,
  currency: true,
  productId: true,
  opportunityId: true,
  createdAt: true,
} as const;

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function emptyRow(key: string): PnlBreakdownRow {
  return {
    key,
    grossRevenueUsd: 0,
    feesUsd: 0,
    advertisingCostUsd: 0,
    otherCostsUsd: 0,
    netRevenueUsd: 0,
    entries: 0,
  };
}

function groupBy(
  rows: RevenueSelectRow[],
  keyOf: (row: RevenueSelectRow) => string,
): PnlBreakdownRow[] {
  const map = new Map<string, PnlBreakdownRow>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = map.get(key) ?? emptyRow(key);
    entry.grossRevenueUsd += row.grossRevenue;
    entry.feesUsd += row.fees;
    entry.advertisingCostUsd += row.advertisingCost;
    entry.otherCostsUsd += row.otherCosts;
    entry.netRevenueUsd += row.netRevenue;
    entry.entries += 1;
    map.set(key, entry);
  }
  return [...map.values()]
    .map((r) => ({
      ...r,
      grossRevenueUsd: Math.round(r.grossRevenueUsd * 100) / 100,
      feesUsd: Math.round(r.feesUsd * 100) / 100,
      advertisingCostUsd: Math.round(r.advertisingCostUsd * 100) / 100,
      otherCostsUsd: Math.round(r.otherCostsUsd * 100) / 100,
      netRevenueUsd: Math.round(r.netRevenueUsd * 100) / 100,
    }))
    .sort((a, b) => b.grossRevenueUsd - a.grossRevenueUsd || a.key.localeCompare(b.key));
}

export async function getPnlObservatory(): Promise<PnlObservatory> {
  const [revenues, aiCostRows] = await Promise.all([
    db.revenue.findMany({ select: selectFields, orderBy: { date: 'desc' }, take: 2000 }),
    db.agentLog.findMany({
      where: { estimatedCostUsd: { not: null } },
      select: { agentType: true, estimatedCostUsd: true, productId: true, opportunityId: true },
      take: 2000,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Currency integrity: summing across currencies would fabricate a number.
  const currencies = new Set(revenues.map((r) => r.currency));
  const singleCurrency = currencies.size <= 1 ? ([...currencies][0] ?? 'USD') : null;

  const sum = (pick: (r: RevenueSelectRow) => number) =>
    Math.round(revenues.reduce((acc, r) => acc + pick(r), 0) * 100) / 100;

  const grossRevenueUsd = sum((r) => r.grossRevenue);
  const totalCostUsd = sum((r) => r.fees + r.advertisingCost + r.otherCosts);
  const netContributionUsd = sum((r) => r.netRevenue);

  const quality: DataQuality =
    revenues.length === 0 ? 'UNKNOWN' : singleCurrency ? 'REAL' : 'UNKNOWN';

  const totalsSource =
    revenues.length === 0
      ? 'No Revenue rows recorded yet — not proven zero'
      : singleCurrency
        ? `Sum of ${revenues.length} Revenue rows (currency ${singleCurrency})`
        : `Mixed currencies (${[...currencies].join(', ')}) — not summed into one figure`;

  const aiCostUsd =
    Math.round(aiCostRows.reduce((acc, r) => acc + (r.estimatedCostUsd ?? 0), 0) * 10000) / 10000;

  const aiCostByAgentMap = new Map<string, { cost: number; entries: number }>();
  for (const row of aiCostRows) {
    const entry = aiCostByAgentMap.get(row.agentType) ?? { cost: 0, entries: 0 };
    entry.cost += row.estimatedCostUsd ?? 0;
    entry.entries += 1;
    aiCostByAgentMap.set(row.agentType, entry);
  }

  const unallocated = revenues.filter((r) => !r.productId && !r.opportunityId);

  const margin: PnlObservatory['totals']['margin'] =
    revenues.length > 0 && grossRevenueUsd !== 0
      ? { value: Math.round((netContributionUsd / grossRevenueUsd) * 10000) / 10000, label: 'DERIVED', source: 'netRevenue / grossRevenue over the same rows' }
      : { value: null, label: 'UNKNOWN', source: 'No revenue rows (or zero gross) — margin undefined' };

  const roi: PnlObservatory['totals']['roi'] =
    totalCostUsd > 0
      ? { value: Math.round(((netContributionUsd - totalCostUsd) / totalCostUsd) * 10000) / 10000, label: 'DERIVED', source: '(net contribution − tracked cost) / tracked cost' }
      : { value: null, label: 'UNKNOWN', source: 'No tracked costs — ROI denominator invalid' };

  return {
    totals: {
      grossRevenueUsd: { value: revenues.length > 0 ? grossRevenueUsd : null, label: quality, source: totalsSource },
      totalCostUsd: {
        value: revenues.length > 0 ? totalCostUsd : null,
        label: quality,
        source: `${totalsSource} — fees + advertising + otherCosts columns only`,
      },
      netContributionUsd: { value: revenues.length > 0 ? netContributionUsd : null, label: quality, source: totalsSource },
      aiCostUsd: {
        value: aiCostRows.length > 0 ? aiCostUsd : null,
        label: aiCostRows.length > 0 ? 'ESTIMATED' : 'UNKNOWN',
        source: aiCostRows.length > 0 ? `Sum of ${aiCostRows.length} AgentLog.estimatedCostUsd rows (model-reported estimates)` : 'No AI cost rows recorded',
      },
      margin,
      roi,
    },
    byProduct: groupBy(revenues.filter((r) => r.productId), (r) => r.productId!),
    byOpportunity: groupBy(revenues.filter((r) => r.opportunityId), (r) => r.opportunityId!),
    byBusinessModel: groupBy(
      revenues.filter((r) => r.opportunityId),
      () => 'via linked opportunity',
    ),
    bySource: groupBy(revenues, (r) => r.revenueSource),
    byMonth: groupBy(revenues, (r) => monthKey(r.date)).sort((a, b) => a.key.localeCompare(b.key)),
    aiCostByAgent: [...aiCostByAgentMap.entries()]
      .map(([agentType, v]) => ({ agentType, estimatedCostUsd: Math.round(v.cost * 10000) / 10000, entries: v.entries }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd),
    unallocatedRevenueUsd: Math.round(unallocated.reduce((acc, r) => acc + r.grossRevenue, 0) * 100) / 100,
    unallocatedEntries: unallocated.length,
  };
}
