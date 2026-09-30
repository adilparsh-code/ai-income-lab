'use client';

// Phase 10 — Observatory workspace (client).
//
// Renders the composed observatory view. Follows the existing
// OperationsWorkspace pattern: server-rendered initial view + manual refresh
// against the admin-gated API. Every unknown stays explicitly labelled; the
// UI never upgrades UNKNOWN to a number or NOT_CONNECTED to CONNECTED.

import { cn } from '@/lib/utils';
import type { ObservatoryView } from '@/lib/observatory';
import type { DataQuality, QualityValue } from '@/lib/observatory/types';
import { Activity, Bot, CircleDollarSign, GraduationCap, RefreshCw, ShieldAlert, Satellite } from 'lucide-react';
import { useCallback, useState } from 'react';

function QualityChip({ label }: { label: DataQuality }) {
  const tone: Record<DataQuality, string> = {
    REAL: 'bg-emerald-100 text-emerald-800',
    DERIVED: 'bg-sky-100 text-sky-800',
    ESTIMATED: 'bg-amber-100 text-amber-800',
    UNKNOWN: 'bg-slate-200 text-slate-700',
  };
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide', tone[label])}>{label}</span>
  );
}

function QualityValueText<T>({ value, format }: { value: QualityValue<T>; format: (v: T) => string }) {
  if (value.value === null || value.label === 'UNKNOWN') {
    return (
      <span className="inline-flex items-center gap-1">
        <QualityChip label="UNKNOWN" />
        <span className="text-xs text-muted-foreground">{value.source}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <QualityChip label={value.label} />
      <span>{format(value.value)}</span>
    </span>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function ObservatoryWorkspace({ initial }: { initial: ObservatoryView | null }) {
  const [view, setView] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/observatory');
      const json = (await res.json()) as { ok: boolean; view?: ObservatoryView; error?: string };
      if (json.ok && json.view) setView(json.view);
      else setError(json.error ?? 'Observatory view unavailable.');
    } catch {
      setError('Observatory refresh failed. Nothing was fabricated.');
    } finally {
      setLoading(false);
    }
  }, []);

  if (!view) {
    return (
      <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
        Observatory view unavailable (storage error). Nothing was fabricated.{' '}
        <button onClick={refresh} className="underline hover:no-underline">
          Retry
        </button>
      </div>
    );
  }

  const { agents, timeline, learning, pnl, halal, publishing, customerInteractions, integrations, github, executive, nextActions } = view;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Generated {new Date(view.generatedAt).toLocaleString()} — read-only aggregates over persisted records.
        </p>
        <button
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</p>}

      {/* Phase 10.12 — executive now view */}
      <Section title="What is the AI doing now" icon={<Activity className="h-4 w-4" />}>
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active</h3>
            {executive.active.length === 0 ? (
              <EmptyHint>No agent runs are currently active.</EmptyHint>
            ) : (
              executive.active.map((a) => (
                <p key={a.correlationId + a.agentId} className="text-xs">
                  <span className="font-medium">{a.agentId}</span> — {a.jobType} / {a.stage} since {new Date(a.startedAt).toLocaleTimeString()}
                </p>
              ))
            )}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Research / Build</h3>
            {[...executive.research, ...executive.build].slice(0, 4).map((r) => (
              <p key={r.label} className="text-xs">{r.label}</p>
            ))}
            {executive.research.length === 0 && executive.build.length === 0 && <EmptyHint>No research or build runs recorded.</EmptyHint>}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Risks</h3>
            {executive.risks.length === 0 ? (
              <EmptyHint>No open risks recorded.</EmptyHint>
            ) : (
              executive.risks.map((r, i) => (
                <p key={i} className={cn('text-xs', r.severity === 'HIGH' ? 'font-medium text-red-700' : 'text-amber-700')}>
                  {r.severity}: {r.label}
                </p>
              ))
            )}
          </div>
        </div>
      </Section>

      {/* Phase 10.2 — agent overview */}
      <Section title="Agent overview" icon={<Bot className="h-4 w-4" />}>
        {agents.agents.length === 0 ? (
          <EmptyHint>No AgentDefinition rows exist yet.</EmptyHint>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Agent</th><th className="py-1 pr-3">Role</th><th className="py-1 pr-3">Health</th>
                  <th className="py-1 pr-3">Runs (ok/fail/blocked/review)</th><th className="py-1 pr-3">Model / provider</th>
                  <th className="py-1 pr-3">AI cost (USD)</th><th className="py-1 pr-3">Budget</th><th className="py-1 pr-3">Next action</th>
                </tr>
              </thead>
              <tbody>
                {agents.agents.map((a) => (
                  <tr key={a.agentId} className="border-t">
                    <td className="py-1.5 pr-3 font-medium">{a.agentId}{agents.paused ? ' ⏸' : ''}</td>
                    <td className="py-1.5 pr-3">{a.role}</td>
                    <td className="py-1.5 pr-3">{a.healthState}</td>
                    <td className="py-1.5 pr-3">{a.runs.succeeded}/{a.runs.failed}/{a.runs.blocked}/{a.runs.humanReview}</td>
                    <td className="py-1.5 pr-3"><QualityValueText value={a.modelProvider} format={(v) => v} /></td>
                    <td className="py-1.5 pr-3"><QualityValueText value={a.estimatedAiCostUsd} format={(v) => `$${v.toFixed(4)}`} /></td>
                    <td className="py-1.5 pr-3">
                      {a.governance.budgetConsumedUsd !== null ? `$${a.governance.budgetConsumedUsd.toFixed(4)} / $${a.governance.budgetLimitUsd}` : 'UNKNOWN / ' + `$${a.governance.budgetLimitUsd}`}
                    </td>
                    <td className="py-1.5 pr-3">{a.nextAction ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {agents.paused && (
          <p className="mt-2 rounded-lg bg-blue-50 p-2 text-xs text-blue-800">
            Agency paused{agents.pauseReason ? `: ${agents.pauseReason}` : ''}. All governed execution is held.
          </p>
        )}
      </Section>

      {/* Phase 10.3 — timeline */}
      <Section title="Activity / audit timeline" icon={<Activity className="h-4 w-4" />}>
        {timeline.length === 0 ? (
          <EmptyHint>No activity recorded yet.</EmptyHint>
        ) : (
          <ol className="space-y-1.5">
            {timeline.slice(0, 30).map((e) => (
              <li key={e.auditRef} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                <span className="font-medium">{e.action}</span>
                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{e.auditRef}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* Phase 10.6/10.7 — learning observatory */}
      <Section title="Learning observatory" icon={<GraduationCap className="h-4 w-4" />}>
        <p className="mb-2 text-xs text-muted-foreground">
          States: VALIDATED {learning.counts.VALIDATED} · INVALIDATED {learning.counts.INVALIDATED} · HYPOTHESIS {learning.counts.HYPOTHESIS} · UNVERIFIED {learning.counts.UNVERIFIED}
          {' '}— hypotheses are never presented as established truth.
        </p>
        {learning.entries.length === 0 ? (
          <EmptyHint>No learning entries recorded yet.</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {learning.entries.slice(0, 8).map((l) => (
              <li key={l.id} className="rounded-lg border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    l.epistemicState === 'VALIDATED' ? 'bg-emerald-100 text-emerald-800'
                    : l.epistemicState === 'INVALIDATED' ? 'bg-red-100 text-red-800'
                    : l.epistemicState === 'HYPOTHESIS' ? 'bg-amber-100 text-amber-800'
                    : 'bg-slate-100 text-slate-700',
                  )}>
                    {l.epistemicState}
                  </span>
                  <span className="text-muted-foreground">confidence {l.confidence.toFixed(2)} · {l.evidenceType}</span>
                </div>
                <p className="mt-1">{l.hypothesis}</p>
                {l.outcomeLink ? (
                  <p className="mt-1 text-muted-foreground">
                    {l.outcomeLink.chain.join(' → ')} ·{' '}
                    {l.outcomeLink.attribution === 'ATTRIBUTED' ? (
                      <QualityValueText value={l.outcomeLink.revenueUsd} format={(v) => `$${v.toFixed(2)} attributed`} />
                    ) : (
                      <span>UNATTRIBUTED (no deterministic path to revenue)</span>
                    )}
                  </p>
                ) : (
                  <p className="mt-1 text-muted-foreground">Outcome link: UNATTRIBUTED (no experiment linkage recorded)</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Phase 10.8 — P&L */}
      <Section title="Income & profit observatory" icon={<CircleDollarSign className="h-4 w-4" />}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1 text-xs">
            <p className="font-medium">Gross revenue</p>
            <QualityValueText value={pnl.totals.grossRevenueUsd} format={(v) => `$${v.toFixed(2)}`} />
            <p className="font-medium">Tracked cost</p>
            <QualityValueText value={pnl.totals.totalCostUsd} format={(v) => `$${v.toFixed(2)}`} />
            <p className="font-medium">Net contribution</p>
            <QualityValueText value={pnl.totals.netContributionUsd} format={(v) => `$${v.toFixed(2)}`} />
          </div>
          <div className="space-y-1 text-xs">
            <p className="font-medium">AI/API cost (model-estimated)</p>
            <QualityValueText value={pnl.totals.aiCostUsd} format={(v) => `$${v.toFixed(4)}`} />
            <p className="font-medium">Margin</p>
            <QualityValueText value={pnl.totals.margin} format={(v) => `${(v * 100).toFixed(1)}%`} />
            <p className="font-medium">ROI</p>
            <QualityValueText value={pnl.totals.roi} format={(v) => `${(v * 100).toFixed(1)}%`} />
          </div>
          <div className="space-y-1 text-xs">
            <p className="font-medium">Unallocated revenue</p>
            <p>
              {pnl.unallocatedEntries > 0
                ? `$${pnl.unallocatedRevenueUsd.toFixed(2)} across ${pnl.unallocatedEntries} row(s) — UNATTRIBUTED`
                : 'No unallocated revenue rows.'}
            </p>
            <p className="font-medium">AI cost by agent</p>
            {pnl.aiCostByAgent.length === 0 ? <EmptyHint>No AI cost rows recorded.</EmptyHint> : pnl.aiCostByAgent.slice(0, 4).map((c) => (
              <p key={c.agentType}>{c.agentType}: ${c.estimatedCostUsd.toFixed(4)} ({c.entries} rows, ESTIMATED)</p>
            ))}
          </div>
        </div>
        {pnl.bySource.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-medium">Revenue by source</p>
            <ul className="text-xs text-muted-foreground">
              {pnl.bySource.slice(0, 5).map((r) => (
                <li key={r.key}>{r.key}: gross ${r.grossRevenueUsd.toFixed(2)} · net ${r.netRevenueUsd.toFixed(2)} · {r.entries} row(s)</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Phase 10.9 — halal map */}
      <Section title="Halal / safety map" icon={<ShieldAlert className="h-4 w-4" />}>
        <div className="grid gap-4 text-xs md:grid-cols-3">
          <div>
            <p className="font-medium">Opportunities</p>
            <p>ALLOWED {halal.opportunities.allowed} · REVIEW_REQUIRED {halal.opportunities.reviewRequired} · BLOCKED {halal.opportunities.blocked}</p>
            <p className="mt-1 font-medium">Products</p>
            <p>ALLOWED {halal.products.allowed} · REVIEW_REQUIRED {halal.products.reviewRequired} · BLOCKED {halal.products.blocked}</p>
          </div>
          <div>
            <p className="font-medium">Revenue by screening verdict</p>
            <p>ALLOWED: {halal.revenue.allowedUsd !== null ? `$${halal.revenue.allowedUsd.toFixed(2)}` : 'UNKNOWN (mixed or unlinked data)'}</p>
            <p>REVIEW_REQUIRED: {halal.revenue.reviewRequiredUsd !== null ? `$${halal.revenue.reviewRequiredUsd.toFixed(2)}` : 'UNKNOWN'}</p>
            <p>BLOCKED: {halal.revenue.blockedUsd !== null ? `$${halal.revenue.blockedUsd.toFixed(2)}` : 'UNKNOWN'}</p>
            {halal.revenue.unknownUsd > 0 && <p className="text-amber-700">Unlinkable rows: ${halal.revenue.unknownUsd.toFixed(2)} (not counted as allowed)</p>}
          </div>
          <div>
            <p className="font-medium">Handoff rows</p>
            <p className="text-muted-foreground">{halal.note}</p>
          </div>
        </div>
      </Section>

      {/* Phase 10.4/10.5 — publishing + customers */}
      <Section title="Publishing & external activity" icon={<Satellite className="h-4 w-4" />}>
        <p className="mb-2 text-xs">
          Provider: <span className="font-medium">{publishing.providerState.state}</span> — {publishing.providerState.detail}
        </p>
        {publishing.rows.length === 0 ? (
          <EmptyHint>No products recorded yet.</EmptyHint>
        ) : (
          <ul className="space-y-1 text-xs">
            {publishing.rows.slice(0, 8).map((r) => (
              <li key={r.productId} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{r.productName}</span>
                <span className="rounded bg-muted px-1 text-[10px]">{r.publishState}</span>
                <span className="text-muted-foreground">
                  {r.destination ? `via ${r.destination}` : 'no destination recorded'} · visitors {r.traffic.visitors} · purchases {r.traffic.purchases} ·{' '}
                  {r.attributedRevenueUsd !== null ? `$${r.attributedRevenueUsd.toFixed(2)} revenue` : 'revenue UNKNOWN'}
                </span>
                {r.url && <a href={r.url} className="underline hover:no-underline" target="_blank" rel="noreferrer noopener">open</a>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Customer interactions: {customerInteractions.state} — {customerInteractions.detail}
        </p>
      </Section>

      {/* Phase 10.10/10.11 — integration health + github */}
      <Section title="Integration health" icon={<Satellite className="h-4 w-4" />}>
        <div className="grid gap-2 md:grid-cols-2">
          {integrations.map((i) => (
            <div key={i.name} className="rounded-lg border p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{i.name}</span>
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                  i.state === 'CONNECTED' ? 'bg-emerald-100 text-emerald-800'
                  : i.state === 'NOT_CONNECTED' || i.state === 'NOT_CONFIGURED' ? 'bg-amber-100 text-amber-800'
                  : i.state === 'ERROR' || i.state === 'DEGRADED' ? 'bg-red-100 text-red-800'
                  : 'bg-slate-100 text-slate-700',
                )}>{i.state}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{i.detail}</p>
              {i.requiredForConnected.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">Needs: {i.requiredForConnected.join('; ')}</p>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-lg border p-2 text-xs">
          <p className="font-medium">GitHub engineering watcher: {github.state}</p>
          <p className="text-muted-foreground">{github.detail}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{github.governance.mutationPolicy}</p>
        </div>
      </Section>

      {/* Phase 10.13 — next actions */}
      <Section title="What should I do next" icon={<Activity className="h-4 w-4" />}>
        {nextActions.actions.length === 0 ? (
          <EmptyHint>No open actions derived from current records.</EmptyHint>
        ) : (
          <ol className="space-y-1.5">
            {nextActions.actions.map((a, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">{a.category}</span>
                <span className="font-medium">{a.label}</span>
                {a.humanApprovalRequired && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">APPROVAL REQUIRED</span>}
                <span className="text-muted-foreground">{a.reason}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
