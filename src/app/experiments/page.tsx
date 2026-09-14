import { getExperiments } from '@/actions/experiments';
import { getOpportunities } from '@/actions/opportunities';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ExperimentCard } from '@/components/experiments/experiment-card';
import { ExperimentForm } from '@/components/experiments/experiment-form';
import { FlaskConical } from 'lucide-react';

export default async function ExperimentsPage() {
  const [experiments, opportunities] = await Promise.all([
    getExperiments(),
    getOpportunities(),
  ]);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <PageHeader
        title="Experiments"
        description="Test business ideas with measurable experiments."
      >
        <span className="rounded-lg bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
          LIVE PERSISTENCE
        </span>
      </PageHeader>

      {/* New Experiment Form */}
      <ExperimentForm opportunities={opportunities} />

      {/* Experiments List */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Active & Completed Experiments ({experiments.length})</h2>
        {experiments.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title="No experiments created yet"
            description="Create your first experiment using the form above to track hypotheses, traffic, leads, sales, and conversion decisions."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {experiments.map((exp) => (
              <ExperimentCard key={exp.id} experiment={exp} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
