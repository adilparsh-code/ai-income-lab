// Resolves the exact subject an approval will be bound to, server-side, from
// the database. The caller never supplies (or influences) the scope hash.
import { db } from '@/lib/db';
import { getOfferById } from '@/lib/commercial/offer-service';
import {
  APPROVAL_ACTIONS,
  approvalScopeHash,
  offerApprovalScope,
  productApprovalScope,
  type ApprovalAction,
} from './approvals-core';

export type ScopeResolution = { ok: true; scopeHash: string } | { ok: false; error: string };

export async function resolveApprovalScope(action: ApprovalAction, subjectId: string): Promise<ScopeResolution> {
  switch (APPROVAL_ACTIONS[action]) {
    case 'offer': {
      const offer = await getOfferById(subjectId);
      if (!offer) return { ok: false, error: 'Offer not found.' };
      return {
        ok: true,
        scopeHash: approvalScopeHash(offerApprovalScope({
          id: offer.id, title: offer.title, price: offer.price, currency: offer.currency,
          status: offer.status, halalStatus: offer.halalStatus, productId: offer.productId ?? null,
        })),
      };
    }
    case 'product': {
      const product = await db.product.findUnique({ where: { id: subjectId }, select: { id: true, status: true } });
      if (!product) return { ok: false, error: 'Product not found.' };
      return { ok: true, scopeHash: approvalScopeHash(productApprovalScope(product)) };
    }
    case 'deployment': {
      const deployment = await db.productDeployment.findFirst({
        where: { deploymentId: subjectId }, select: { deploymentId: true },
      });
      if (!deployment) return { ok: false, error: 'Deployment not found.' };
      return { ok: true, scopeHash: approvalScopeHash({ deploymentId: subjectId }) };
    }
  }
}
