// ============================================================================
// (admin) ROUTE GROUP — SERVER-SIDE ADMIN GATE
// ============================================================================
// Every console page (dashboard, pipeline, agents, operations, …) renders
// through this layout. Authorization is enforced HERE, on the server, before
// any page renders: an unauthenticated or non-admin request never reaches
// page code (no client-side-only security). Reuses the existing single-admin
// session layer (src/lib/agency/session-guard.ts) — no second auth system.
//
// /login intentionally lives OUTSIDE this group: it must stay reachable when
// unauthenticated. API authorization stays in each route's own guard.
// ============================================================================

import { currentAdminSession } from '@/lib/agency/session-guard';
import { AdminLoginGate } from '@/components/agents/admin-login-gate';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await currentAdminSession();
  if (!session) {
    // Fail closed: render the sign-in gate (never page data). Server-side
    // redirects are avoided so the (admin) subtree always renders the shell
    // for signed-in users without redirect loops.
    return <AdminLoginGate />;
  }
  return <>{children}</>;
}
