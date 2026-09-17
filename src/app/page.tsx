// Dashboard data is request-time database state; never prerender at build time.
export const dynamic = 'force-dynamic';

import { getDashboardStats, getNextBestAction, getRevenueChartData } from '@/actions/dashboard';
import { getLifecycleOverview } from '@/actions/lifecycle';
import { getRecentPipelineRuns } from '@/actions/pipeline';
import { getOpportunities } from '@/actions/opportunities';
import { StatsCards } from '@/components/dashboard/stats-cards';
import { NextBestAction } from '@/components/dashboard/next-best-action';
import { RevenueChart } from '@/components/dashboard/revenue-chart';
import { TopOpportunities } from '@/components/dashboard/top-opportunities';
import { LifecyclePipeline } from '@/components/dashboard/lifecycle-pipeline';
import { PageHeader } from '@/components/shared/page-header';
import Link from 'next/link';
import { Search, BarChart3, Crown, Workflow } from 'lucide-react';

export default async function DashboardPage() {
  const [stats, nextAction, revenueData, opportunities, lifecycle, recentPipelineRuns] =
    await Promise.all([
      getDashboardStats(),
      getNextBestAction(),
      getRevenueChartData(),
      getOpportunities({ sortBy: 'overallScore', sortOrder: 'desc' }),
      getLifecycleOverview(),
      getRecentPipelineRuns(1),
    ]);
  const latestPipelineRun = recentPipelineRuns[0] ?? null;

  const topOpportunities = opportunities.slice(0, 5);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <PageHeader
        title="Dashboard"
        description="Your AI-powered halal business command center."
      >
        <div className="flex items-center gap-3">
          <Link
            href="/agents/business-manager"
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-4 py-2.5 text-sm font-medium text-indigo-700 shadow-sm hover:bg-indigo-50 transition-colors"
          >
            <Crown className="h-4 w-4" />
            Get Next Best Action
          </Link>
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

      {/* Opportunity → Product Pipeline */}
      <section>
        <div className="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-indigo-100 p-2.5">
                <Workflow className="h-5 w-5 text-indigo-600" />
              </div>
              <div>
                <h3 className="font-semibold">Opportunity → Product Pipeline</h3>
                <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
                  Run one bounded workflow — research → validation → product → experiment plan →
                  tracking — with halal gates before every stage and human-gated publishing.
                </p>
                {latestPipelineRun && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Last run: <span className="font-medium">{latestPipelineRun.status}</span>
                    {' · '}lifecycle {latestPipelineRun.currentStage}
                    {' · '}
                    {new Date(latestPipelineRun.startedAt).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                )}
              </div>
            </div>
            <Link
              href="/pipeline"
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700"
            >
              <Workflow className="h-4 w-4" />
              Open Pipeline
            </Link>
          </div>
        </div>
      </section>

      {/* Business Loop Lifecycle (Phase 4.2.4) */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Business Loop — Discover → Research → Validate → Build → Publish → Measure
        </h2>
        <LifecyclePipeline opportunities={lifecycle.opportunities} />
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