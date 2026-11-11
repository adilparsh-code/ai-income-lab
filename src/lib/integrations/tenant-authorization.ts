// Phase 4.2C/4.2D — server-side tenant authorization.
//
// TRUST MODEL
// -----------
//   1. The caller is authenticated by an EXISTING gate: the operator credential
//      gate (requireOperator, returning a credential FINGERPRINT) or the admin
//      session gate (keyed fingerprint of the stable admin identity). Neither
//      ever yields a client-asserted name.
//   2. That fingerprint is the authoritative principal. Nothing in the request
//      body can change it.
//   3. Membership is resolved SERVER-SIDE from TenantMembership rows. A request
//      may only name a tenant it already belongs to; naming a tenant is an
//      address, not a grant.
//   4. Anything unresolvable, ambiguous, inactive, suspended, unreadable or
//      role-denied is refused. There is no default tenant and no fallback.
//
// One decision function serves every surface (handoff delivery, console reads,
// console writes, tenant administration). Surfaces differ only in the
// permission they require, never in how identity or membership is proven.
//
// This module performs NO writes to business tables; it returns a decision and
// records a bounded audit event. Persistence of the tenant binding is the
// caller's job.

export const TENANT_SURFACE = 'api:handoff:receive';

/** Permission required for a handoff delivery. Kept explicit so it can grow. */
export const HANDOFF_PERMISSION = 'handoff:submit';

/**
 * Permissions understood by the tenant boundary. An unknown permission never
 * authorizes anything (it maps to no roles at all).
 */
export const TENANT_PERMISSIONS = [
  'handoff:submit',
  'tenant:read',
  'tenant:write',
  'tenant:admin',
] as const;

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];

/**
 * Role → permissions. ADMIN implies SENDER. VIEWER is read-only. Unknown roles
 * authorize nothing. This is the single role table; no surface invents its own.
 */
export const TENANT_ROLE_PERMISSIONS: Record<string, readonly TenantPermission[]> = {
  VIEWER: ['tenant:read'],
  SENDER: ['tenant:read', 'tenant:write', 'handoff:submit'],
  ADMIN: ['tenant:read', 'tenant:write', 'handoff:submit', 'tenant:admin'],
};

/** Roles allowed to submit handoffs. ADMIN implies SENDER. */
export const HANDOFF_ALLOWED_ROLES = ['SENDER', 'ADMIN'] as const;

export interface TenantMembershipRow {
  tenantId: string;
  role: string;
  status: string;
  tenant: { id?: string; slug: string; status: string };
}

/**
 * Narrow persistence seam. The real implementation is Prisma; tests inject an
 * in-memory or SQLite-backed one. Deliberately small so it cannot become a
 * second data-access layer.
 */
export interface TenantAuthorizationDb {
  tenantMembership: {
    findMany(args: {
      where: { principalFingerprint: string; status?: string };
      include: { tenant: true };
    }): Promise<TenantMembershipRow[]>;
  };
  securityEvent: {
    create(args: {
      data: {
        kind: string;
        surface: string;
        outcome: string;
        detail?: string | null;
        tenantId?: string | null;
      };
    }): Promise<unknown>;
  };
}

export type TenantDenialReason =
  | 'MISSING_PRINCIPAL'
  | 'NO_MEMBERSHIP'
  | 'TENANT_NOT_REQUESTED'
  | 'TENANT_NOT_AUTHORIZED'
  | 'TENANT_INACTIVE'
  | 'MEMBERSHIP_SUSPENDED'
  | 'ROLE_NOT_PERMITTED'
  | 'AUTHORIZATION_UNAVAILABLE';

export type TenantAuthorizationResult =
  | { ok: true; tenantId: string; tenantSlug: string; role: string; membershipCount: number }
  | { ok: false; status: 403 | 409 | 503; reason: TenantDenialReason; error: string };

export interface TenantAccessInput {
  db: TenantAuthorizationDb;
  /** Authenticated principal fingerprint. Never a body value. */
  principalFingerprint: string | null | undefined;
  /** Tenant the caller asks to act for. Optional when the principal has exactly one. */
  requestedTenantSlug?: string | null;
  /** Permission being attempted; enforced against the membership role. */
  permission?: TenantPermission | string;
  /** Audit surface label (bounded). */
  surface?: string;
}

export interface AuthorizeTenantInput extends Omit<TenantAccessInput, 'permission' | 'surface'> {
  /** Permission being attempted; enforced against the membership role. */
  permission?: string;
}

function refuse(
  status: 403 | 409 | 503,
  reason: TenantDenialReason,
  error: string,
): TenantAuthorizationResult {
  return { ok: false, status, reason, error };
}

async function audit(
  db: TenantAuthorizationDb,
  surface: string,
  kind: string,
  outcome: 'ok' | 'refused' | 'error',
  detail: string,
): Promise<void> {
  try {
    await db.securityEvent.create({
      data: { kind, surface, outcome, detail: detail.slice(0, 300) },
    });
  } catch {
    // Auditing must never break the authorization decision path.
  }
}

/**
 * Role enforcement. Unknown roles and unknown permissions authorize nothing.
 * Reads the single role→permission table above; it never widens access.
 */
export function roleAllows(role: string, permission: string): boolean {
  const normalizedRole = String(role).toUpperCase();
  const allowed = TENANT_ROLE_PERMISSIONS[normalizedRole];
  if (!allowed) return false;
  if (!(TENANT_PERMISSIONS as readonly string[]).includes(permission)) return false;
  return allowed.includes(permission as TenantPermission);
}

/** Backwards-compatible handoff role check (4.2C semantics preserved). */
export function canSubmitHandoff(role: string, permission: string = HANDOFF_PERMISSION): boolean {
  if (permission !== HANDOFF_PERMISSION) return false;
  return (HANDOFF_ALLOWED_ROLES as readonly string[]).includes(String(role).toUpperCase());
}

/**
 * Decide whether the authenticated principal may act for a tenant.
 *
 * Fail-closed by construction: every branch that cannot prove a positive,
 * unambiguous, active membership with the required permission returns a
 * refusal, and every refusal is audited with a stable reason code (never the
 * principal, credentials or tenant existence details).
 */
export async function authorizeTenantAccess(
  input: TenantAccessInput,
): Promise<TenantAuthorizationResult> {
  const surface = (input.surface ?? TENANT_SURFACE).slice(0, 80);
  const permission = String(input.permission ?? HANDOFF_PERMISSION);
  const principal = input.principalFingerprint?.trim() ?? '';

  if (principal.length === 0) {
    await audit(input.db, surface, 'TENANT_REFUSED', 'refused', 'missing-principal');
    return refuse(403, 'MISSING_PRINCIPAL', 'Unauthorized: no authenticated principal.');
  }

  let memberships: TenantMembershipRow[];
  try {
    memberships = await input.db.tenantMembership.findMany({
      where: { principalFingerprint: principal, status: 'ACTIVE' },
      // The tenant status/slug are authoritative server-side data; a membership
      // row alone is not enough to authorize.
      include: { tenant: true },
    });
  } catch {
    // An unreachable/erroring authorization backend must never grant access.
    await audit(input.db, surface, 'TENANT_ERROR', 'error', 'authorization-unavailable');
    return refuse(
      503,
      'AUTHORIZATION_UNAVAILABLE',
      'Authorization is temporarily unavailable. Nothing was executed.',
    );
  }

  if (memberships.length === 0) {
    await audit(input.db, surface, 'TENANT_REFUSED', 'refused', 'no-membership');
    return refuse(403, 'NO_MEMBERSHIP', 'Forbidden: this principal has no tenant membership.');
  }

  const requested = input.requestedTenantSlug?.trim().toLowerCase() ?? '';
  let selected: TenantMembershipRow[];

  if (requested.length === 0) {
    // Without an explicit target the decision must be unambiguous. Several
    // memberships and no target is a refusal, never "pick the first one".
    if (memberships.length > 1) {
      await audit(input.db, surface, 'TENANT_REFUSED', 'refused', 'tenant-not-requested');
      return refuse(
        409,
        'TENANT_NOT_REQUESTED',
        'A target tenant is required: this principal belongs to more than one tenant.',
      );
    }
    selected = memberships;
  } else {
    selected = memberships.filter((m) => m.tenant?.slug?.toLowerCase() === requested);
    if (selected.length === 0) {
      // Indistinguishable from "no such tenant" on purpose: a caller must not
      // be able to probe which tenants exist.
      await audit(input.db, surface, 'TENANT_REFUSED', 'refused', 'tenant-not-authorized');
      return refuse(403, 'TENANT_NOT_AUTHORIZED', 'Forbidden: not authorized for that tenant.');
    }
  }

  const membership = selected[0];

  if (String(membership.status).toUpperCase() !== 'ACTIVE') {
    await audit(input.db, surface, 'TENANT_REFUSED', 'refused', 'membership-suspended');
    return refuse(403, 'MEMBERSHIP_SUSPENDED', 'Forbidden: the tenant membership is not active.');
  }
  if (String(membership.tenant?.status ?? '').toUpperCase() !== 'ACTIVE') {
    await audit(input.db, surface, 'TENANT_REFUSED', 'refused', 'tenant-inactive');
    return refuse(403, 'TENANT_INACTIVE', 'Forbidden: the tenant is not active.');
  }
  if (!roleAllows(membership.role, permission)) {
    await audit(input.db, surface, 'TENANT_REFUSED', 'refused', 'role-not-permitted');
    return refuse(403, 'ROLE_NOT_PERMITTED', 'Forbidden: this membership may not perform that action.');
  }

  await audit(input.db, surface, 'TENANT_AUTHORIZED', 'ok', `${membership.tenant.slug}:${membership.role}`);
  return {
    ok: true,
    tenantId: membership.tenantId,
    tenantSlug: membership.tenant.slug,
    role: membership.role,
    membershipCount: memberships.length,
  };
}

/**
 * Handoff-boundary decision. Delegates to the shared core with the handoff
 * permission, so delivery and console authorization can never diverge.
 */
export async function authorizeHandoffTenant(
  input: AuthorizeTenantInput,
): Promise<TenantAuthorizationResult> {
  return authorizeTenantAccess({
    db: input.db,
    principalFingerprint: input.principalFingerprint,
    requestedTenantSlug: input.requestedTenantSlug,
    permission: input.permission ?? HANDOFF_PERMISSION,
    surface: TENANT_SURFACE,
  });
}
