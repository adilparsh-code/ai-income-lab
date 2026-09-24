import { PageHeader } from '@/components/shared/page-header';
import { getPhase8OperationsSummary } from '@/lib/operations/operations-summary';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Operations — AI Income Lab' };
export const dynamic = 'force-dynamic';

const badge = (value: string) => <span className="rounded-full border bg-white/70 px-2.5 py-1 text-xs font-medium text-slate-700">{value}</span>;

export default async function OperationsPage() {
  const summary = await getPhase8OperationsSummary().catch(() => null);
  if (!summary) return <div className="p-6 lg:p-8"><PageHeader title="Operations" description="Operations telemetry is temporarily unavailable. No status was fabricated." /></div>;
  return <div className="space-y-6 p-6 lg:p-8">
    <PageHeader title="Operations" description="Autonomous operations control plane — real execution state, honest provider boundaries, bounded recovery, and clearly labelled simulation." />
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Object.entries(summary.systemHealth).map(([name, status]) => <div key={name} className="rounded-xl border bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-wide text-slate-500">{name}</p><div className="mt-2">{badge(status)}</div></div>)}
    </section>
    <section className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Execution</h2><div className="mt-3 grid grid-cols-3 gap-3 text-sm"><div><p className="text-slate-500">Running</p><p className="text-xl font-semibold">{summary.jobs.running}</p></div><div><p className="text-slate-500">Failed 24h</p><p className="text-xl font-semibold">{summary.jobs.failed24h}</p></div><div><p className="text-slate-500">Human review</p><p className="text-xl font-semibold">{summary.jobs.humanReview}</p></div></div></div>
      <div className="rounded-xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Missions</h2><div className="mt-3 grid grid-cols-3 gap-3 text-sm"><div><p className="text-slate-500">Queued</p><p className="text-xl font-semibold">{summary.missions.queued}</p></div><div><p className="text-slate-500">Running</p><p className="text-xl font-semibold">{summary.missions.running}</p></div><div><p className="text-slate-500">Dead letters</p><p className="text-xl font-semibold">{summary.missions.deadLetters}</p></div></div></div>
      <div className="rounded-xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Income engine</h2><div className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><p className="text-slate-500">Real net revenue</p><p className="text-xl font-semibold">${summary.totals.netRevenueUsd.toFixed(2)}</p></div><div><p className="text-slate-500">Profit basis</p><p className="mt-2">{badge(summary.totals.profitLabel)}</p></div></div></div>
    </section>
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold text-amber-900">Simulation mode</h2><p className="mt-1 text-sm text-amber-800">{summary.simulated.note}</p><p className="mt-2 text-xs font-semibold uppercase tracking-wide text-amber-900">SIMULATED — never real revenue</p></section>
    <section className="rounded-xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Agent timeline</h2>{summary.timeline.length === 0 ? <p className="mt-3 text-sm text-slate-500">No recorded loop transitions yet.</p> : <ol className="mt-3 space-y-3">{summary.timeline.map((item) => <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2 last:border-0"><div><p className="text-sm font-medium">{item.kind}</p><p className="text-xs text-slate-500">{item.detail}</p></div><div className="text-right">{badge(item.status)}<p className="mt-1 text-[11px] text-slate-400">{new Date(item.at).toLocaleString()}</p></div></li>)}</ol>}</section>
  </div>;
}
