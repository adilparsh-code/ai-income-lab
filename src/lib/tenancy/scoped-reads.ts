// ============================================================================
// PHASE 4.2D — SCOPED READS AND WRITE GUARDS
// ============================================================================
// The ONLY way application code reads tenant-owned records. Every function
// takes an authorized TenantScope and applies the partition filter:
//
//   tenant scope -> tenantId = <tenant>
//   legacy scope -> tenantId = NULL
//
// A record outside the scope is reported as absent (null / []), never as
// "forbidden", so an unauthorized caller cannot learn whether a foreign id
// exists. Write helpers throw TenantAccessError instead, because a write that
// targets a foreign parent is an error, not an empty result.
//
// Tenancy inheritance (no duplicated tenant columns):
//   Product            -> Opportunity.tenantId
//   ProductGeneration  -> ProductSpecification.tenantId
//   ProductVersion     -> generation.specification.tenantId
//   ProductPackage     -> version.generation.specification.tenantId
//   Offer              -> product.opportunity.tenantId
// ============================================================================

import { db } from '@/lib/db';
import {
  TenantAccessError,
  scopeTenantId,
  tenantFilter,
  type TenantScope,
} from './scope';

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export async function getScopedOpportunity(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.opportunity.findFirst({ where: { id, ...tenantFilter(scope) } });
}

export async function listScopedOpportunities(
  scope: TenantScope,
  options: { take?: number; status?: string } = {},
) {
  return db.opportunity.findMany({
    where: {
      ...tenantFilter(scope),
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.take ?? 50, 1), 200),
  });
}

/** Write guard: the opportunity must exist INSIDE the scope. */
export async function requireScopedOpportunity(scope: TenantScope, id: string) {
  const opportunity = await getScopedOpportunity(scope, id);
  if (!opportunity) throw new TenantAccessError('Forbidden: that opportunity is outside this tenant.');
  return opportunity;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function getScopedJob(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.jobRun.findFirst({ where: { id, ...tenantFilter(scope) } });
}

export async function listScopedJobs(scope: TenantScope, take = 20) {
  return db.jobRun.findMany({
    where: { ...tenantFilter(scope), status: { notIn: ['QUEUED'] } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(take, 1), 200),
  });
}

// ---------------------------------------------------------------------------
// Research results (the RESEARCH -> VALIDATION provenance artifact)
// ---------------------------------------------------------------------------

export async function getScopedResearchResult(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.researchResult.findFirst({ where: { id, ...tenantFilter(scope) } });
}

export async function listScopedResearchResults(
  scope: TenantScope,
  options: { opportunityId?: string; take?: number } = {},
) {
  return db.researchResult.findMany({
    where: {
      ...tenantFilter(scope),
      ...(options.opportunityId ? { opportunityId: options.opportunityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.take ?? 20, 1), 100),
  });
}

// ---------------------------------------------------------------------------
// Product Factory (owned through ProductSpecification)
// ---------------------------------------------------------------------------

export async function getScopedSpecification(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.productSpecification.findFirst({ where: { id, ...tenantFilter(scope) } });
}

export async function listScopedSpecifications(scope: TenantScope, take = 20) {
  return db.productSpecification.findMany({
    where: tenantFilter(scope),
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(take, 1), 100),
  });
}

export async function getScopedGeneration(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.productGeneration.findFirst({
    where: { id, specification: { tenantId: scopeTenantId(scope) } },
  });
}

export async function getScopedVersion(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.productVersion.findFirst({
    where: { id, generation: { specification: { tenantId: scopeTenantId(scope) } } },
  });
}

export async function getScopedPackage(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.productPackage.findFirst({
    where: {
      id,
      version: { generation: { specification: { tenantId: scopeTenantId(scope) } } },
    },
  });
}

export async function listScopedPackages(scope: TenantScope, versionId: string) {
  const version = await getScopedVersion(scope, versionId);
  if (!version) return [];
  return db.productPackage.findMany({ where: { versionId }, orderBy: { createdAt: 'desc' } });
}

// ---------------------------------------------------------------------------
// Products (owned through Opportunity)
// ---------------------------------------------------------------------------

export async function getScopedProduct(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.product.findFirst({
    where: { id, opportunity: { tenantId: scopeTenantId(scope) } },
  });
}

export async function listScopedProducts(scope: TenantScope, take = 50) {
  return db.product.findMany({
    where: { opportunity: { tenantId: scopeTenantId(scope) } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(take, 1), 200),
  });
}

/** Write guard: a product can only be acted on inside its authorized tenant. */
export async function requireScopedProduct(scope: TenantScope, id: string) {
  const product = await getScopedProduct(scope, id);
  if (!product) throw new TenantAccessError('Forbidden: that product is outside this tenant.');
  return product;
}

// ---------------------------------------------------------------------------
// Human reviews
// ---------------------------------------------------------------------------

export async function listScopedReviews(scope: TenantScope, status?: string) {
  return db.humanReview.findMany({
    where: { ...tenantFilter(scope), ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getScopedReview(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.humanReview.findFirst({ where: { id, ...tenantFilter(scope) } });
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function listScopedApprovalGrants(scope: TenantScope, take = 50) {
  return db.approvalGrant.findMany({
    where: tenantFilter(scope),
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(take, 1), 200),
  });
}

export async function getScopedApprovalGrant(scope: TenantScope, id: string) {
  if (!id) return null;
  return db.approvalGrant.findFirst({ where: { id, ...tenantFilter(scope) } });
}

// ---------------------------------------------------------------------------
// Audit visibility
// ---------------------------------------------------------------------------

/**
 * Tenant-scoped audit visibility. The `legacy` scope sees only global events
 * (tenantId NULL); a tenant sees only its own. There is no "see everything"
 * variant: a global administrator must be explicitly granted a tenant, and
 * global events are the legacy partition.
 */
export async function listScopedSecurityEvents(
  scope: TenantScope,
  options: { take?: number; kind?: string } = {},
) {
  return db.securityEvent.findMany({
    where: {
      ...tenantFilter(scope),
      ...(options.kind ? { kind: options.kind } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.take ?? 50, 1), 200),
    select: {
      id: true, kind: true, outcome: true, surface: true, detail: true, tenantId: true, createdAt: true,
    },
  });
}
