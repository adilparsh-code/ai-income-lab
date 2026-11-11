// ============================================================================
// PHASE 4.2D — TENANT SCOPE (the single authorization boundary for data reads)
// ============================================================================
//
// Every tenant-owned read/write goes through a TenantScope. A scope can only
// be produced by this module, and only from a verified principal:
//
//   * operator credential  -> HMAC fingerprint (same principal the handoff
//                             boundary already uses)
//   * admin session cookie -> admin:<keyed fingerprint of the stable admin
//                             email> (stable across sessions; never the token)
//
// The request may NAME a tenant (x-tenant-id header or ail_tenant cookie), but
// naming is an address, never a grant: the membership is always looked up
// server-side and the selection rules are the ones already proven at the
// handoff boundary (authorizeTenantAccess).
//
// LEGACY PARTITION (explicit, not a fallback)
// -------------------------------------------
// The application predates tenancy, so some rows have tenantId = NULL. Those
// rows are never handed to a tenant member. A principal with ZERO memberships
// is the global operator/admin and gets a `legacy` scope that can only see
// tenantId = NULL rows. The two partitions are disjoint:
//
//   tenant scope -> tenantId = <that tenant>   (never NULL, never another)
//   legacy scope -> tenantId = NULL            (never a tenant's rows)
//
// So no principal can read across the boundary in either direction, and no
// tenant ever sees unattributed legacy data. An operator can adopt legacy rows
// into a tenant explicitly (scripts/adopt-legacy-tenant.mjs); until then they
// stay unreachable for tenants.
// ============================================================================

import { credentialFingerprint } from '@/lib/security/guard';
import {
  authorizeTenantAccess,
  type TenantAccessInput,
  type TenantAuthorizationDb,
  type TenantDenialReason,
  type TenantPermission,
} from '@/lib/integrations/tenant-authorization';

export const TENANT_HEADER = 'x-tenant-id';
export const TENANT_COOKIE = 'ail_tenant';
export const ADMIN_PRINCIPAL_PREFIX = 'admin:';

/** Authoritative tenant context for one authorized request. */
export interface TenantScopeTenant {
  mode: 'tenant';
  tenantId: string;
  tenantSlug: string;
  principal: string;
  role: string;
}

/** Global operator/admin context: may only see unattributed (NULL tenant) rows. */
export interface TenantScopeLegacy {
  mode: 'legacy';
  principal: string;
}

export type TenantScope = TenantScopeTenant | TenantScopeLegacy;

export type ScopeDenialReason = TenantDenialReason | 'NO_PRINCIPAL';

export type TenantScopeResolution =
  | { ok: true; scope: TenantScope }
  | { ok: false; status: 403 | 409 | 503; reason: ScopeDenialReason; error: string };

/** Raised when a caller tries to act outside its authorized tenant partition. */
export class TenantAccessError extends Error {
  readonly status: 403;
  constructor(message = 'Forbidden: that resource is outside this tenant.') {
    super(message);
    this.name = 'TenantAccessError';
    this.status = 403;
  }
}

// ---------------------------------------------------------------------------
// Principal resolution (never from a body)
// ---------------------------------------------------------------------------

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    if (rawKey?.trim() === name) {
      const value = rest.join('=').trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Stable principal for the signed-in admin. Derived from the admin EMAIL, not
 * the session token, so a new login keeps the same tenant memberships. The
 * session itself must already be verified by the caller (session guard).
 */
export function adminPrincipal(email: string): string {
  return `${ADMIN_PRINCIPAL_PREFIX}${credentialFingerprint(email.trim().toLowerCase())}`;
}

/** Principal for a server-to-server operator credential (fingerprint only). */
export function operatorPrincipal(token: string): string {
  return credentialFingerprint(token);
}

/**
 * Resolve the principal from the ACTUAL request.
 *
 * Precedence: a live admin session wins over a bearer credential (a browser
 * caller may carry both; the session is the human identity). A bogus session
 * cookie is not a principal: it is ignored and falls through to the bearer
 * check, which the route guard already gates.
 */
export async function resolvePrincipal(
  request: Request,
): Promise<{ principal: string; kind: 'admin' | 'operator' } | null> {
  const sessionToken = cookieValue(request, 'aill_admin_session');
  if (sessionToken) {
    const { resolveAdminSession } = await import('@/lib/agency/admin-auth');
    const session = await resolveAdminSession(sessionToken);
    if (session) return { principal: adminPrincipal(session.email), kind: 'admin' };
  }
  const token = bearerToken(request);
  if (token) return { principal: operatorPrincipal(token), kind: 'operator' };
  return null;
}

/** Tenant the caller asked for. Header first, then cookie. Never trusted. */
export function requestedTenantSlug(request: Request): string | null {
  const header = request.headers.get(TENANT_HEADER)?.trim();
  if (header) return header.slice(0, 100);
  const cookie = cookieValue(request, TENANT_COOKIE);
  return cookie ? cookie.slice(0, 100) : null;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

export interface ResolveScopeOptions {
  /** Permission the caller is about to exercise. Defaults to tenant:read. */
  permission?: TenantPermission;
  surface?: string;
  /** Test seam only. */
  db?: TenantAuthorizationDb;
  /** Test seam: pre-resolved principal (skips request identity resolution). */
  principal?: string;
}

async function defaultDb(): Promise<TenantAuthorizationDb> {
  const { db } = await import('@/lib/db');
  return db as unknown as TenantAuthorizationDb;
}

async function auditScope(
  db: TenantAuthorizationDb,
  surface: string,
  kind: string,
  outcome: 'ok' | 'refused' | 'error',
  detail: string,
): Promise<void> {
  try {
    await db.securityEvent.create({ data: { kind, surface: surface.slice(0, 80), outcome, detail: detail.slice(0, 300) } });
  } catch {
    // Auditing must never break the request path.
  }
}

/**
 * Resolve the authoritative scope for a request. Fails closed: no principal,
 * an unreadable store, an ambiguous selection, an inactive tenant or a role
 * without the required permission all refuse.
 */
export async function resolveTenantScope(
  request: Request,
  options: ResolveScopeOptions = {},
): Promise<TenantScopeResolution> {
  const surface = (options.surface ?? 'tenant:scope').slice(0, 80);
  const permission = options.permission ?? 'tenant:read';
  const db = options.db ?? (await defaultDb());

  let principal = options.principal ?? '';
  if (!principal) {
    const resolved = await resolvePrincipal(request);
    if (!resolved) {
      await auditScope(db, surface, 'TENANT_REFUSED', 'refused', 'missing-principal');
      return { ok: false, status: 403, reason: 'NO_PRINCIPAL', error: 'Unauthorized: no authenticated principal.' };
    }
    principal = resolved.principal;
  }

  // Membership existence decides the partition. A read failure here must never
  // be interpreted as "no memberships" (which would grant the legacy scope).
  //
  // IMPORTANT: the lookup is deliberately NOT filtered to ACTIVE rows. A
  // principal whose only membership is SUSPENDED must be refused — if the
  // query filtered by status, it would look like "no memberships" and hand out
  // the legacy scope, turning a suspension into access to global data.
  let activeMembershipCount: number;
  let totalMembershipCount: number;
  try {
    const memberships = await db.tenantMembership.findMany({
      where: { principalFingerprint: principal },
      include: { tenant: true },
    });
    totalMembershipCount = memberships.length;
    activeMembershipCount = memberships.filter(
      (m) => String(m.status).toUpperCase() === 'ACTIVE',
    ).length;
  } catch {
    await auditScope(db, surface, 'TENANT_ERROR', 'error', 'authorization-unavailable');
    return {
      ok: false,
      status: 503,
      reason: 'AUTHORIZATION_UNAVAILABLE',
      error: 'Authorization is temporarily unavailable. Nothing was returned.',
    };
  }

  if (totalMembershipCount > 0 && activeMembershipCount === 0) {
    await auditScope(db, surface, 'TENANT_REFUSED', 'refused', 'membership-suspended');
    return {
      ok: false,
      status: 403,
      reason: 'MEMBERSHIP_SUSPENDED',
      error: 'Forbidden: the tenant membership is not active.',
    };
  }

  if (totalMembershipCount === 0) {
    // Global operator/admin: unattributed data only. Not a tenant fallback.
    await auditScope(db, surface, 'TENANT_SCOPE_LEGACY', 'ok', 'no-membership');
    return { ok: true, scope: { mode: 'legacy', principal } };
  }

  const input: TenantAccessInput = {
    db,
    principalFingerprint: principal,
    requestedTenantSlug: requestedTenantSlug(request),
    permission,
    surface,
  };
  const decision = await authorizeTenantAccess(input);
  if (!decision.ok) {
    return { ok: false, status: decision.status, reason: decision.reason, error: decision.error };
  }
  return {
    ok: true,
    scope: {
      mode: 'tenant',
      tenantId: decision.tenantId,
      tenantSlug: decision.tenantSlug,
      principal,
      role: decision.role,
    },
  };
}

/**
 * Resolve the scope for a server component (page/layout), which receives no
 * Request object. The Next.js header store carries the same cookie/header
 * evidence a route would see, so the SAME decision function is used — there is
 * no page-specific authorization path.
 */
export async function resolveScopeForServerComponent(
  options: ResolveScopeOptions = {},
): Promise<TenantScopeResolution> {
  const { headers } = await import('next/headers');
  const store = await headers();
  const request = new Request('http://internal.component/', {
    headers: new Headers(store as unknown as HeadersInit),
  });
  return resolveTenantScope(request, options);
}

/**
 * Build a scope from an authorization decision that ALREADY happened (e.g. the
 * handoff receiver). The tenant id must come from that verified decision, never
 * from request input.
 */
export function tenantScopeFromDecision(decision: {
  tenantId: string;
  tenantSlug: string;
  role: string;
}, principal: string): TenantScopeTenant {
  return { mode: 'tenant', tenantId: decision.tenantId, tenantSlug: decision.tenantSlug, principal, role: decision.role };
}

// ---------------------------------------------------------------------------
// Partition helpers (used by every scoped query)
// ---------------------------------------------------------------------------

/** The only legal tenant filter for a scope. Disjoint partitions. */
export function scopeTenantId(scope: TenantScope): string | null {
  return scope.mode === 'tenant' ? scope.tenantId : null;
}

/**
 * Prisma `where` fragment for a directly tenant-owned model.
 * Callers must spread it into EVERY read/write filter.
 */
export function tenantFilter(scope: TenantScope): { tenantId: string | null } {
  return { tenantId: scopeTenantId(scope) };
}

/**
 * Verify that a record's owning tenant matches the scope before acting on it.
 * Returns false (never throws) so read paths can answer 404 without revealing
 * whether a foreign row exists.
 */
export function tenantOwnedByScope(scope: TenantScope, ownerTenantId: string | null | undefined): boolean {
  return (ownerTenantId ?? null) === scopeTenantId(scope);
}

/**
 * Write-path guard: attaching to a parent outside the scope is refused. This is
 * the child-record rule (a job/research/product/review can never be attached to
 * another tenant's parent).
 */
export function assertTenantAttachment(
  scope: TenantScope,
  ownerTenantId: string | null | undefined,
  message?: string,
): void {
  if (!tenantOwnedByScope(scope, ownerTenantId)) throw new TenantAccessError(message);
}

/** SQL-ish filter for models whose tenancy is inherited through a relation. */
export function relationTenantFilter(
  scope: TenantScope,
  relation: string,
): Record<string, { tenantId: string | null }> {
  return { [relation]: { tenantId: scopeTenantId(scope) } };
}
