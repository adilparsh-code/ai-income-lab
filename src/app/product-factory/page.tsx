// Product Factory loads live database state; never prerender at build time.
export const dynamic = 'force-dynamic';

import { PageHeader } from '@/components/shared/page-header';
import { ProductFactoryWorkspace } from '@/components/product-factory/product-factory-workspace';
import { ProductPipelinePanel } from '@/components/product-factory/pipeline-panel';
import {
  getFactoryOpportunities,
  getRecentFactoryRuns,
  getProductPipelineSummaries,
} from '@/actions/product-factory';

export const metadata = {
  title: 'Product Factory — AI Income Lab',
};

export default async function ProductFactoryPage() {
  const [opportunities, recentRuns, pipelineSummaries] = await Promise.all([
    getFactoryOpportunities(),
    getRecentFactoryRuns(),
    getProductPipelineSummaries(),
  ]);

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Product Factory"
        description="Opportunity → evidence → validation → product concept → MVP → build plan → monetization → distribution. Halal gates before every step."
      />
      <ProductFactoryWorkspace opportunities={opportunities} recentRuns={recentRuns} />
      <ProductPipelinePanel summaries={pipelineSummaries} opportunities={opportunities} />
    </div>
  );
}
