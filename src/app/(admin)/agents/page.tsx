import { AgentControlCenter } from '@/components/agents/agent-control-center';
import type { Metadata } from 'next';

// Authorization is enforced server-side by the (admin) route-group layout —
// this page only renders for a verified admin session.
export const metadata: Metadata = { title: 'Agent Control Center — AI Income Lab' };

export default function AgentsPage() {
  return <AgentControlCenter />;
}
