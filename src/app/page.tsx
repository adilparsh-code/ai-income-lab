import { getDashboardStats, getNextBestAction, getRevenueChartData } from '@/actions/dashboard';
import { getOpportunities } from '@/actions/opportunities';
import { StatsCards } from '@/components/dashboard/stats-cards';
import { NextBestAction } from '@/components/dashboard/next-best-action';
import { RevenueChart } from '@/components/dashboard/revenue-chart';
import { TopOpportunities } from '@/components/dashboard/top-opportunities';
import { PageHeader } from '@/components/shared/page-header';
import Link from 'next/link';
import { Search, BarChart3 } from 'lucide-react';

export default async function DashboardPage() {
  const [stats, nextAction, revenueData, opportunities] = await Promise.all([
    getDashboardStats(),
    getNextBestAction(),
    getRevenueChartData(),
    getOpportunities({ sortBy: 'overallScore', sortOrder: 'desc' }),
  ]);

  const topOpportunities = opportunities.slice(0, 5);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <PageHeader
        title="Dashboard"
        description="Your AI-powered halal business command center."
      >
        <div className="flex items-center gap-3">
          <Link
            href="/agents/analytics"
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-4 py-2.5 text-sm font-medium text-indigo-700 shadow-sm hover:bg-indigo-50 transition-colors"
          >
            <BarChart3 className="h-4 w-4" />
            Open Analytics
          </Link>
          <Link
            href="/opportunities/new"
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 transition-colors"
          >
            <Search className="h-4 w-4" />
            Find New Income Opportunities
          </Link>
        </div>
      </PageHeader>

      {/* Stats Cards */}
      <StatsCards stats={stats} />

      {/* Next Best Action */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Recommended Next Action
        </h2>
        <NextBestAction action={nextAction} />
      </section>

      {/* Charts and Top Opportunities */}
      <div className="grid gap-6 lg:grid-cols-2">
        <RevenueChart data={revenueData} />
        <TopOpportunities opportunities={topOpportunities} />
      </div>

      {/* Sample Data Notice */}
      {opportunities.some(o => o.confidenceLevel === 'SAMPLE_DATA') && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <strong>Note:</strong> The dashboard currently displays sample data for demonstration purposes.
          Sample opportunities are clearly labelled. Replace them with real research to get accurate recommendations.
        </div>
      )}
    </div>
  );
}