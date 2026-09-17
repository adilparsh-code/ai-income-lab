// Pipeline workspace loads live database state; never prerender at build time.
export const dynamic = 'force-dynamic';

import { PageHeader } from '@/components/shared/page-header';
import { PipelineWorkspace } from '@/components/pipeline/pipeline-workspace';
import { getPipelineOpportunities, getRecentPipelineRuns } from '@/actions/pipeline';

export const metadata = {
  title: 'Opportunity → Product Pipeline — AI Income Lab',
};

export default async function PipelinePage() {
  const [opportunities, recentRuns] = await Promise.all([
    getPipelineOpportunities(),
    getRecentPipelineRuns(),
  ]);

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Opportunity → Product Pipeline"
        description="One bounded workflow: research → validation → product → experiment plan → tracking. Halal gates before every stage."
      />
      <PipelineWorkspace opportunities={opportunities} recentRuns={recentRuns} />
    </div>
  );
}
