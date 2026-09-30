export const dynamic = 'force-dynamic';

import { PageHeader } from '@/components/shared/page-header';
import { ObservatoryWorkspace } from '@/components/observatory/observatory-workspace';
import { getObservatoryView } from '@/lib/observatory';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Observatory — AI Income Lab' };

export default async function ObservatoryPage() {
  const view = await getObservatoryView().catch(() => null);
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="AI Operations & Income Observatory"
        description="One auditable view of agents, timeline, learning, money, safety and integrations — composed from persisted records only. Unknowns stay UNKNOWN; unconnected providers stay NOT_CONNECTED."
      />
      <ObservatoryWorkspace initial={view} />
    </div>
  );
}
