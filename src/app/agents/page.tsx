import { requireAdminPage } from '@/lib/agency/session-guard';
import { AgentControlCenter } from '@/components/agents/agent-control-center';
import { AdminLoginGate } from '@/components/agents/admin-login-gate';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Agent Control Center — AI Income Lab' };
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const session = await requireAdminPage('/agents');
  if ('redirect' in session) {
    return <AdminLoginGate />;
  }

  return <AgentControlCenter />;
}
