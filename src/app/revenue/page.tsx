import { getRevenues, getRevenueSummary } from '@/actions/revenue';
import { getOpportunities } from '@/actions/opportunities';
import { db } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { RevenueForm } from '@/components/revenue/revenue-form';
import { formatCurrency, formatDate } from '@/lib/utils';
import { DollarSign, TrendingUp, Receipt, Wallet, Trash2 } from 'lucide-react';
import { deleteRevenue } from '@/actions/revenue';

export default async function RevenuePage() {
  const [revenues, summary, opportunities, products] = await Promise.all([
    getRevenues(),
    getRevenueSummary(),
    getOpportunities(),
    db.product.findMany({ select: { id: true, name: true } }),
  ]);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <PageHeader
        title="Revenue"
        description="Track and analyze your income across all products and platforms."
      >
        <span className="rounded-lg bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
          LIVE PERSISTENCE
        </span>
      </PageHeader>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <DollarSign className="h-4 w-4 text-emerald-600" />
            <span>Total Net Revenue</span>
          </div>
          <p className="text-2xl font-bold text-emerald-600">{formatCurrency(summary.totalNet)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">From {summary.entryCount} total entries</p>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <TrendingUp className="h-4 w-4 text-indigo-600" />
            <span>This Month (Net)</span>
          </div>
          <p className="text-2xl font-bold text-indigo-600">{formatCurrency(summary.thisMonthNet)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Current calendar month</p>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <Wallet className="h-4 w-4 text-blue-600" />
            <span>Total Gross</span>
          </div>
          <p className="text-2xl font-bold">{formatCurrency(summary.totalGross)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Before fees & ad costs</p>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <Receipt className="h-4 w-4 text-amber-600" />
            <span>Total Costs</span>
          </div>
          <p className="text-2xl font-bold text-amber-600">
            {formatCurrency(summary.totalFees + summary.totalAdCost + summary.totalOtherCosts)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">Fees, Ads, & Expenses</p>
        </div>
      </div>

      {/* Entry Form */}
      <RevenueForm opportunities={opportunities} products={products} />

      {/* Transactions Table */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Logged Transactions ({revenues.length})</h2>
        {revenues.length === 0 ? (
          <EmptyState
            icon={DollarSign}
            title="No revenue logged yet"
            description="Log your first income entry using the form above. Track gross, fees, ads, and net profit per opportunity."
          />
        ) : (
          <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 border-b text-xs font-semibold uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Date</th>
                  <th className="p-3">Source</th>
                  <th className="p-3">Linked Opportunity</th>
                  <th className="p-3 text-right">Gross</th>
                  <th className="p-3 text-right">Fees/Costs</th>
                  <th className="p-3 text-right">Net Revenue</th>
                  <th className="p-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {revenues.map((rev) => {
                  const costs = (rev.fees || 0) + (rev.advertisingCost || 0) + (rev.otherCosts || 0);
                  return (
                    <tr key={rev.id} className="hover:bg-muted/30 transition-colors">
                      <td className="p-3 font-medium whitespace-nowrap">{formatDate(rev.date)}</td>
                      <td className="p-3">
                        <div>
                          <p className="font-semibold text-foreground">{rev.revenueSource}</p>
                          {rev.referenceNote && (
                            <p className="text-xs text-muted-foreground">{rev.referenceNote}</p>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {rev.opportunity ? (
                          <span className="text-indigo-600 font-medium">
                            {rev.opportunity.title.replace('[SAMPLE] ', '')}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="p-3 text-right font-mono">{formatCurrency(rev.grossRevenue)}</td>
                      <td className="p-3 text-right font-mono text-amber-600">
                        {costs > 0 ? `-${formatCurrency(costs)}` : '$0.00'}
                      </td>
                      <td className="p-3 text-right font-mono font-bold text-emerald-600">
                        {formatCurrency(rev.netRevenue)}
                      </td>
                      <td className="p-3 text-center">
                        <form
                          action={async () => {
                            'use server';
                            await deleteRevenue(rev.id);
                          }}
                        >
                          <button
                            type="submit"
                            className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                            title="Delete entry"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
