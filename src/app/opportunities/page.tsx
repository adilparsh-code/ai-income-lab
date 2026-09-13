import { Suspense } from 'react';
import { getOpportunities } from '@/actions/opportunities';
import type { OpportunityFilters as OpportunityFiltersType } from '@/actions/opportunities';
import { OpportunityCard } from '@/components/opportunities/opportunity-card';
import { OpportunityFilters } from '@/components/opportunities/filters';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import Link from 'next/link';
import { Plus, Lightbulb } from 'lucide-react';

interface Props {
  searchParams: Promise<{
    search?: string;
    status?: string | string[];
    category?: string | string[];
    halal?: string | string[];
    sortBy?: string;
    sortOrder?: string;
  }>;
}

export default async function OpportunitiesPage({ searchParams }: Props) {
  const params = await searchParams;
  
  const toArray = (val?: string | string[]) => {
    if (!val) return undefined;
    return Array.isArray(val) ? val : [val];
  };

  const opportunities = await getOpportunities({
    search: params.search,
    status: toArray(params.status),
    category: toArray(params.category),
    halalStatus: toArray(params.halal),
        sortBy: (params.sortBy as OpportunityFiltersType['sortBy']) ?? 'overallScore',
    sortOrder: (params.sortOrder as 'asc' | 'desc') || 'desc',
  });

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Opportunities"
        description="Discover, evaluate, and track business opportunities."
      >
        <Link
          href="/opportunities/new"
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Opportunity
        </Link>
      </PageHeader>

      <Suspense fallback={<div className="animate-pulse h-20 bg-muted rounded-lg" />}>
        <OpportunityFilters />
      </Suspense>

      {opportunities.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No opportunities found"
          description="Create your first opportunity or adjust your filters to see results."
          actionLabel="Create Opportunity"
          actionHref="/opportunities/new"
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {opportunities.length} opportunity{opportunities.length !== 1 ? 'ies' : 'y'} found
          </p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {opportunities.map((opp) => (
              <OpportunityCard key={opp.id} opportunity={opp} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
