// ============================================================================
// PHASE 4.2E — RELATION-DERIVED TENANT FILTERS
// ============================================================================
// Most business models predate tenancy and do not carry a tenantId of their
// own: their owner is the opportunity (or the product's opportunity) they hang
// off. The partition must still be enforced at the DATABASE level, so this
// module is the single place that translates a TenantScope into a Prisma
// `where` fragment for those models.
//
// Rule (identical to the direct-column rule in scope.ts):
//   tenant scope -> the owning opportunity's tenantId = <that tenant>
//   legacy scope -> the record is unattributed: no opportunity, or an
//                   opportunity whose tenantId is NULL
//
// The two sets are disjoint, so a relation-owned row can never be visible from
// both partitions, and no tenant can read another tenant's derived rows.
//
// These fragments are meant to be SPREAD into an existing where clause, so
// they can be combined with search/filter/pagination conditions by AND.
// ============================================================================

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { TenantAccessError, scopeTenantId, type TenantScope } from './scope';

const T = (scope: TenantScope) => scopeTenantId(scope);

// ---------------------------------------------------------------------------
// Direct column (already supported in 4.2D, mirrored here for convenience)
// ---------------------------------------------------------------------------

export function opportunityWhere(scope: TenantScope): Prisma.OpportunityWhereInput {
  return { tenantId: T(scope) };
}

export function pipelineRunWhere(scope: TenantScope): Prisma.PipelineRunWhereInput {
  return { tenantId: T(scope) };
}

// ---------------------------------------------------------------------------
// Models owned through Opportunity
// ---------------------------------------------------------------------------

/** The owner's opportunity exists and belongs to the scope. */
function viaOpportunityTenant(scope: TenantScope) {
  return { opportunity: { is: { tenantId: T(scope) } } };
}

/** Unattributed: no opportunity at all, or an opportunity with no tenant. */
function viaOpportunityLegacy() {
  return {
    OR: [
      { opportunityId: null },
      { opportunity: { is: { tenantId: null } } },
    ],
  };
}

export function productWhere(scope: TenantScope): Prisma.ProductWhereInput {
  return (scope.mode === 'tenant' ? viaOpportunityTenant(scope) : viaOpportunityLegacy()) as Prisma.ProductWhereInput;
}

export function experimentWhere(scope: TenantScope): Prisma.ExperimentWhereInput {
  return (scope.mode === 'tenant' ? viaOpportunityTenant(scope) : viaOpportunityLegacy()) as Prisma.ExperimentWhereInput;
}

export function evidenceItemWhere(scope: TenantScope): Prisma.EvidenceItemModelWhereInput {
  return (scope.mode === 'tenant' ? viaOpportunityTenant(scope) : viaOpportunityLegacy()) as Prisma.EvidenceItemModelWhereInput;
}

export function workflowRunWhere(scope: TenantScope): Prisma.WorkflowRunWhereInput {
  return (scope.mode === 'tenant' ? viaOpportunityTenant(scope) : viaOpportunityLegacy()) as Prisma.WorkflowRunWhereInput;
}

// NOTE: HalalReview.opportunityId has no Prisma relation field, so its
// partition is enforced by first resolving the opportunity inside the scope
// (assertOpportunityInScope) and then filtering on that verified id.

// ---------------------------------------------------------------------------
// Models owned through Opportunity OR Product -> Opportunity
// (Revenue and Offer may be attributed to either)
// ---------------------------------------------------------------------------

export function revenueWhere(scope: TenantScope): Prisma.RevenueWhereInput {
  if (scope.mode === 'tenant') {
    return {
      OR: [
        { opportunity: { is: { tenantId: T(scope) } } },
        {
          opportunityId: null,
          product: { is: { opportunity: { is: { tenantId: T(scope) } } } },
        },
      ],
    };
  }
  return {
    AND: [
      { OR: [{ opportunityId: null }, { opportunity: { is: { tenantId: null } } }] },
      {
        OR: [
          { productId: null },
          { product: { is: { opportunityId: null } } },
          { product: { is: { opportunity: { is: { tenantId: null } } } } },
        ],
      },
    ],
  };
}

export function offerWhere(scope: TenantScope): Prisma.OfferWhereInput {
  if (scope.mode === 'tenant') {
    return {
      OR: [
        { opportunity: { is: { tenantId: T(scope) } } },
        {
          opportunityId: null,
          product: { is: { opportunity: { is: { tenantId: T(scope) } } } },
        },
      ],
    };
  }
  return {
    AND: [
      { OR: [{ opportunityId: null }, { opportunity: { is: { tenantId: null } } }] },
      {
        OR: [
          { productId: null },
          { product: { is: { opportunityId: null } } },
          { product: { is: { opportunity: { is: { tenantId: null } } } } },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Models owned through Product -> Opportunity
// ---------------------------------------------------------------------------

function viaProductTenant(scope: TenantScope) {
  return { product: { opportunity: { is: { tenantId: T(scope) } } } };
}

function viaProductLegacy() {
  return {
    product: {
      OR: [
        { opportunityId: null },
        { opportunity: { is: { tenantId: null } } },
      ],
    },
  };
}

export function productBuildWhere(scope: TenantScope): Prisma.ProductBuildWhereInput {
  return scope.mode === 'tenant' ? viaProductTenant(scope) : viaProductLegacy();
}

export function productDeploymentWhere(scope: TenantScope): Prisma.ProductDeploymentWhereInput {
  return scope.mode === 'tenant' ? viaProductTenant(scope) : viaProductLegacy();
}

export function productAssetWhere(scope: TenantScope): Prisma.ProductAssetWhereInput {
  return scope.mode === 'tenant' ? viaProductTenant(scope) : viaProductLegacy();
}

// ---------------------------------------------------------------------------
// Write-path attachment guards
// ---------------------------------------------------------------------------
// A child row may only be attached to a parent that already belongs to the
// caller's partition. Without this, a tenant could create a record pointing at
// another tenant's opportunity (or at an unattributed legacy row) and read it
// back through its own partition.

export async function assertOpportunityInScope(scope: TenantScope, id: string) {
  if (!id) throw new TenantAccessError('Forbidden: that opportunity is outside this tenant.');
  const found = await db.opportunity.findFirst({
    where: { id, ...opportunityWhere(scope) },
    select: { id: true, tenantId: true },
  });
  if (!found) throw new TenantAccessError('Forbidden: that opportunity is outside this tenant.');
  return found;
}

export async function assertProductInScope(scope: TenantScope, id: string) {
  if (!id) throw new TenantAccessError('Forbidden: that product is outside this tenant.');
  const found = await db.product.findFirst({
    where: { id, ...productWhere(scope) },
    select: { id: true, opportunityId: true },
  });
  if (!found) throw new TenantAccessError('Forbidden: that product is outside this tenant.');
  return found;
}

/**
 * AgentLog has no tenant column and no relation to Opportunity. Its partition
 * is derived from the scoped opportunity/product ids (plus unattributed rows
 * for the legacy partition). Use for any usage/cost aggregation.
 */
export async function agentLogWhere(scope: TenantScope): Promise<Prisma.AgentLogWhereInput> {
  const [opportunities, products] = await Promise.all([
    db.opportunity.findMany({ where: opportunityWhere(scope), select: { id: true } }),
    db.product.findMany({ where: productWhere(scope), select: { id: true } }),
  ]);
  return {
    OR: [
      { opportunityId: { in: opportunities.map((o) => o.id) } },
      { opportunityId: null, productId: { in: products.map((p) => p.id) } },
      ...(scope.mode === 'legacy' ? [{ opportunityId: null, productId: null }] : []),
    ],
  };
}

// ============================================================================
// Phase 4.2F — Observatory & Commercial relation-derived filters
// ============================================================================

export function productEventWhere(scope: TenantScope): Prisma.ProductEventWhereInput {
  if (scope.mode === 'tenant') {
    return { product: { is: { opportunity: { is: { tenantId: T(scope) } } } } };
  }
  return { product: { OR: [{ opportunityId: null }, { opportunity: { is: { tenantId: null } } }] } };
}

export function growthExperimentWhere(scope: TenantScope): Prisma.GrowthExperimentWhereInput {
  if (scope.mode === 'tenant') return { opportunity: { is: { tenantId: T(scope) } } };
  return { opportunity: { is: { tenantId: null } } };
}

export function growthDecisionWhere(scope: TenantScope): Prisma.GrowthDecisionWhereInput {
  if (scope.mode === 'tenant') return { opportunity: { is: { tenantId: T(scope) } } };
  return { opportunity: { is: { tenantId: null } } };
}

export function learningEntryWhere(scope: TenantScope): Prisma.LearningEntryWhereInput {
  if (scope.mode === 'tenant') return { opportunity: { is: { tenantId: T(scope) } } };
  return { OR: [{ opportunityId: null }, { opportunity: { is: { tenantId: null } } }] };
}

export function proposalWhere(scope: TenantScope): Prisma.ProposalWhereInput {
  if (scope.mode === 'tenant') {
    return { offer: { is: offerWhere(scope) } };
  }
  return {
    AND: [
      { offer: { is: offerWhere(scope) } },
    ],
  };
}

export function serviceEngagementWhere(scope: TenantScope): Prisma.ServiceEngagementWhereInput {
  if (scope.mode === 'tenant') {
    return {
      OR: [
        { offer: { is: offerWhere(scope) } },
        { proposal: { is: proposalWhere(scope) } },
      ],
    };
  }
  return {
    AND: [
      { OR: [{ opportunityId: null }] },
      { OR: [{ offerId: null }, { offer: { is: offerWhere(scope) } }] },
      { OR: [{ proposalId: null }, { proposal: { is: proposalWhere(scope) } }] },
    ],
  };
}

export function prospectWhere(scope: TenantScope): Prisma.ProspectWhereInput {
  if (scope.mode === 'tenant') {
    return {
      OR: [
        { proposals: { some: proposalWhere(scope) } },
        { engagements: { some: serviceEngagementWhere(scope) } },
      ],
    };
  }
  // Legacy/global admin sees all prospects (leads are not tenant-owned).
  return {};
}

export function milestoneWhere(scope: TenantScope): Prisma.MilestoneWhereInput {
  return { engagement: { is: serviceEngagementWhere(scope) } };
}

export function deliverableWhere(scope: TenantScope): Prisma.DeliverableWhereInput {
  return { engagement: { is: serviceEngagementWhere(scope) } };
}

export function serviceIssueWhere(scope: TenantScope): Prisma.ServiceIssueWhereInput {
  return { engagement: { is: serviceEngagementWhere(scope) } };
}

export function engagementCostWhere(scope: TenantScope): Prisma.EngagementCostWhereInput {
  return { engagement: { is: serviceEngagementWhere(scope) } };
}

export function paymentEventWhere(scope: TenantScope): Prisma.PaymentEventWhereInput {
  return { engagement: { is: serviceEngagementWhere(scope) } };
}

export function outreachSendWhere(scope: TenantScope): Prisma.OutreachSendWhereInput {
  return { engagement: { is: serviceEngagementWhere(scope) } };
}

export function manualPaymentVerificationWhere(scope: TenantScope): Prisma.ManualPaymentVerificationWhereInput {
  return { engagement: { is: serviceEngagementWhere(scope) } };
}

export function conversationWhere(scope: TenantScope): Prisma.ConversationWhereInput {
  if (scope.mode === 'tenant') return { prospect: { is: prospectWhere(scope) } };
  return {};
}

export function messageWhere(scope: TenantScope): Prisma.MessageWhereInput {
  if (scope.mode === 'tenant') return { conversation: { is: conversationWhere(scope) } };
  return {};
}

export function opportunityHandoffWhere(scope: TenantScope): Prisma.OpportunityHandoffWhereInput {
  if (scope.mode === 'tenant') {
    return { tenantId: T(scope) };
  }
  return { tenantId: null };
}

export function humanReviewWhere(scope: TenantScope): Prisma.HumanReviewWhereInput {
  if (scope.mode === 'tenant') {
    return { tenantId: T(scope) };
  }
  return { tenantId: null };
}
