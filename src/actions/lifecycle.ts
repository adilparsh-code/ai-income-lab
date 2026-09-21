'use server';

import { db } from '@/lib/db';
import {
  summarizePortfolio,
  type PortfolioLifecycleSummary,
} from '@/lib/ruflo/lifecycle';

/**
 * Business-loop lifecycle overview for the dashboard (Phase 4.2.4).
 * Computes stage positions ONLY from real records (opportunities, experiments,
 * products, revenues, agent logs). Nothing here is sampled, mocked, or inferred
 * about the outside world; provenance stays inside the lifecycle view.
 */
export async function getLifecycleOverview(): Promise<PortfolioLifecycleSummary> {
  const [opportunities, experiments, products, revenues, agentLogs] = await Promise.all([
    db.opportunity.findMany(),
    db.experiment.findMany(),
    db.product.findMany(),
    db.revenue.findMany(),
    db.agentLog.findMany({
      where: { agentType: { in: ['research', 'validation'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

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
