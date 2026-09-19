'use client';

// Phase 5.3 — Product Factory dashboard card.
// Shows ONLY real recorded state with truthful status labels. Every lifecycle
// count and monetary figure comes from server-computed DB state.

import { cn } from '@/lib/utils';
import { Factory } from 'lucide-react';

import type { ProductFactoryDashboardSummary, FactoryLifecycleRow } from '@/actions/product-factory';
export type ProductFactorySummary = ProductFactoryDashboardSummary;
export type FactoryProductRow = FactoryLifecycleRow;

const STATUS_TONES: Record<string, string> = {
  IDEA: 'bg-slate-100 text-slate-700',
  VALIDATED: 'bg-blue-100 text-blue-700',
  SPEC_READY: 'bg-indigo-100 text-indigo-700',
  BUILDING: 'bg-amber-100 text-amber-700',
  TESTING: 'bg-yellow-100 text-yellow-700',
  READY_TO_DEPLOY: 'bg-orange-100 text-orange-700',
  DEPLOYED: 'bg-teal-100 text-teal-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-700',
  PAUSED: 'bg-gray-100 text-gray-600',
  ARCHIVED: 'bg-gray-100 text-gray-400',
  BLOCKED: 'bg-red-100 text-red-700',
};

function Badge({ label, tone }: { label: string; tone?: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', tone ?? 'bg-slate-100 text-slate-500')}>
      {label}
    </span>
  );
}

export function ProductFactoryCard({ summary }: { summary: ProductFactorySummary | null }) {
  if (!summary) {
    return (
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Factory className="h-4 w-4" /> Product Factory</h3>
        <p className="mt-2 text-sm text-muted-foreground">Product data unavailable (degraded).</p>
      </div>
    );
  }

  const lifecycleCounts = Object.entries(summary.countsByStatus).filter(([, n]) => n > 0);

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Factory className="h-4 w-4" /> Product Factory
        </h3>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Badge
            label={`BUILDER ${summary.capabilities.builder.status}`}
            tone={summary.capabilities.builder.status === 'LIVE' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}
          />
          <Badge
            label={`DEPLOY ${summary.capabilities.deployment.status === 'LIVE' ? 'LIVE' : 'NOT_CONNECTED'}`}
            tone={summary.capabilities.deployment.status === 'LIVE' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}
          />
          <Badge
            label={`PUBLISH ${summary.capabilities.publishing.status === 'AVAILABLE' ? 'LIVE' : summary.capabilities.publishing.status === 'PUBLISHING_READY' ? 'READY' : 'NOT_CONNECTED'}`}
            tone={summary.capabilities.publishing.status === 'AVAILABLE' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}
          />
          <Badge label={`RUFLO ${summary.capabilities.ruflo.status.replace('RUFLO_', '')}`} tone="bg-slate-100 text-slate-500" />
        </div>
      </div>

      {/* Lifecycle distribution */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {lifecycleCounts.length === 0 ? (
          <span className="text-xs text-muted-foreground">No products yet — lifecycle states appear as products are created.</span>
        ) : (
          lifecycleCounts.map(([status, n]) => (
            <Badge key={status} label={`${status.replace(/_/g, ' ')}: ${n}`} tone={STATUS_TONES[status]} />
          ))
        )}
      </div>

      {/* Totals (VERIFIED figures from recorded rows) */}
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/40 p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Gross (VERIFIED)</div>
          <div className="text-sm font-semibold">${summary.totals.grossRevenueUsd.toFixed(2)}</div>
        </div>
        <div className="rounded-lg bg-muted/40 p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Net (VERIFIED)</div>
          <div className="text-sm font-semibold">${summary.totals.netRevenueUsd.toFixed(2)}</div>
        </div>
        <div className="rounded-lg bg-muted/40 p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">AI cost (ESTIMATED)</div>
          <div className="text-sm font-semibold">${summary.totals.estimatedAiCostUsd.toFixed(2)}</div>
        </div>
      </div>

      {/* Per-product rows */}
      {summary.products.length > 0 && (
        <div className="space-y-2">
          {summary.products.slice(0, 5).map((p: FactoryProductRow) => (
            <div key={p.id} className="rounded-lg border p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{p.name}</span>
                <Badge label={p.status.replace(/_/g, ' ')} tone={STATUS_TONES[p.status]} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {p.opportunityTitle && <span className="truncate max-w-48">↳ {p.opportunityTitle}</span>}
                {p.buildStatus && <Badge label={`BUILD: ${p.buildStatus}`} tone={p.buildStatus === 'SUCCEEDED' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'} />}
                {p.deploymentStatus && <Badge label={`DEPLOY: ${p.deploymentStatus.replace(/_/g, ' ')}`} tone={p.deploymentStatus === 'DEPLOYED' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'} />}
                {p.publicationStatus && <Badge label={`ASSETS: ${p.publicationStatus.replace(/_/g, ' ')}`} tone={p.publicationStatus === 'PUBLISHABLE' ? 'bg-emerald-100 text-emerald-700' : p.publicationStatus === 'HUMAN_REVIEW' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'} />}
                <span>net ${p.netRevenueUsd.toFixed(2)}</span>
                <span className="ml-auto truncate max-w-44 text-[11px] italic">{p.nextAction}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Phase 5.4 — capability discovery footer */}
      <div className="mt-3 space-y-1 rounded-lg bg-muted/30 p-2.5">
        <div className="flex items-start justify-between gap-2 text-[11px]">
          <span className="font-medium">Sandboxed builder</span>
          <span className="text-right text-muted-foreground">{summary.capabilities.builder.sandboxed ? 'sandboxed: yes' : 'sandboxed: NO'} · {summary.capabilities.builder.status}</span>
        </div>
        <div className="flex items-start justify-between gap-2 text-[11px]">
          <span className="font-medium">Deployment provider</span>
          <span className="text-right text-muted-foreground">{summary.capabilities.deployment.providerId ?? 'none'} · {summary.capabilities.deployment.status}</span>
        </div>
        {summary.capabilities.ruflo.unmetRequirements.length > 0 && (
          <div className="flex items-start justify-between gap-2 text-[11px]">
            <span className="font-medium">Ruflo</span>
            <span className="text-right text-muted-foreground">{summary.capabilities.ruflo.unmetRequirements[0]}</span>
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        Deploy/publish require an authorized provider + explicit human approval token. Nothing deploys or publishes automatically.
      </p>
    </div>
  );
}
