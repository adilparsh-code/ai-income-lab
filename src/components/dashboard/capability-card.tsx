// Phase 5.5 — Capability Center & Operations card (dashboard).
// One truthful surface over every external boundary plus live operations
// aggregates. Data comes entirely from the server (getOperationsSummary →
// describeCapabilityCenter + real DB aggregates); the component renders
// labels only and invents nothing.

import { cn } from '@/lib/utils';
import { Activity, ArrowUpRight, Cpu, Globe, Wallet } from 'lucide-react';

export interface CapabilitySummaryData {
  generatedAt: string;
  capabilities: {
    name: string;
    status: 'LIVE' | 'MOCKED' | 'NOT_CONNECTED' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'PLANNED';
    detail: string;
    requiredForLive: string[];
    requiresHumanApproval: boolean;
  }[];
  counts: Record<string, number>;
  jobs: {
    today: number;
    running: number;
    blocked: number;
    humanReview: number;
    failed24h: number;
    succeeded24h: number;
  };
  totals: {
    grossRevenueUsd: number;
    netRevenueUsd: number;
    estimatedAiCostUsd: number;
    estimatedProfitUsd: number | null;
    profitLabel: 'INSUFFICIENT_DATA' | 'ESTIMATED' | 'VERIFIED';
  };
  nextBestAction: {
    action: string;
    basis: string;
    evidenceStatus: 'SUPPORTED' | 'INSUFFICIENT_DATA';
    requiresHuman: boolean;
  };
}

function StatusBadge({ status }: { status: CapabilitySummaryData['capabilities'][number]['status'] }) {
  const tone = status === 'LIVE'
    ? 'bg-emerald-100 text-emerald-700'
    : status === 'MOCKED'
      ? 'bg-sky-100 text-sky-700'
      : status === 'PLANNED'
        ? 'bg-violet-100 text-violet-700'
        : status === 'UNAVAILABLE'
          ? 'bg-amber-100 text-amber-700'
          : 'bg-slate-100 text-slate-500';
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', tone)}>{status.replace(/_/g, ' ')}</span>
  );
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function CapabilityCard({ data }: { data: CapabilitySummaryData }) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Capability Center — truthful boundary status</h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(data.counts)
            .filter(([, n]) => n > 0)
            .map(([label, n]) => (
              <span key={label} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {label.replace(/_/g, ' ')}: {n}
              </span>
            ))}
        </div>
      </div>

      {/* Capability grid */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mb-4">
        {data.capabilities.map((c) => (
          <div key={c.name} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs font-medium">{c.name}</span>
              <StatusBadge status={c.status} />
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground line-clamp-2">{c.detail}</p>
            {c.requiredForLive.length > 0 && (
              <p className="mt-1 text-[10px] text-amber-600">
                Needs: {c.requiredForLive.slice(0, 2).join('; ')}
              </p>
            )}
            {c.requiresHumanApproval && (
              <p className="mt-1 text-[10px] font-medium text-indigo-600">Human approval required</p>
            )}
          </div>
        ))}
      </div>

      {/* Operations aggregates — real rows only */}
      <div className="grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
            <Globe className="h-3 w-3" /> Jobs (24h)
          </div>
          <p className="text-sm font-semibold">
            {data.jobs.today} total
          </p>
          <p className="text-[10px] text-muted-foreground">
            {data.jobs.succeeded24h} ok · {data.jobs.failed24h} failed · {data.jobs.blocked} blocked ·{' '}
            {data.jobs.humanReview} review
          </p>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
            <Wallet className="h-3 w-3" /> Recorded revenue (net)
          </div>
          <p className="text-sm font-semibold">{usd(data.totals.netRevenueUsd)}</p>
          <p className="text-[10px] text-muted-foreground">
            gross {usd(data.totals.grossRevenueUsd)} · from real Revenue rows
          </p>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
            <Cpu className="h-3 w-3" /> Estimated AI cost
          </div>
          <p className="text-sm font-semibold">{usd(data.totals.estimatedAiCostUsd)}</p>
          <p className="text-[10px] text-muted-foreground">ESTIMATED from AgentLog — not provider billing</p>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
            <ArrowUpRight className="h-3 w-3" /> Estimated profit
          </div>
          <p className="text-sm font-semibold">
            {data.totals.estimatedProfitUsd === null ? '—' : usd(data.totals.estimatedProfitUsd)}
          </p>
          <p className="text-[10px] text-muted-foreground">{data.totals.profitLabel.replace(/_/g, ' ')}</p>
        </div>
      </div>

      {/* Next best action — deterministic, evidence-based */}
      <div className="mt-4 rounded-lg bg-muted/50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">Next best action:</span>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {data.nextBestAction.action.replace(/_/g, ' ')}
          </span>
          {data.nextBestAction.requiresHuman && (
            <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
              HUMAN DECISION
            </span>
          )}
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            {data.nextBestAction.evidenceStatus.replace(/_/g, ' ')}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">{data.nextBestAction.basis}</p>
      </div>
    </div>
  );
}
