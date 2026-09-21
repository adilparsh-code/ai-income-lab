// Compact AI usage summary for the dashboard (Phase 4.5.1).
// Server component: receives the already-aggregated summary — it never queries
// the DB itself and renders counters/labels only (no secrets, no payloads).

import Link from 'next/link';
import { ArrowRight, Coins, Cpu, Gauge } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AiUsageSummary } from '@/lib/ai/usage';

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function AiUsageCard({ usage }: { usage: AiUsageSummary }) {
  const { summary, budget } = usage;

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">AI Usage & Cost</h3>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold',
              usage.dataMode === 'LIVE_DATA' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
            )}
          >
            {usage.dataMode === 'LIVE_DATA' ? 'LIVE DATA' : 'NO DATA'}
          </span>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">ESTIMATED</span>
        </div>
      </div>

      {usage.dataMode === 'NO_DATA' ? (
        <p className="text-sm text-muted-foreground">
          No AI executions recorded in this period yet. Run an agent to see usage, latency, and estimated cost here.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 text-sm tabular-nums">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Executions (7d)</div>
            <div className="font-semibold">{summary.totalExecutions}</div>
            <div className="text-[10px] text-muted-foreground">{summary.aiExecutions} AI · {summary.deterministicExecutions} mock</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Tokens in/out</div>
            <div className="font-semibold">{formatCompact(summary.totalInputTokens)} / {formatCompact(summary.totalOutputTokens)}</div>
            {summary.fallbackExecutions > 0 && (
              <div className="text-[10px] text-orange-600 font-medium">{summary.fallbackExecutions} fallback</div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Coins className="h-3 w-3" /> Est. cost
            </div>
            <div className="font-semibold">{formatUsd(summary.estimatedTotalCostUsd)}</div>
            <div className="text-[10px] text-muted-foreground">
              {budget.dailyBudgetUsd > 0 ? `${formatUsd(budget.remainingUsd ?? 0)} budget left today` : 'no budget cap set'}
            </div>
          </div>
        </div>
      )}

      <Link
        href="/ai-usage"
        className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        <Gauge className="h-3.5 w-3.5" />
        View full usage & cost breakdown
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
