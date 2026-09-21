// Phase 7 — /income-engine: the Real Income Execution Engine surface.
// Server component over real DB state; the interactive workspace handles
// stage advancement through the validated API.

import { PageHeader } from '@/components/shared/page-header';
import { IncomeEngineWorkspace } from '@/components/income-engine/income-engine-workspace';
import { getIncomeLoopState, getLoopCandidates } from '@/lib/income-engine/engine';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Income Engine — AI Income Lab' };
export const dynamic = 'force-dynamic';

export default async function IncomeEnginePage({
  searchParams,
}: {
  searchParams: Promise<{ opportunity?: string }>;
}) {
  const { opportunity: requested } = await searchParams;
  const candidates = await getLoopCandidates(20).catch(() => []);

  const selectedId =
    requested && candidates.some((c) => c.id === requested)
      ? requested
      : candidates[0]?.id ?? null;

  const state = selectedId ? await getIncomeLoopState(selectedId).catch(() => null) : null;

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Income Engine"
        description="Execute the real business loop — every stage runs through the existing job runner with halal gates, idempotency, and honest provenance. Traffic, conversions, and revenue enter only from real ingestion; publishing stays human-gated."
      />
      <IncomeEngineWorkspace
        candidates={candidates}
        initialSelectedId={selectedId}
        initialState={state}
      />
    </div>
  );
}
