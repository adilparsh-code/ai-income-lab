// ============================================================================
// SERVER ACTION GUARD
// ============================================================================
// Next.js server actions are public POST endpoints: page/layout auth does NOT
// protect them. Every exported function in src/actions/* must call
// requireAdminAction() before touching data. Fail-closed: no valid admin
// session (or DB unavailable) -> throws, nothing runs.
// ============================================================================

import { currentAdminSession } from './session-guard';
import type { AdminSessionInfo } from './admin-auth';

export class UnauthorizedActionError extends Error {
  constructor() {
    super('Unauthorized: admin session required.');
    this.name = 'UnauthorizedActionError';
  }
}

export async function requireAdminAction(): Promise<AdminSessionInfo> {
  const session = await currentAdminSession();
  if (!session) throw new UnauthorizedActionError();
  return session;
}
