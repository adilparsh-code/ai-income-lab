// ============================================================================
// PAGE-LEVEL ADMIN GUARD
// ============================================================================
// A layout that swaps `children` for a login gate does NOT stop the page from
// running or from appearing in the RSC payload (Next 16 docs:
// 01-app/02-guides/authentication.md, "Layouts and auth checks"). Every
// server-rendered admin page MUST call this before reading any data. Guarded
// by a static regression test (security/__tests__/admin-pages-guard.test.ts).
// ============================================================================

import { redirect } from 'next/navigation';
import { currentAdminSession } from './session-guard';
import type { AdminSessionInfo } from './admin-auth';

export async function requireAdminPageAccess(returnTo: string = '/'): Promise<AdminSessionInfo> {
  const session = await currentAdminSession();
  if (!session) {
    const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo.slice(0, 200) : '/';
    redirect(`/login?returnTo=${encodeURIComponent(safe)}`);
  }
  return session;
}
