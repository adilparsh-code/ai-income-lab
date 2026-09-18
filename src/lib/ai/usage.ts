// Phase 4.5.1 — AI Usage & Cost aggregation.
//
// Reuses the AI usage metadata already persisted in AgentLog by the existing
// agents (aiProvider, aiModel, inputTokens, outputTokens, estimatedCostUsd,
// fallbackUsed, purpose, latencyMs, success). This module does NOT create a
// second usage system: it only aggregates the recorded AgentLog rows.
//
// Provenance & honesty rules:
// - Costs come from the generation layer's ISOLATED price table and are
//   ESTIMATES, never billing data. Everything surfaced here is labelled
//   "estimated" by the callers.
// - Null/unknown fields (historical rows written before those fields existed)
//   are reported as 'unknown' groups — never guessed, never backfilled.
// - Non-finite numbers are excluded and surfaced as excluded-anomaly counts.
// - No prompt contents, no secrets, no raw environment values: the aggregation
//   output contains only counters and labels.

export type UsageTimeRange = 'today' | '7d' | '30d' | 'all';

export const USAGE_TIME_RANGES: UsageTimeRange[] = ['today', '7d', '30d', 'all'];

export function isUsageTimeRange(value: unknown): value is UsageTimeRange {
  return typeof value === 'string' && (USAGE_TIME_RANGES as string[]).includes(value);
}

/** Row shape read from AgentLog (structural — Prisma rows satisfy this). */
export interface UsageLogRow {
  agentType: string;
  action: string;
  aiProvider: string | null;
  aiModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  fallbackUsed: boolean;
  purpose: string | null;
  latencyMs: number | null;
  success: boolean | null;
  createdAt: Date;
}

export interface UsageGroup {
  key: string;
  executions: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  avgLatencyMs: number | null;
}

export interface UsageBucket {
  date: string; // YYYY-MM-DD (UTC)
  executions: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface UsageSummary {
  totalExecutions: number;
  successfulExecutions: number | null; // null when no row carries a success flag
  failedExecutions: number | null;
  fallbackExecutions: number;
  aiExecutions: number; // rows that actually recorded provider/model metadata
  deterministicExecutions: number; // mock/legacy rows with no AI metadata
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedTotalCostUsd: number;
  avgLatencyMs: number | null;
}

export interface UsageRange {
  range: UsageTimeRange;
  startIso: string | null; // null for 'all'
  endIso: string;
}

export interface AiUsageSummary {
  range: UsageRange;
  summary: UsageSummary;
  byProvider: UsageGroup[];
  byModel: UsageGroup[];
  byAgent: UsageGroup[];
  byPurpose: UsageGroup[];
  daily: UsageBucket[];
  budget: {
    dailyBudgetUsd: number;
    todaySpendUsd: number;
    remainingUsd: number | null; // null when the budget is unlimited (not configured)
    percentUsed: number | null; // null when remaining is null or budget is 0
    costBasis: 'ESTIMATED';
  };
  dataMode: 'LIVE_DATA' | 'NO_DATA';
  anomalies: {
    nonFiniteNumbersExcluded: number;
  };
}

// ---------------------------------------------------------------------------
// Date-range resolution (UTC day boundaries)
// ---------------------------------------------------------------------------

export function resolveRangeStart(range: UsageTimeRange, now: Date = new Date()): Date | null {
  switch (range) {
    case 'today': {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      return start;
    }
    case '7d': {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 6);
      start.setUTCHours(0, 0, 0, 0);
      return start;
    }
    case '30d': {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 29);
      start.setUTCHours(0, 0, 0, 0);
      return start;
    }
    case 'all':
      return null;
  }
}

export function resolveUsageRange(range: UsageTimeRange, now: Date = new Date()): UsageRange {
  const start = resolveRangeStart(range, now);
  return {
    range,
    startIso: start ? start.toISOString() : null,
    endIso: now.toISOString(),
  };
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Bucket keys covering the range ('today' | '7d' | '30d'); empty for 'all'. */
export function rangeDayKeys(range: UsageTimeRange, now: Date = new Date()): string[] {
  const start = resolveRangeStart(range, now);
  if (!start) return [];
  const keys: string[] = [];
  const cursor = new Date(start);
  const endKey = utcDayKey(now);
  while (utcDayKey(cursor) <= endKey) {
    keys.push(utcDayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Grouping primitives
// ---------------------------------------------------------------------------

function addToGroup(
  groups: Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number; latencies: number[] }>,
  key: string,
  row: UsageLogRow,
  anomalies: { count: number },
): void {
  const entry = groups.get(key) ?? { executions: 0, inputTokens: 0, outputTokens: 0, cost: 0, latencies: [] };
  entry.executions += 1;

  const inTok = row.inputTokens;
  if (inTok !== null) {
    if (Number.isFinite(inTok) && inTok >= 0) entry.inputTokens += Math.floor(inTok);
    else anomalies.count += 1;
  }
  const outTok = row.outputTokens;
  if (outTok !== null) {
    if (Number.isFinite(outTok) && outTok >= 0) entry.outputTokens += Math.floor(outTok);
    else anomalies.count += 1;
  }
  const cost = row.estimatedCostUsd;
  if (cost !== null) {
    if (Number.isFinite(cost) && cost >= 0) entry.cost += cost;
    else anomalies.count += 1;
  }
  if (row.latencyMs !== null && Number.isFinite(row.latencyMs) && row.latencyMs >= 0) {
    entry.latencies.push(row.latencyMs);
  }
  groups.set(key, entry);
}

function finalizeGroups(
  groups: Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number; latencies: number[] }>,
): UsageGroup[] {
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      executions: g.executions,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      estimatedCostUsd: Math.round(g.cost * 1_000_000) / 1_000_000,
      avgLatencyMs: g.latencies.length > 0
        ? Math.round(g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length)
        : null,
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.executions - a.executions || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

export function aggregateUsage(rows: UsageLogRow[], now: Date = new Date()): AiUsageSummary {
  const anomalies = { count: 0 };

  const byProvider = new Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number; latencies: number[] }>();
  const byModel = new Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number; latencies: number[] }>();
  const byAgent = new Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number; latencies: number[] }>();
  const byPurpose = new Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number; latencies: number[] }>();
  const daily = new Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number }>();

  let totalExecutions = 0;
  let successCount: number | null = null;
  let failCount: number | null = null;
  let fallbackCount = 0;
  let aiExecutions = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  const latencies: number[] = [];

  for (const row of rows) {
    totalExecutions += 1;

    if (row.success === true) {
      successCount = (successCount ?? 0) + 1;
    } else if (row.success === false) {
      failCount = (failCount ?? 0) + 1;
    }

    if (row.fallbackUsed) fallbackCount += 1;
    if (row.aiProvider !== null || row.aiModel !== null) aiExecutions += 1;

    if (row.inputTokens !== null && Number.isFinite(row.inputTokens) && row.inputTokens >= 0) totalIn += Math.floor(row.inputTokens);
    else if (row.inputTokens !== null) anomalies.count += 1;

    if (row.outputTokens !== null && Number.isFinite(row.outputTokens) && row.outputTokens >= 0) totalOut += Math.floor(row.outputTokens);
    else if (row.outputTokens !== null) anomalies.count += 1;

    if (row.estimatedCostUsd !== null && Number.isFinite(row.estimatedCostUsd) && row.estimatedCostUsd >= 0) totalCost += row.estimatedCostUsd;
    else if (row.estimatedCostUsd !== null) anomalies.count += 1;

    if (row.latencyMs !== null && Number.isFinite(row.latencyMs) && row.latencyMs >= 0) latencies.push(row.latencyMs);

    addToGroup(byProvider, row.aiProvider ?? 'unknown', row, anomalies);
    addToGroup(byModel, row.aiModel ?? 'unknown', row, anomalies);
    addToGroup(byAgent, row.agentType || 'unknown', row, anomalies);
    addToGroup(byPurpose, row.purpose ?? 'unknown', row, anomalies);

    const dayKey = utcDayKey(new Date(row.createdAt));
    const dayEntry = daily.get(dayKey) ?? { executions: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    dayEntry.executions += 1;
    if (row.inputTokens !== null && Number.isFinite(row.inputTokens) && row.inputTokens >= 0) dayEntry.inputTokens += Math.floor(row.inputTokens);
    if (row.outputTokens !== null && Number.isFinite(row.outputTokens) && row.outputTokens >= 0) dayEntry.outputTokens += Math.floor(row.outputTokens);
    if (row.estimatedCostUsd !== null && Number.isFinite(row.estimatedCostUsd) && row.estimatedCostUsd >= 0) dayEntry.cost += row.estimatedCostUsd;
    daily.set(dayKey, dayEntry);
  }

  const summary: UsageSummary = {
    totalExecutions,
    successfulExecutions: successCount,
    failedExecutions: failCount,
    fallbackExecutions: fallbackCount,
    aiExecutions,
    deterministicExecutions: totalExecutions - aiExecutions,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    estimatedTotalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
    avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
  };

  // Daily budget — reuses the existing configuration (AI_DAILY_BUDGET_USD via
  // the shared generation-layer accessor). Today's spend comes from the same
  // rows, bucketed on today's UTC day key.
  const dailyBudgetUsd = getDailyBudgetUsdSafe();
  const todayKey = utcDayKey(now);
  const todayEntry = daily.get(todayKey);
  const todaySpendUsd = todayEntry ? Math.round(todayEntry.cost * 1_000_000) / 1_000_000 : 0;
  const remaining = dailyBudgetUsd === null ? null : Math.max(0, dailyBudgetUsd - todaySpendUsd);
  const percentUsed = remaining === null || dailyBudgetUsd === null || dailyBudgetUsd <= 0
    ? null
    : Math.round((todaySpendUsd / dailyBudgetUsd) * 10000) / 100;

  // Build the bounded daily series only in aggregateUsageForRange; the
  // unbounded core aggregation emits an unpadded series (observed days only).
  return {
    range: resolveUsageRange('all', now),
    summary,
    byProvider: finalizeGroups(byProvider),
    byModel: finalizeGroups(byModel),
    byAgent: finalizeGroups(byAgent),
    byPurpose: finalizeGroups(byPurpose),
    daily: buildDailySeries(daily, []),
    budget: {
      dailyBudgetUsd: dailyBudgetUsd ?? 0,
      todaySpendUsd,
      remainingUsd: remaining,
      percentUsed,
      costBasis: 'ESTIMATED',
    },
    dataMode: totalExecutions === 0 ? 'NO_DATA' : 'LIVE_DATA',
    anomalies: {
      nonFiniteNumbersExcluded: anomalies.count,
    },
  };
}

/**
 * Aggregate rows that were already filtered to a time range by the caller.
 * `range` only labels the response and bounds the daily series (today/7d/30d);
 * 'all' has no bounded daily series (use byAgent/byProvider for trends).
 */
export function aggregateUsageForRange(rows: UsageLogRow[], range: UsageTimeRange, now: Date = new Date()): AiUsageSummary {
  const result = aggregateUsage(rows, now);
  const keys = rangeDayKeys(range, now);
  const dailyMap = new Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number }>();
  for (const row of rows) {
    const key = utcDayKey(new Date(row.createdAt));
    const entry = dailyMap.get(key) ?? { executions: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    entry.executions += 1;
    if (row.inputTokens !== null && Number.isFinite(row.inputTokens) && row.inputTokens >= 0) entry.inputTokens += Math.floor(row.inputTokens);
    if (row.outputTokens !== null && Number.isFinite(row.outputTokens) && row.outputTokens >= 0) entry.outputTokens += Math.floor(row.outputTokens);
    if (row.estimatedCostUsd !== null && Number.isFinite(row.estimatedCostUsd) && row.estimatedCostUsd >= 0) entry.cost += row.estimatedCostUsd;
    dailyMap.set(key, entry);
  }
  return {
    ...result,
    range: resolveUsageRange(range, now),
    daily: buildDailySeries(dailyMap, keys),
  };
}

function buildDailySeries(
  daily: Map<string, { executions: number; inputTokens: number; outputTokens: number; cost: number }>,
  keys: string[],
): UsageBucket[] {
  const source = keys.length > 0 ? keys : [...daily.keys()].sort();
  return source.map((date) => {
    const entry = daily.get(date) ?? { executions: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    return {
      date,
      executions: entry.executions,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      estimatedCostUsd: Math.round(entry.cost * 1_000_000) / 1_000_000,
    };
  });
}

// ---------------------------------------------------------------------------
// Daily budget accessor (reuses the existing generation-layer configuration)
// ---------------------------------------------------------------------------

/**
 * Read the daily AI budget from the existing configuration. Returns null when
 * no budget is configured (AI_DAILY_BUDGET_USD unset) so the UI can show
 * "unlimited" instead of pretending a default cap exists. Kept local (rather
 * than importing generate.ts) so this module stays free of provider wiring.
 */
export function getDailyBudgetUsdSafe(): number | null {
  const raw = process.env.AI_DAILY_BUDGET_USD;
  if (raw === undefined || raw === null || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}
