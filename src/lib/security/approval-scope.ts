// Resolves the exact subject an approval will be bound to, server-side, from
// the database. The caller never supplies (or influences) the scope hash.
//
// Phase 4.2D — the subject is also checked against the AUTHORIZED tenant, and
// the grant inherits that tenant. A product/offer/deployment outside the
// caller's tenant is reported as "not found", so an approval request cannot be
// used to discover another tenant's subjects.
import { db } from '@/lib/db';
import { getOfferById } from '@/lib/commercial/offer-service';
import {
  APPROVAL_ACTIONS,
  approvalScopeHash,
  offerApprovalScope,
  productApprovalScope,
  type ApprovalAction,
} from './approvals-core';

export type ScopeResolution =
  | { ok: true; scopeHash: string; tenantId: string | null }
  | { ok: false; error: string };

/** Owner tenant of a product (through its opportunity). */
async function productTenantId(productId: string): Promise<{ found: boolean; tenantId: string | null }> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, opportunity: { select: { tenantId: true } } },
  });
  if (!product) return { found: false, tenantId: null };
  return { found: true, tenantId: product.opportunity?.tenantId ?? null };
}

export async function resolveApprovalScope(
  action: ApprovalAction,
  subjectId: string,
  authorizedTenantId?: string | null,
): Promise<ScopeResolution> {
  switch (APPROVAL_ACTIONS[action]) {
    case 'offer': {
      const offer = await getOfferById(subjectId);
      if (!offer) return { ok: false, error: 'Offer not found.' };
      const owner = offer.productId ? await productTenantId(offer.productId) : { found: false, tenantId: null };
      if (!owner.found) return { ok: false, error: 'Offer not found.' };
      if (authorizedTenantId !== undefined && (owner.tenantId ?? null) !== (authorizedTenantId ?? null)) {
        return { ok: false, error: 'Offer not found.' };
      }
      return {
        ok: true,
        tenantId: owner.tenantId ?? null,
        scopeHash: approvalScopeHash(offerApprovalScope({
          id: offer.id, title: offer.title, price: offer.price, currency: offer.currency,
          status: offer.status, halalStatus: offer.halalStatus, productId: offer.productId ?? null,
        })),
      };
    }
    case 'product': {
      const product = await db.product.findUnique({
        where: { id: subjectId },
        select: { id: true, status: true, opportunity: { select: { tenantId: true } } },
      });
      if (!product) return { ok: false, error: 'Product not found.' };
      const tenantId = product.opportunity?.tenantId ?? null;
      if (authorizedTenantId !== undefined && tenantId !== (authorizedTenantId ?? null)) {
        return { ok: false, error: 'Product not found.' };
      }
      return { ok: true, tenantId, scopeHash: approvalScopeHash(productApprovalScope(product)) };
    }
    case 'deployment': {
      const deployment = await db.productDeployment.findFirst({
        where: { deploymentId: subjectId }, select: { deploymentId: true, productId: true },
      });
      if (!deployment) return { ok: false, error: 'Deployment not found.' };
      const owner = await productTenantId(deployment.productId);
      if (authorizedTenantId !== undefined && (owner.tenantId ?? null) !== (authorizedTenantId ?? null)) {
        return { ok: false, error: 'Deployment not found.' };
      }
      return {
        ok: true,
        tenantId: owner.tenantId ?? null,
        scopeHash: approvalScopeHash({ deploymentId: subjectId }),
      };
    }
  }
}
