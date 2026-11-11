// Plain (non-server-action) loaders. Callers MUST authorize first;
// the public entry points live in src/actions/* and call requireAdminAction().
import { db } from '@/lib/db';
import {
  summarizePortfolio,
  type PortfolioLifecycleSummary,
} from '@/lib/ruflo/lifecycle';
import type { TenantScope } from '@/lib/tenancy/scope';
import { currentScope } from '@/lib/tenancy/action-scope';
import {
  experimentWhere,
  opportunityWhere,
  productWhere,
  revenueWhere,
} from '@/lib/tenancy/relation-scope';

/**
 * Business-loop lifecycle overview for the dashboard (Phase 4.2.4).
 * Computes stage positions ONLY from real records (opportunities, experiments,
 * products, revenues, agent logs). Nothing here is sampled, mocked, or inferred
 * about the outside world; provenance stays inside the lifecycle view.
 */
export async function getLifecycleOverview(scopeInput?: TenantScope): Promise<PortfolioLifecycleSummary> {
  const scope = scopeInput ?? (await currentScope('tenant:read', 'loader:lifecycle'));
  const [opportunities, experiments, products, revenues] = await Promise.all([
    db.opportunity.findMany({ where: opportunityWhere(scope) }),
    db.experiment.findMany({ where: experimentWhere(scope) }),
    db.product.findMany({ where: productWhere(scope) }),
    db.revenue.findMany({ where: revenueWhere(scope), select: { id: true, opportunityId: true, productId: true } }),
  ]);
  // AgentLog has no tenant column; it is attributed through the scoped
  // opportunity/product ids so a tenant can never see another tenant's logs.
  const scopedOpportunityIds = opportunities.map((o) => o.id);
  const scopedProductIds = products.map((p) => p.id);
  const agentLogs = await db.agentLog.findMany({
    where: {
      agentType: { in: ['research', 'validation'] },
      OR: [
        { opportunityId: { in: scopedOpportunityIds } },
        { opportunityId: null, productId: { in: scopedProductIds } },
        ...(scope.mode === 'legacy' ? [{ opportunityId: null, productId: null }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const counts = {
    opportunities: opportunities.length,
    experiments: experiments.length,
    products: products.length,
    revenues: revenues.length,
  };

  const hasLogFor = (agentType: string, opportunityId: string | undefined): boolean => {
    if (!opportunityId) return false;
    return agentLogs.some(
      (l) => l.agentType === agentType && typeof l.input === 'string' && l.input.includes(opportunityId)
    );
  };

  const records = opportunities.map((o) => {
    const oppExperiments = experiments.filter((e) => e.opportunityId === o.id);
    const oppProducts = products.filter((p) => p.opportunityId === o.id);
    const oppRevenues = revenues.filter((r) => r.opportunityId === o.id);
    const linkedProductIds = new Set(oppProducts.map((p) => p.id));
    const oppProductRevenues = revenues.filter((r) => r.productId && linkedProductIds.has(r.productId));
    const revenueCount = new Set([...oppRevenues, ...oppProductRevenues].map((r) => r.id)).size;

    return {
      opportunity: {
        id: o.id,
        title: o.title,
        status: o.status,
        halalStatus: o.halalStatus,
        overallScore: o.overallScore,
      },
      experiments: oppExperiments.length,
      products: oppProducts.length,
      revenues: revenueCount,
      completedExperimentDecisions: oppExperiments.filter((e) =>
        ['SCALE', 'KILL', 'PAUSE'].includes(e.decision || '')
      ).length,
      positiveExperimentDecisions: oppExperiments.filter((e) => e.decision === 'SCALE').length,
      publishedProducts: oppProducts.filter((p) =>
        ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status)
      ).length,
      hasResearchLog: hasLogFor('research', o.id),
      hasValidationLog: hasLogFor('validation', o.id),
    };
  });

  return summarizePortfolio(records, counts);
}
