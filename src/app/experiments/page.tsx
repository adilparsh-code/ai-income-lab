import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { FlaskConical } from 'lucide-react';

export default function ExperimentsPage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Experiments"
        description="Test business ideas with measurable experiments."
      />

      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800 inline-flex items-center gap-2">
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold">PHASE 2</span>
        Coming soon — Experiment tracking will help you validate ideas with real data.
      </div>

      <EmptyState
        icon={FlaskConical}
        title="Experiment Engine"
        description="Every business idea should become a measurable experiment. Track hypotheses, budgets, visitors, leads, clicks, sales, revenue, profit, and conversion rates. Make data-driven decisions: SCALE what works, ITERATE on promising ideas, PAUSE uncertain ones, and KILL what doesn't work. The system encourages killing weak ideas rather than endlessly investing in them."
      />
    </div>
  );
}
