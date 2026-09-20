'use client';

// Phase B — Product Creation Pipeline panel (Product Factory page section).
// Shows the durable pipeline state per product: spec version/status,
// generation mode, provenance, quality gates, halal/safety status, landing
// page, and the truthful next action. Failure states are readable, never
// hidden. Includes the run control for validated opportunities. No secrets:
// summaries contain statuses and ids only.

import { useState, useTransition } from 'react';
import { runProductCreationPipeline, type ProductPipelineSummaryRow } from '@/actions/product-factory';
import type { FactoryOpportunityOption } from '@/actions/product-factory';

interface RunOutcome {
  ok: boolean;
  message: string;
  stages?: { id: string; label: string; status: string; detail: string }[];
}

const SPEC_STATUS_STYLES: Record<string, string> = {
  READY_FOR_PUBLISHING: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  GENERATED: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  VALIDATING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  GENERATING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  DRAFT: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  QUALITY_FAILED: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  SAFETY_FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

const PRODUCT_STATUS_STYLES: Record<string, string> = {
  READY_TO_DEPLOY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  PUBLISHED: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40',
  BUILDING: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  TESTING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  BLOCKED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

function Badge({ label, style }: { label: string; style?: string }) {
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${style ?? 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'}`}>
      {label}
    </span>
  );
}

export function ProductPipelinePanel({
  summaries,
  opportunities,
}: {
  summaries: ProductPipelineSummaryRow[];
  opportunities: FactoryOpportunityOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [selectedOpportunity, setSelectedOpportunity] = useState('');
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);

  const runPipeline = () => {
    if (!selectedOpportunity) return;
    setOutcome(null);
    startTransition(async () => {
      const result = await runProductCreationPipeline({ opportunityId: selectedOpportunity });
      if (result.ok) {
        setOutcome({
          ok: true,
          message: `Pipeline complete: ${result.finalStatus} (spec v${result.version}, product lifecycle ${result.productLifecycleStatus}). Publishing is the next, not-yet-connected capability.`,
          stages: result.stages,
        });
      } else {
        setOutcome({ ok: false, message: result.error });
      }
    });
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-100">Product creation pipeline</h2>
        <p className="text-xs text-zinc-500">
          Opportunity → specification → generation → quality → safety → landing page → package → READY_FOR_PUBLISHING
        </p>
      </div>

      {/* Run control — validated opportunities only; halal gates apply server-side. */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
        <label htmlFor="pipeline-opportunity" className="text-sm text-zinc-400">
          Validated opportunity
        </label>
        <select
          id="pipeline-opportunity"
          value={selectedOpportunity}
          onChange={(e) => setSelectedOpportunity(e.target.value)}
          className="min-w-64 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-emerald-500/60 focus:outline-none"
        >
          <option value="">Select an opportunity…</option>
          {opportunities.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title} · {o.status} · score {o.overallScore} · {o.halalStatus}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={runPipeline}
          disabled={pending || !selectedOpportunity}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Running pipeline…' : 'Run creation pipeline'}
        </button>
      </div>

      {outcome && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            outcome.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border-orange-500/30 bg-orange-500/10 text-orange-200'
          }`}
          role="status"
        >
          <p className="font-medium">{outcome.ok ? 'Product package ready' : 'Pipeline stopped'}</p>
          <p className="mt-1 text-zinc-300">{outcome.message}</p>
          {outcome.stages && (
            <ul className="mt-2 space-y-1 text-xs text-zinc-400">
              {outcome.stages.map((s) => (
                <li key={s.id}>
                  <span className="font-mono text-zinc-300">{s.label}</span>: {s.status} — {s.detail}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            Deterministic generation (MOCKED provenance). Nothing is published and no payment exists; the CTA is a placeholder.
          </p>
        </div>
      )}

      {/* Pipeline state table */}
      {summaries.length === 0 ? (
        <p className="text-sm text-zinc-500">No products yet. Run the creation pipeline on a validated opportunity to build the first durable product package.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-3 font-medium">Product</th>
                <th className="py-2 pr-3 font-medium">Product status</th>
                <th className="py-2 pr-3 font-medium">Spec</th>
                <th className="py-2 pr-3 font-medium">Mode / provenance</th>
                <th className="py-2 pr-3 font-medium">Quality</th>
                <th className="py-2 pr-3 font-medium">Safety</th>
                <th className="py-2 pr-3 font-medium">Landing page</th>
                <th className="py-2 font-medium">Next action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {summaries.map((row) => (
                <tr key={row.productId} className="align-top">
                  <td className="py-3 pr-3">
                    <p className="font-medium text-zinc-200">{row.productName}</p>
                    <p className="text-xs text-zinc-500">
                      {row.productType} · opportunity: {row.opportunityTitle ?? '—'}
                    </p>
                  </td>
                  <td className="py-3 pr-3">
                    <Badge label={row.productStatus} style={PRODUCT_STATUS_STYLES[row.productStatus]} />
                    <p className="mt-1 text-xs text-zinc-500">{row.versions} version(s)</p>
                  </td>
                  <td className="py-3 pr-3">
                    {row.specStatus ? (
                      <>
                        <Badge label={`v${row.specVersion} · ${row.specStatus}`} style={SPEC_STATUS_STYLES[row.specStatus]} />
                      </>
                    ) : (
                      <span className="text-xs text-zinc-500">No spec</span>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-xs text-zinc-400">
                    {row.generationMode ?? '—'}
                    <br />
                    <span className="text-zinc-500">{row.provenance ?? '—'}</span>
                  </td>
                  <td className="py-3 pr-3 text-xs text-zinc-300">
                    {row.qualityTotal != null ? `${row.qualityPassed}/${row.qualityTotal} gates` : '—'}
                  </td>
                  <td className="py-3 pr-3">
                    {row.halalSafetyStatus ? (
                      <Badge
                        label={row.halalSafetyStatus}
                        style={
                          row.halalSafetyStatus === 'HALAL'
                            ? SPEC_STATUS_STYLES.READY_FOR_PUBLISHING
                            : row.halalSafetyStatus === 'REVIEW_REQUIRED'
                              ? SPEC_STATUS_STYLES.VALIDATING
                              : SPEC_STATUS_STYLES.SAFETY_FAILED
                        }
                      />
                    ) : (
                      <span className="text-xs text-zinc-500">Not screened</span>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-xs text-zinc-300">
                    {row.landingPageStatus ? (
                      <>
                        {row.landingPageStatus}
                        <br />
                        <span className="text-zinc-500">CTA: {row.landingCta}</span>
                      </>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="py-3 text-xs text-zinc-400">{row.nextAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
