// Phase 7 — Compact dashboard card for the Real Income Execution Engine.
// Shows real loop aggregates over actionable opportunities; degrades honestly.

import { CircleDollarSign } from 'lucide-react';
import Link from 'next/link';

export interface IncomeEngineSummary {
  actionableOpportunities: number;
  opportunitiesAtBuildOrLater: number;
  publishedProducts: number;
  opportunitiesWithRevenue: number;
  blockedOpportunities: number;
}

export function IncomeEngineCard({ summary }: { summary: IncomeEngineSummary | null }) {
  if (!summary) {
    return (
      <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground shadow-sm">
        Income Engine summary is unavailable right now. Nothing is fabricated while it is down.
      </div>
    );
  }
  return (
    <div className="rounded-xl border bg-gradient-to-br from-emerald-50 via-white to-teal-50 p-5 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-emerald-100 p-2.5">
            <CircleDollarSign className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h3 className="font-semibold">Income Engine — execute the real loop</h3>
            <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
              {summary.actionableOpportunities} actionable opportunit{summary.actionableOpportunities === 1 ? 'y' : 'ies'} ·{' '}
              {summary.opportunitiesAtBuildOrLater} at build-or-later · {summary.publishedProducts} published ·{' '}
              {summary.opportunitiesWithRevenue} with recorded revenue · {summary.blockedOpportunities} halal-blocked.
              Publishing, spending, and irreversible actions remain human-gated.
            </p>
          </div>
        </div>
        <Link
          href="/income-engine"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700"
        >
          <CircleDollarSign className="h-4 w-4" />
          Open Income Engine
        </Link>
      </div>
    </div>
  );
}
