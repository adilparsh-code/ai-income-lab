import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { DollarSign } from 'lucide-react';

export default function RevenuePage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Revenue"
        description="Track and analyze your income across all products and platforms."
      />

      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800 inline-flex items-center gap-2">
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold">PHASE 2</span>
        Coming soon — Revenue tracking will give you a complete picture of your earnings.
      </div>

      <EmptyState
        icon={DollarSign}
        title="Revenue Tracking"
        description="Track daily and monthly revenue by product, business model, and platform. Log transactions with gross revenue, fees, advertising costs, and net revenue. View charts and summary cards showing your real income. Revenue and validated customer demand are the ultimate success metrics."
      />
    </div>
  );
}
