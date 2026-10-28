import { AgentControlCenter } from '@/components/agents/agent-control-center';
import { AgentControlPanel } from '@/components/agents/agent-control-panel';
import type { Metadata } from 'next';
import { requireAdminPageAccess } from '@/lib/agency/page-guard';

// Authorization is enforced server-side by the (admin) route-group layout —
// this page only renders for a verified admin session.
export const metadata: Metadata = { title: 'Agent Control Center — AI Income Lab' };

export default async function AgentsPage() {
  await requireAdminPageAccess('/agents');
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AgentControlCenter />
      {/* Phase 10A — governed runtime control layer (pause/resume/stop/restart,
          runtime configuration, versioned history, rollback, stop-all). */}
      <AgentControlPanel />
    </div>
  );
}
