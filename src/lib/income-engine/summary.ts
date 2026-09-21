// Phase 7 — Loop summary for the dashboard card. Deterministic counts over
// real records only; no fabrication.

import { db } from '@/lib/db';
import type { IncomeEngineSummary } from '@/components/dashboard/income-engine-card';

export async function getIncomeEngineSummary(): Promise<IncomeEngineSummary> {
  const opportunities = await db.opportunity.findMany({
    select: { id: true, status: true, halalStatus: true },
  });
  const [products, revenueOpportunities] = await Promise.all([
    db.product.findMany({ select: { status: true, opportunityId: true } }),
    db.revenue.groupBy({ by: ['opportunityId'] }),
  ]);

  const actionable = opportunities.filter(
    (o) => !['REJECTED', 'PAUSED'].includes(o.status) && o.halalStatus !== 'NOT_ALLOWED',
  );
  const blocked = opportunities.filter((o) => o.halalStatus === 'NOT_ALLOWED').length;
  const withRevenue = new Set(revenueOpportunities.map((r) => r.opportunityId).filter(Boolean));

  // Build-or-later: actionable opportunities with at least one positive
  // validation decision or a product (deterministic proxy computed from rows).
  const productsByOpp = new Set(products.map((p) => p.opportunityId).filter(Boolean));

  return {
    actionableOpportunities: actionable.length,
    opportunitiesAtBuildOrLater: actionable.filter((o) => productsByOpp.has(o.id) || withRevenue.has(o.id)).length,
    publishedProducts: products.filter((p) => ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status)).length,
    opportunitiesWithRevenue: actionable.filter((o) => withRevenue.has(o.id)).length,
    blockedOpportunities: blocked,
  };
}
