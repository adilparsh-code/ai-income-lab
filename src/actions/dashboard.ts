'use server';

import { db } from '@/lib/db';

export interface DashboardStats {
  totalOpportunities: number;
  validatedOpportunities: number;
  activeExperiments: number;
  productsBuildingCount: number;
  publishedProducts: number;
  totalRevenue: number;
  revenueThisMonth: number;
  conversionRate: number;
  topOpportunity: { id: string; title: string; score: number } | null;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [opportunities, products, experiments, revenues] = await Promise.all([
    db.opportunity.findMany(),
    db.product.findMany(),
    db.experiment.findMany(),
    db.revenue.findMany(),
  ]);
  
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const totalRevenue = revenues.reduce((sum, r) => sum + r.netRevenue, 0);
  const revenueThisMonth = revenues
    .filter(r => r.date >= startOfMonth)
    .reduce((sum, r) => sum + r.netRevenue, 0);
  
  const totalVisitors = experiments.reduce((sum, e) => sum + e.visitors, 0);
  const totalSales = experiments.reduce((sum, e) => sum + e.sales, 0);
  const conversionRate = totalVisitors > 0 ? (totalSales / totalVisitors) * 100 : 0;
  
  const topOpportunity = opportunities.length > 0
    ? opportunities.sort((a, b) => b.overallScore - a.overallScore)[0]
    : null;
  
  return {
    totalOpportunities: opportunities.length,
    validatedOpportunities: opportunities.filter(o => 
      ['VALIDATED', 'BUILDING', 'PUBLISHED', 'EARNING', 'SCALING'].includes(o.status)
    ).length,
    activeExperiments: experiments.filter(e => !e.decision || e.decision === 'ITERATE').length,
    productsBuildingCount: products.filter(p => 
      ['IDEA', 'DRAFTING', 'DESIGNING', 'QA', 'READY'].includes(p.status)
    ).length,
    publishedProducts: products.filter(p => 
      ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status)
    ).length,
    totalRevenue,
    revenueThisMonth,
    conversionRate,
    topOpportunity: topOpportunity
      ? { id: topOpportunity.id, title: topOpportunity.title, score: topOpportunity.overallScore }
      : null,
  };
}

export interface NextBestAction {
  opportunityId: string;
  opportunityTitle: string;
  score: number;
  action: string;
  reason: string;
}

export async function getNextBestAction(): Promise<NextBestAction | null> {
  // Find the highest-scoring opportunity that has a next action and isn't rejected/paused
  const opportunity = await db.opportunity.findFirst({
    where: {
      status: { notIn: ['REJECTED', 'PAUSED', 'SCALING'] },
      halalStatus: { not: 'NOT_ALLOWED' },
      overallScore: { gt: 0 },
    },
    orderBy: { overallScore: 'desc' },
  });
  
  if (!opportunity) return null;
  
  // Generate reason based on opportunity data
  const strengths: string[] = [];
  if (opportunity.demandScore >= 75) strengths.push('High demand score');
  if (opportunity.commercialIntentScore >= 75) strengths.push('Strong commercial intent');
  if (opportunity.automationScore >= 75) strengths.push('High automation potential');
  if (opportunity.competitionScore >= 70) strengths.push('Favorable competition landscape');
  if (opportunity.monetizationScore >= 75) strengths.push('Strong monetization path');
  // Use estimatedStartupCost for cost assessment
  if (opportunity.estimatedStartupCost <= 200) strengths.push('Low startup cost');
  
  const reason = strengths.length > 0
    ? strengths.join(' + ') + '.'
    : `Overall score of ${opportunity.overallScore}/100.`;
  
  return {
    opportunityId: opportunity.id,
    opportunityTitle: opportunity.title.replace('[SAMPLE] ', ''),
    score: opportunity.overallScore,
    action: opportunity.nextAction || `Evaluate ${opportunity.title}`,
    reason,
  };
}

export interface RevenueChartData {
  month: string;
  revenue: number;
}

export async function getRevenueChartData(): Promise<RevenueChartData[]> {
  const revenues = await db.revenue.findMany({
    orderBy: { date: 'asc' },
  });
  
  // Group by month
  const monthlyRevenue = new Map<string, number>();
  
  // Generate last 6 months even if no data
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    monthlyRevenue.set(key, 0);
  }
  
  for (const rev of revenues) {
    const key = new Date(rev.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    monthlyRevenue.set(key, (monthlyRevenue.get(key) || 0) + rev.netRevenue);
  }
  
  return Array.from(monthlyRevenue.entries()).map(([month, revenue]) => ({
    month,
    revenue,
  }));
}
