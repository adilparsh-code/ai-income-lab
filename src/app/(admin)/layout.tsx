// ============================================================================
// (admin) ROUTE GROUP — SERVER-SIDE ADMIN GATE
// ============================================================================
// This layout is UX ONLY (it shows the sign-in gate instead of the console
// chrome). It is NOT an authorization boundary: Next renders route segments
// independently of the layout, so a page still executes — and its output still
// appears in the RSC payload — even when this layout swaps in the gate
// (Next 16 docs: 01-app/02-guides/authentication.md, "Layouts and auth
// checks"). Authorization is therefore enforced in EVERY page via
// requireAdminPageAccess() (src/lib/agency/page-guard.ts) and in every server
// action via requireAdminAction(); a static test fails the build if a page
// omits the guard. Reuses the single-admin session layer (session-guard.ts).
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
