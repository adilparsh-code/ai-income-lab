export const dynamic = 'force-dynamic';

import { PageHeader } from '@/components/shared/page-header';
import { OperationsWorkspace } from '@/components/operations/operations-workspace';
import { getPhase8OperationsView } from '@/lib/ops/dashboard';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Operations — AI Income Lab' };

export default async function OperationsPage() {
  const view = await getPhase8OperationsView().catch(() => null);
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Operations"
        description="Production health, execution, income engine, and agent timeline. Unavailable systems are labelled NOT_CONFIGURED / NOT_CONNECTED / BLOCKED — never hidden. Simulated figures are never mixed with real revenue."
      />
      <OperationsWorkspace initial={view} />
    </div>
  );
}
