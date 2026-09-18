'use client';

// Phase 4.5.1 — AI Usage & Cost panel.
// Renders aggregated, safe telemetry only. Every cost figure is labelled
// ESTIMATED; data mode is marked LIVE DATA or NO DATA; mock/fallback
// executions are called out explicitly. No secrets, no prompt contents.

import { cn } from '@/lib/utils';
import { Activity, Bot, Clock, Coins, Cpu, Gauge, ShieldCheck, TrendingUp, Zap } from 'lucide-react';
import Link from 'next/link';
import type { AiUsageSummary, UsageGroup, UsageTimeRange } from '@/lib/ai/usage';

export type AiUsagePanelData = AiUsageSummary;

const RANGES: { value: UsageTimeRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatLatency(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function GroupTable({ title, groups, unit }: { title: string; groups: UsageGroup[]; unit: 'cost' | 'executions' }) {
  if (groups.length === 0) return null;
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      <div className="space-y-1.5">
        {groups.slice(0, 8).map((g) => (
          <div key={g.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-mono text-xs" title={g.key}>{g.key}</span>
            <span className="flex items-center gap-3 shrink-0 tabular-nums text-xs text-muted-foreground">
              <span title="executions">{formatNumber(g.executions)}×</span>
              <span title="input tokens">↑{formatNumber(g.inputTokens)}</span>
              <span title="output tokens">↓{formatNumber(g.outputTokens)}</span>
              <span className="font-medium text-foreground" title="estimated cost">
                {unit === 'cost' ? formatUsd(g.estimatedCostUsd) : `${g.executions}`}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AiUsagePanel({
  data,
  error,
  range,
}: {
  data: AiUsagePanelData | null;
  error: string | null;
  range: UsageTimeRange;
}) {
  if (error) {
    return (
      <div className="rounded-xl border-2 border-dashed border-red-200 bg-red-50/50 p-8 text-center">
        <ShieldCheck className="h-8 w-8 mx-auto text-red-400 mb-3" />
        <h3 className="text-base font-semibold text-red-900 mb-1">AI usage unavailable</h3>
        <p className="text-sm text-red-700/80">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        Loading AI usage…
      </div>
    );
  }

  const { summary, budget } = data;
  const mockShare = summary.totalExecutions > 0
    ? Math.round((summary.deterministicExecutions / summary.totalExecutions) * 100)
    : 0;

  return (
    <div className="space-y-5">
      {/* Badges */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded px-2 py-0.5 text-[10px] font-semibold',
            data.dataMode === 'LIVE_DATA' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
          )}
        >
          {data.dataMode === 'LIVE_DATA' ? 'LIVE DATA' : 'NO DATA YET'}
        </span>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
          ESTIMATED COST
        </span>
        {summary.deterministicExecutions > 0 && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
            {summary.deterministicExecutions} MOCK ({mockShare}%)
          </span>
        )}
        {summary.fallbackExecutions > 0 && (
          <span className="rounded bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
            {summary.fallbackExecutions} FALLBACK
          </span>
        )}
      </div>

      {/* Range switcher */}
      <div className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <Link
            key={r.value}
            href={`/ai-usage?range=${r.value}`}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              r.value === range
                ? 'bg-primary text-primary-foreground shadow'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted'
            )}
          >
            {r.label}
          </Link>
        ))}
      </div>

      {/* Budget */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Daily AI Budget</h3>
          </div>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">ESTIMATED</span>
        </div>
        {budget.dailyBudgetUsd > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-3 text-sm tabular-nums">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Current spend (today)</div>
                <div className="font-semibold">{formatUsd(budget.todaySpendUsd)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Daily budget</div>
                <div className="font-semibold">{formatUsd(budget.dailyBudgetUsd)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Remaining</div>
                <div className="font-semibold">{formatUsd(budget.remainingUsd ?? 0)}</div>
              </div>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  (budget.percentUsed ?? 0) >= 100 ? 'bg-red-500' : (budget.percentUsed ?? 0) >= 75 ? 'bg-amber-500' : 'bg-emerald-500'
                )}
                style={{ width: `${Math.min(100, budget.percentUsed ?? 0)}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatPercent(budget.percentUsed)} of daily budget used · estimates from the isolated price table
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No daily budget configured. Today&apos;s estimated spend: <span className="font-medium tabular-nums">{formatUsd(budget.todaySpendUsd)}</span> (estimates, not billing data).
          </p>
        )}
      </div>

      {/* Summary stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<Activity className="h-4 w-4" />} label="Executions" value={formatNumber(summary.totalExecutions)} hint={`${summary.aiExecutions} AI · ${summary.deterministicExecutions} deterministic`} />
        <Stat
          icon={<Gauge className="h-4 w-4" />}
          label="Success / Failed"
          value={
            summary.successfulExecutions === null && summary.failedExecutions === null
              ? 'Not recorded'
              : `${summary.successfulExecutions ?? 0} / ${summary.failedExecutions ?? 0}`
          }
          hint={summary.fallbackExecutions > 0 ? `${summary.fallbackExecutions} used fallback` : 'No fallback runs'}
        />
        <Stat icon={<Zap className="h-4 w-4" />} label="Tokens (in / out)" value={`${formatNumber(summary.totalInputTokens)} / ${formatNumber(summary.totalOutputTokens)}`} hint="estimated from recorded usage" />
        <Stat icon={<Clock className="h-4 w-4" />} label="Avg latency" value={formatLatency(summary.avgLatencyMs)} hint="recorded agent step time" />
      </div>

      {/* Estimated total cost */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Estimated total cost</span>
          </div>
          <span className="text-lg font-semibold tabular-nums">{formatUsd(summary.estimatedTotalCostUsd)}</span>
        </div>
      </div>

      {/* Groups */}
      <div className="grid gap-4 lg:grid-cols-2">
        <GroupTable title="By provider" groups={data.byProvider} unit="cost" />
        <GroupTable title="By model" groups={data.byModel} unit="cost" />
        <GroupTable title="By agent" groups={data.byAgent} unit="cost" />
        <GroupTable title="By purpose" groups={data.byPurpose} unit="cost" />
      </div>

      {/* Daily series */}
      {data.daily.length > 0 && (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Usage over time</h3>
          </div>
          <div className="space-y-1">
            {data.daily.slice(-14).map((d) => {
              const maxCost = Math.max(...data.daily.map((x) => x.estimatedCostUsd), 0.0001);
              const width = Math.max(2, Math.round((d.estimatedCostUsd / maxCost) * 100));
              return (
                <div key={d.date} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 font-mono text-muted-foreground">{d.date}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${width}%` }} />
                  </div>
                  <span className="w-28 shrink-0 text-right tabular-nums text-muted-foreground">
                    {formatNumber(d.executions)}× · {formatUsd(d.estimatedCostUsd)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        All figures come from recorded AgentLog usage metadata. Costs are estimates from an isolated price table — never billing data. No prompt contents are included anywhere on this page.
      </p>
    </div>
  );
}
