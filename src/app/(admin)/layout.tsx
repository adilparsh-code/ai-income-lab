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
import { Sidebar } from '@/components/layout/sidebar';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await currentAdminSession();
  // Console chrome (Sidebar + offset main) renders for every console route —
  // signed-in users see the page, everyone else sees the sign-in gate inside
  // the same shell (identical rendering to when the shell lived in the root
  // layout). The public storefront lives OUTSIDE this group and never shows
  // admin navigation.
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 lg:ml-64">
        {session ? children : <AdminLoginGate />}
      </main>
    </div>
  );
}
