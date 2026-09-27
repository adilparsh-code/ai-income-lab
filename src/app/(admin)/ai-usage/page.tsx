import { PageHeader } from '@/components/shared/page-header';
import { AiUsagePanel, type AiUsagePanelData } from '@/components/ai/ai-usage-panel';
import { db } from '@/lib/db';
import { aggregateUsageForRange, isUsageTimeRange, type UsageTimeRange, type UsageLogRow } from '@/lib/ai/usage';
import { getEfficiencyViews } from '@/lib/ai/usage-server';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'AI Usage & Cost — AI Income Lab' };

// Live DB aggregation — must never be prerendered at build time.
export const dynamic = 'force-dynamic';

interface AiUsagePageProps {
  searchParams: Promise<{ range?: string }>;
}

export default async function AiUsagePage({ searchParams }: AiUsagePageProps) {
  const params = await searchParams;
  const rawRange = params.range ?? '7d';
  const range: UsageTimeRange = isUsageTimeRange(rawRange) ? rawRange : '7d';

  let data: AiUsagePanelData | null = null;
  let error: string | null = null;

  try {
    // Metadata columns only — never input/output/reasoning payloads.
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

    data = aggregateUsageForRange(rows, range) as AiUsagePanelData;

    // Phase 4.5.3 — efficiency/token-budget/treasury views (best-effort;
    // failures degrade to the base usage panel, never a fabricated number).
    try {
      const views = await getEfficiencyViews();
      data = { ...data, ...views } as AiUsagePanelData;
    } catch {
      // Keep the base usage data without the optional views.
    }
  } catch (e) {
    error = 'AI usage data could not be loaded. Check the server logs and try again.';
    console.error('[ai-usage] aggregation failed:', e);
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="AI Usage & Cost"
        description="Execution, token, latency, and estimated-cost telemetry for every AI-powered agent run."
      />
      <AiUsagePanel data={data} error={error} range={range} />
    </div>
  );
}

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
