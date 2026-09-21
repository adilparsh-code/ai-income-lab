import { BusinessIntelligenceSummary } from '@/actions/business-intelligence';
import { formatCurrency } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, TrendingDown, TrendingUp, Wallet } from 'lucide-react';

interface BusinessIntelligenceCardProps {
  summary: BusinessIntelligenceSummary | null;
}

const HEALTH_META: Record<
  BusinessIntelligenceSummary['revenueHealth'],
  { label: string; className: string }
> = {
  NO_DATA: { label: 'No revenue data', className: 'bg-slate-100 text-slate-700' },
  NON_POSITIVE_NET: { label: 'Net revenue not positive', className: 'bg-red-100 text-red-700' },
  UNPROFITABLE: { label: 'Unprofitable after costs', className: 'bg-amber-100 text-amber-800' },
  PROFITABLE: { label: 'Contribution profitable', className: 'bg-emerald-100 text-emerald-700' },
};

export function BusinessIntelligenceCard({ summary }: BusinessIntelligenceCardProps) {
  if (!summary) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="font-semibold">Business Intelligence</h3>
        <p className="mt-1 text-sm text-muted-foreground">Profitability summary unavailable.</p>
      </div>
    );
  }

  const health = HEALTH_META[summary.revenueHealth];
  const overall = summary.overall;

  const kpiGrid = [
    { label: 'Gross Revenue', value: formatCurrency(overall.grossRevenue) },
    { label: 'Net Revenue', value: formatCurrency(overall.netRevenue) },
    { label: 'Contribution Profit', value: formatCurrency(overall.contributionProfit) },
    {
      label: 'Contribution Margin',
      value: overall.contributionMarginPercent === null ? '—' : overall.contributionMarginPercent.toFixed(1) + '%',
    },
    { label: 'ROI', value: overall.roiPercent === null ? '—' : overall.roiPercent.toFixed(1) + '%' },
    {
      label: 'Break-even Revenue',
      value: overall.breakEvenRevenue === null ? '—' : formatCurrency(overall.breakEvenRevenue),
    },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg bg-emerald-100 p-2">
            <Wallet className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h3 className="font-semibold">Business Intelligence — Profitability</h3>
            <p className="text-xs text-muted-foreground">
              Deterministic figures from {overall.recordCount} revenue record
              {overall.recordCount === 1 ? '' : 's'}
              {overall.excludedRecordCount > 0 && ` (${overall.excludedRecordCount} invalid excluded)`}.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              summary.dataMode === 'LIVE'
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {summary.dataMode === 'LIVE' ? 'LIVE DATA' : 'MOCKED / PLANNED — NO REVENUE RECORDED'}
          </span>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${health.className}`}>
            {health.label}
          </span>
        </div>
      </div>

      {summary.error ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {summary.error}
        </div>
      ) : summary.hasRevenueData ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {kpiGrid.map((kpi) => (
              <div key={kpi.label} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{kpi.label}</p>
                <p className="mt-1 text-base font-bold tabular-nums">{kpi.value}</p>
              </div>
            ))}
          </div>

          {summary.topEntities.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Contribution profit by entity (records only where data supports it)
              </p>
              <ul className="mt-2 space-y-1.5">
                {summary.topEntities.map((entity) => (
                  <li key={entity.label} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {entity.contributionProfit >= 0 ? (
                        <TrendingUp className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      ) : (
                        <TrendingDown className="h-3.5 w-3.5 shrink-0 text-red-500" />
                      )}
                      <span className="truncate">{entity.label}</span>
                    </span>
                    <span className={`shrink-0 font-semibold tabular-nums ${entity.contributionProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                      {formatCurrency(entity.contributionProfit)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-muted-foreground">
          No real revenue records yet. All profitability figures are zero — never estimated — so this
          section shows planned state only. Record revenue in the{' '}
          <a href="/revenue" className="font-medium text-indigo-600 hover:underline">revenue tracker</a>{' '}
          to activate LIVE profitability analysis.
        </div>
      )}

      {(summary.warnings.length > 0 || summary.missingData.length > 0) && (
        <div className="mt-4 space-y-1.5">
          {summary.warnings.slice(0, 3).map((warning, i) => (
            <p key={'w' + i} className="flex items-start gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {warning}
            </p>
          ))}
          {summary.missingData.slice(0, 3).map((missing, i) => (
            <p key={'m' + i} className="flex items-start gap-1.5 text-xs text-slate-500">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              {missing}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
