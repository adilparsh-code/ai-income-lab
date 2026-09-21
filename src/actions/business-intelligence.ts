'use server';

// Business Intelligence dashboard action.
// Computes the deterministic profitability summary from real DB records via
// the shared business layer. LIVE data = real revenue records; MOCKED/PLANNED
// = sample-labelled opportunities only. Nothing is fabricated.

import { db } from '@/lib/db';
import {
  buildBusinessIntelligence,
  type BusinessIntelligenceResult,
} from '@/lib/business/profitability';
import { resolveRevenueHealth } from '@/lib/business/profitability';

export interface BusinessIntelligenceSummary {
  hasRevenueData: boolean;
  overall: BusinessIntelligenceResult['overall'];
  kpis: BusinessIntelligenceResult['kpis'];
  topEntities: { label: string; contributionProfit: number; netRevenue: number }[];
  warnings: string[];
  missingData: string[];
  nextActions: BusinessIntelligenceResult['nextActions'];
  dataQuality: BusinessIntelligenceResult['dataQuality'];
  /** LIVE when real revenue records exist; MOCKED/PLANNED otherwise. */
  dataMode: 'LIVE' | 'MOCKED/PLANNED';
  /** Sample-labelled opportunities in scope (surfaced, never hidden). */
  sampleOpportunityCount: number;
  revenueHealth: 'NO_DATA' | 'NON_POSITIVE_NET' | 'UNPROFITABLE' | 'PROFITABLE';
  error: string | null;
}

export async function getBusinessIntelligenceSummary(): Promise<BusinessIntelligenceSummary> {
  try {
    const [opportunities, products, experiments, revenues] = await Promise.all([
      db.opportunity.findMany(),
      db.product.findMany(),
      db.experiment.findMany(),
      db.revenue.findMany(),
    ]);

    const bi = buildBusinessIntelligence({
      opportunities: opportunities.map((o) => ({
        id: o.id,
        title: o.title,
        estimatedStartupCost: o.estimatedStartupCost,
      })),
      products: products.map((p) => ({ id: p.id, name: p.name, opportunityId: p.opportunityId })),
      experiments: experiments.map((e) => ({
        id: e.id,
        hypothesis: e.hypothesis,
        budget: e.budget,
        revenue: e.revenue,
        profit: e.profit,
        visitors: e.visitors,
        sales: e.sales,
      })),
      revenues,
    });

    const topEntities = [...bi.perProduct, ...bi.perOpportunity]
      .sort((a, b) => b.metrics.contributionProfit - a.metrics.contributionProfit)
      .slice(0, 3)
      .map((entity) => ({
        label: entity.label,
        contributionProfit: entity.metrics.contributionProfit,
        netRevenue: entity.metrics.netRevenue,
      }));

    return {
      hasRevenueData: bi.overall.recordCount > 0,
      overall: bi.overall,
      kpis: bi.kpis,
      topEntities,
      warnings: bi.warnings,
      missingData: bi.missingData,
      nextActions: bi.nextActions,
      dataQuality: bi.dataQuality,
      dataMode: bi.overall.recordCount > 0 ? 'LIVE' : 'MOCKED/PLANNED',
      sampleOpportunityCount: opportunities.filter((o) => o.confidenceLevel === 'SAMPLE_DATA').length,
      revenueHealth: resolveRevenueHealth(
        bi.overall.netRevenue,
        bi.overall.contributionProfit,
        bi.overall.recordCount,
      ),
      error: null,
    };
  } catch (dbError) {
    console.error('Business Intelligence summary failed:', dbError);
    return {
      hasRevenueData: false,
      overall: {
        grossRevenue: 0,
        refunds: 0,
        netRevenue: 0,
        platformFees: 0,
        paymentFees: 0,
        variableCosts: 0,
        contributionProfit: 0,
        contributionMarginPercent: null,
        roiPercent: null,
        breakEvenRevenue: null,
        recordCount: 0,
        excludedRecordCount: 0,
        refundsDerived: false,
      },
      kpis: [],
      topEntities: [],
      warnings: [],
      missingData: ['Business Intelligence summary could not be loaded.'],
      nextActions: [],
      dataQuality: {
        revenueRecords: 0,
        excludedRecords: 0,
        opportunitiesWithRevenue: 0,
        productsWithRevenue: 0,
        experimentsWithSpendOrRevenue: 0,
      },
      dataMode: 'MOCKED/PLANNED',
      sampleOpportunityCount: 0,
      revenueHealth: 'NO_DATA',
      error: 'Could not load business intelligence data. Please try again.',
    };
  }
}
