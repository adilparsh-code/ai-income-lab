// ============================================================================
// PHASE 4.2E — REQUEST SCOPE FOR SERVER ACTIONS AND LOADERS
// ============================================================================
// Server Actions are public POST endpoints and loaders run inside a render.
// Both execute inside a Next.js request context, so the SAME decision function
// (resolveTenantScope) can read the admin session cookie / tenant selection
// from the real header store. No second authorization path exists.
//
// Fail closed: a refused resolution throws TenantActionError *before* any query
// runs. A server action cannot return an HTTP status, so the error is caught by
// the existing action error handling and surfaced as a generic failure — the
// data never leaves the database.
// ============================================================================

import type { TenantAuthorizationDb, TenantPermission } from '@/lib/integrations/tenant-authorization';
import {
  resolveTenantScope,
  type ScopeDenialReason,
  type TenantScope,
} from './scope';

/** Thrown when a server action or loader has no authorized tenant scope. */
export class TenantActionError extends Error {
  readonly status: 403 | 409 | 503;
  readonly reason: ScopeDenialReason;

  constructor(
    message = 'Forbidden: no authorized tenant scope for this request.',
    status: 403 | 409 | 503 = 403,
    reason: ScopeDenialReason = 'NO_PRINCIPAL',
  ) {
    super(message);
    this.name = 'TenantActionError';
    this.status = status;
    this.reason = reason;
  }
}

export interface ActionScopeOptions {
  /** Test seam: synthetic request carrying the cookie/header evidence. */
  request?: Request;
  /** Test seam: a pre-resolved principal (never supplied by production code). */
  principal?: string;
  /** Test seam: authorization store. */
  db?: TenantAuthorizationDb;
  /** Test seam: an already-authorized scope (skips resolution entirely). */
  scope?: TenantScope;
}

/**
 * Resolve the authorized scope for the current request.
 *
 * Callers pass the permission they intend to exercise, so a read-only role can
 * never accidentally perform a write through an action that forgot to check.
 */
export async function currentScope(
  permission: TenantPermission = 'tenant:read',
  surface = 'server:surface',
  options: ActionScopeOptions = {},
): Promise<TenantScope> {
  if (options.scope) return options.scope;

  let request = options.request;
  if (!request) {
    const { headers } = await import('next/headers');
    const store = await headers();
    request = new Request('http://internal.action/', {
      headers: new Headers(store as unknown as HeadersInit),
    });
  }

  const resolution = await resolveTenantScope(request, {
    permission,
    surface,
    principal: options.principal,
    db: options.db,
  });

  if (!resolution.ok) {
    throw new TenantActionError(resolution.error, resolution.status, resolution.reason);
  }
  return resolution.scope;
}
