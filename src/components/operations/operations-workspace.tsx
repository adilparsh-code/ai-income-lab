'use client';

import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/utils';
import type { Phase8OperationsView, HealthTile } from '@/lib/ops/dashboard';
import type { SystemStateLabel as Label } from '@/lib/ops/types';
import { Activity, Bot, CircleDollarSign, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useState } from 'react';

function toneFor(state: Label): string {
  switch (state) {
    case 'LIVE': return 'bg-emerald-100 text-emerald-800';
    case 'MOCKED': return 'bg-slate-100 text-slate-700';
    case 'SIMULATED': return 'bg-violet-100 text-violet-800';
    case 'NOT_CONFIGURED': return 'bg-amber-100 text-amber-800';
    case 'NOT_CONNECTED': return 'bg-orange-100 text-orange-800';
    case 'BLOCKED': return 'bg-red-100 text-red-800';
    case 'AWAITING_HUMAN_INPUT': return 'bg-blue-100 text-blue-800';
    default: return 'bg-slate-100 text-slate-600';
  }
}

function StateChip({ state }: { state: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide', toneFor(state as Label))}>
      {state}
    </span>
  );
}

function HealthGrid({ tiles }: { tiles: HealthTile[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {tiles.map((t) => (
        <div key={t.name} className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="text-sm font-semibold">{t.name}</h3>
            <StateChip state={t.state} />
          </div>
          <p className="text-xs text-muted-foreground leading-snug">{t.detail}</p>
        </div>
      ))}
    </div>
  );
}

export function OperationsWorkspace({ initial }: { initial: Phase8OperationsView | null }) {
  const [view, setView] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ops/dashboard');
      const json = (await res.json()) as { ok: boolean; view?: Phase8OperationsView; error?: string };
      if (json.ok && json.view) setView(json.view);
      else setError(json.error ?? 'Operations view unavailable.');
    } catch {
      setError('Failed to load operations view.');
    } finally {
      setLoading(false);
    }
  }, []);

  if (!view) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Operations view is unavailable (storage error). Nothing was fabricated.
      </div>
    );
  }

  const { health, execution, income, timeline, capabilities, missions, simulations } = view;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Generated {view.generatedAt}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">System Health</h2>
        <HealthGrid tiles={health} />
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Activity className="h-4 w-4" /> Execution
        </h2>
        <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {Object.entries(execution).map(([k, v]) => (
            <div key={k} className="rounded-xl border bg-card p-3 text-center shadow-sm">
              <div className="text-lg font-semibold">{v}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <CircleDollarSign className="h-4 w-4" /> Income Engine
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Opportunities" value={String(income.opportunities)} />
          <Stat label="Loop transitions" value={String(income.loopTransitions)} />
          <Stat label="Experiments" value={String(income.experiments)} />
          <Stat label="Products" value={String(income.products)} />
          <Stat label="Real revenue" value={formatCurrency(income.realRevenueUsd)} hint="VERIFIED_DATA" />
          <Stat label="Simulated revenue" value={formatCurrency(income.simulatedRevenueUsd)} hint="SIMULATED — not real" />
          <Stat label="Simulated profit" value={formatCurrency(income.simulatedProfitUsd)} hint="SIMULATED — not real" />
          <Stat label="Pending human input" value={String(income.pendingHumanInput)} hint="AWAITING_HUMAN_INPUT" />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Bot className="h-4 w-4" /> Agent Timeline
        </h2>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">No timeline events yet. Nothing was fabricated.</p>
        ) : (
          <ol className="space-y-2">
            {timeline.map((ev, i) => (
              <li key={`${ev.at}-${i}`} className="flex items-start gap-3 rounded-lg border bg-card p-3">
                <StateChip state={ev.state} />
                <div className="min-w-0">
                  <p className="text-sm">{ev.label}</p>
                  <p className="text-[10px] text-muted-foreground">{ev.kind} · {ev.at}{ev.correlationId ? ` · ${ev.correlationId}` : ''}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <ShieldAlert className="h-4 w-4" /> Capabilities
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.capabilities.map((c) => (
            <div key={c.name} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-sm font-medium">{c.name}</span>
                <StateChip state={c.status} />
              </div>
              <p className="text-xs text-muted-foreground">{c.detail}</p>
              {c.requiresHumanApproval && (
                <p className="mt-1 text-[10px] font-semibold text-blue-700">HUMAN APPROVAL REQUIRED</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Missions</h2>
          {missions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No missions recorded.</p>
          ) : missions.slice(0, 8).map((m) => (
            <div key={m.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate">{m.objective.slice(0, 80)}</span>
                <StateChip state={m.status === 'HUMAN_REVIEW' ? 'AWAITING_HUMAN_INPUT' : m.status === 'BLOCKED' ? 'BLOCKED' : m.status === 'COMPLETED' ? 'LIVE' : 'MOCKED'} />
              </div>
              <p className="text-[10px] text-muted-foreground">{m.agentType} · {m.correlationId}</p>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Simulations</h2>
          {simulations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No paper-income runs yet.</p>
          ) : simulations.slice(0, 8).map((s) => (
            <div key={s.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Profit {formatCurrency(s.profitUsd)}</span>
                <StateChip state="SIMULATED" />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Traffic {s.traffic.toLocaleString()} · Revenue {formatCurrency(s.revenueUsd)} · realTransaction={String(s.realTransaction)}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {hint && <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{hint}</div>}
    </div>
  );
}
