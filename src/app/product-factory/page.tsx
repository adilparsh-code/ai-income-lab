// Product Factory loads live database state; never prerender at build time.
export const dynamic = 'force-dynamic';

import { PageHeader } from '@/components/shared/page-header';
import { ProductFactoryWorkspace } from '@/components/product-factory/product-factory-workspace';
import {
  getFactoryOpportunities,
  getRecentFactoryRuns,
} from '@/actions/product-factory';

export const metadata = {
  title: 'Product Factory — AI Income Lab',
};

export default async function ProductFactoryPage() {
  const [opportunities, recentRuns] = await Promise.all([
    getFactoryOpportunities(),
    getRecentFactoryRuns(),
  ]);

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Product Factory"
        description="Opportunity → evidence → validation → product concept → MVP → build plan → monetization → distribution. Halal gates before every step."
      />
      <ProductFactoryWorkspace opportunities={opportunities} recentRuns={recentRuns} />
    </div>
  );
}
