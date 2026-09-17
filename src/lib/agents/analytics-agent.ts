import { db } from '@/lib/db';
import { BaseAgent } from './base-agent';
import { buildBusinessIntelligence, type BusinessIntelligenceResult } from '@/lib/business/profitability';
import {
  AgentRequest, AgentResult, AgentStatus, EvidenceType,
  AnalyticsRequest, AnalyticsResult, AnalyticsScope,
  KpiMetric, TrendItem, AnomalyItem, NextBestActionItem,
  ExperimentInsight, ProductInsight, RevenueInsight, OpportunityInsight,
  DataAvailability, EvidenceItem,
} from './types';
import { v4 as uuidv4 } from 'uuid';


const VALID_SCOPES: AnalyticsScope[] = [
  'OVERVIEW', 'EXPERIMENTS', 'PRODUCTS', 'REVENUE', 'OPPORTUNITIES', 'FULL_BUSINESS',
];

export class AnalyticsAgent extends BaseAgent {
  constructor() {
    super({
      id: 'analytics-agent',
      type: 'analytics',
      name: 'Analytics Agent',
      description: 'Analyzes real database data for experiments, products, revenue, and opportunities. Identifies trends, anomalies, and generates next-best-action recommendations.',
      purpose: 'Provide evidence-based business intelligence by analyzing actual stored data, calculating deterministic KPIs, and generating actionable insights with clear separation of verified facts from AI inferences.',
      currentCapability: 'Live database analysis implemented. Computes deterministic KPIs from real Prisma data with halal safety checks, evidence provenance, and AI-inference recommendations. All metrics are calculated from actual stored records.',
      status: 'MOCKED',
      evidencePolicy: 'Database metrics are classified as VERIFIED_DATA. Conclusions, interpretations, trends, anomalies, and recommendations are classified as AI_INFERENCE. User-supplied inputs are USER_ENTERED.',
      safeExecutionState: true,
      icon: 'BarChart3',
    });
  }

  private validateAnalyticsRequest(input: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const req = input as Partial<AnalyticsRequest>;

    if (!req.analysisObjective || typeof req.analysisObjective !== 'string' || req.analysisObjective.trim().length === 0) {
      errors.push('Valid analysis objective is required');
    }

    if (!req.analysisScope || !VALID_SCOPES.includes(req.analysisScope as AnalyticsScope)) {
      errors.push('analysisScope must be one of: ' + VALID_SCOPES.join(', '));
    }

    if (req.opportunityId && typeof req.opportunityId !== 'string') {
      errors.push('opportunityId must be a string if provided');
    }
    if (req.productId && typeof req.productId !== 'string') {
      errors.push('productId must be a string if provided');
    }
    if (req.experimentId && typeof req.experimentId !== 'string') {
      errors.push('experimentId must be a string if provided');
    }
    if (req.startDate && isNaN(Date.parse(req.startDate))) {
      errors.push('startDate must be a valid date string if provided');
    }
    if (req.endDate && isNaN(Date.parse(req.endDate))) {
      errors.push('endDate must be a valid date string if provided');
    }
    if (req.startDate && req.endDate && new Date(req.startDate) > new Date(req.endDate)) {
      errors.push('startDate must not be after endDate (reversed date range)');
    }

    return { valid: errors.length === 0, errors };
  }

  private safeDivide(numerator: number, denominator: number): number | null {
    if (denominator === 0 || !isFinite(numerator) || !isFinite(denominator)) return null;
    const result = numerator / denominator;
    return isFinite(result) ? Math.round(result * 100) / 100 : null;
  }

  private filterByDateRange<T extends { createdAt: Date }>(items: T[], start?: Date, end?: Date): T[] {
    if (!start && !end) return items;
    return items.filter(item => {
      const d = new Date(item.createdAt);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const startTime = Date.now();
    const analyticsRequest = request.input as unknown as AnalyticsRequest;

    // 1. Input Validation
    const validation = this.validateAnalyticsRequest(analyticsRequest);
    if (!validation.valid) {
      const errorMessage = 'Invalid analytics request: ' + validation.errors.join(', ');
      const result: AgentResult = {
        success: false, output: {},
        reasoning: errorMessage,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 2. Date Range Parsing
    const startDate = analyticsRequest.startDate ? new Date(analyticsRequest.startDate) : undefined;
    const endDate = analyticsRequest.endDate ? new Date(analyticsRequest.endDate) : undefined;
    const periodLabel = startDate && endDate
      ? startDate.toISOString().slice(0, 10) + ' to ' + endDate.toISOString().slice(0, 10)
      : startDate
        ? 'From ' + startDate.toISOString().slice(0, 10)
        : endDate
          ? 'Until ' + endDate.toISOString().slice(0, 10)
          : 'All time';

    // 3. Load Data from Database
    let opportunities: Awaited<ReturnType<typeof db.opportunity.findMany>> = [];
    let experiments: Awaited<ReturnType<typeof db.experiment.findMany>> = [];
    let products: Awaited<ReturnType<typeof db.product.findMany>> = [];
    let revenues: Awaited<ReturnType<typeof db.revenue.findMany>> = [];
    let scopedEntity: { halalStatus: string; title?: string; name?: string; id: string; type: string } | null = null;
    let notAllowed = false;
    let humanReviewRequired = false;

    try {
      const scope = analyticsRequest.analysisScope;
      

      const loadsAll = ['OVERVIEW', 'FULL_BUSINESS'].includes(scope);
      const loadsOpps = loadsAll || ['OPPORTUNITIES'].includes(scope);
      const loadsExps = loadsAll || ['EXPERIMENTS'].includes(scope);
      const loadsProds = loadsAll || ['PRODUCTS'].includes(scope);
      const loadsRevs = loadsAll || ['REVENUE'].includes(scope);

      const promises: Promise<unknown>[] = [];
      if (loadsOpps) promises.push(db.opportunity.findMany());
      if (loadsExps) promises.push(db.experiment.findMany());
      if (loadsProds) promises.push(db.product.findMany());
      if (loadsRevs) promises.push(db.revenue.findMany());

      const results = await Promise.all(promises);
      let idx = 0;
      if (loadsOpps) opportunities = results[idx++] as typeof opportunities;
      if (loadsExps) experiments = results[idx++] as typeof experiments;
      if (loadsProds) products = results[idx++] as typeof products;
      if (loadsRevs) revenues = results[idx++] as typeof revenues;
    } catch (dbError) {
        console.error('Database error details:', dbError);
      const errorMessage = 'Database error while loading analytics data';
      const result: AgentResult = {
        success: false, output: {},
        reasoning: errorMessage,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 4. Scoped Entity Loading (if specific IDs provided)
    if (analyticsRequest.opportunityId) {
      const opp = opportunities.find(o => o.id === analyticsRequest.opportunityId);
      if (!opp) {
        const errorMessage = 'Opportunity with ID "' + analyticsRequest.opportunityId + '" not found';
        const result: AgentResult = { success: false, output: {}, reasoning: errorMessage, evidenceType: 'AI_INFERENCE' as EvidenceType, error: errorMessage, executionTime: Date.now() - startTime };
        await this.logExecution(request.action, request.input, result);
        return result;
      }
      scopedEntity = { halalStatus: opp.halalStatus, title: opp.title, id: opp.id, type: 'opportunity' };
      if (opp.halalStatus === 'NOT_ALLOWED') notAllowed = true;
      if (opp.halalStatus === 'REVIEW_REQUIRED') humanReviewRequired = true;
      opportunities = [opp];
      experiments = experiments.filter(e => e.opportunityId === opp.id);
      products = products.filter(p => p.opportunityId === opp.id);
      revenues = revenues.filter(r => r.opportunityId === opp.id);
    }

    if (analyticsRequest.productId) {
      const prod = products.find(p => p.id === analyticsRequest.productId);
      if (!prod) {
        const errorMessage = 'Product with ID "' + analyticsRequest.productId + '" not found';
        const result: AgentResult = { success: false, output: {}, reasoning: errorMessage, evidenceType: 'AI_INFERENCE' as EvidenceType, error: errorMessage, executionTime: Date.now() - startTime };
        await this.logExecution(request.action, request.input, result);
        return result;
      }
      scopedEntity = { halalStatus: 'HALAL', name: prod.name, id: prod.id, type: 'product' };
      products = [prod];
      revenues = revenues.filter(r => r.productId === prod.id);
    }

    if (analyticsRequest.experimentId) {
      const exp = experiments.find(e => e.id === analyticsRequest.experimentId);
      if (!exp) {
        const errorMessage = 'Experiment with ID "' + analyticsRequest.experimentId + '" not found';
        const result: AgentResult = { success: false, output: {}, reasoning: errorMessage, evidenceType: 'AI_INFERENCE' as EvidenceType, error: errorMessage, executionTime: Date.now() - startTime };
        await this.logExecution(request.action, request.input, result);
        return result;
      }
      scopedEntity = { halalStatus: 'HALAL', title: exp.hypothesis, id: exp.id, type: 'experiment' };
      experiments = [exp];
    }

    // 5. Apply Date Filtering
    if (startDate || endDate) {
      revenues = revenues.filter(r => {
        const d = new Date(r.date);
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      });
      experiments = experiments.filter(e => {
        const d = e.startDate ? new Date(e.startDate) : new Date(e.createdAt);
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      });
      products = this.filterByDateRange(products, startDate, endDate);
      opportunities = this.filterByDateRange(opportunities, startDate, endDate);
    }

    // 6. Data Availability
    const insufficientDataWarnings: string[] = [];
    if (opportunities.length === 0) insufficientDataWarnings.push('Insufficient data: no opportunities found for analysis.');
    if (experiments.length === 0) insufficientDataWarnings.push('Insufficient data: no experiments found for analysis.');
    if (products.length === 0) insufficientDataWarnings.push('Insufficient data: no products found for analysis.');
    if (revenues.length === 0) insufficientDataWarnings.push('Insufficient data: no revenue records found for analysis.');

    const dataSummary: DataAvailability = {
      opportunities: opportunities.length,
      experiments: experiments.length,
      products: products.length,
      revenues: revenues.length,
      insufficientDataWarnings,
    };

    // 7. KPI Calculations (VERIFIED_DATA)
    const kpiMetrics: KpiMetric[] = [];
    let kpiIndex = 0;

    // Opportunity KPIs
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Total Opportunities', value: String(opportunities.length), evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const oppStatuses = new Map<string, number>();
    for (const o of opportunities) { oppStatuses.set(o.status, (oppStatuses.get(o.status) || 0) + 1); }
    const oppStatusSummary = Array.from(oppStatuses.entries()).map(([k, v]) => k + ': ' + v).join(', ');
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Opportunity Status Distribution', value: oppStatusSummary || 'None', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const oppHalal = new Map<string, number>();
    for (const o of opportunities) { oppHalal.set(o.halalStatus, (oppHalal.get(o.halalStatus) || 0) + 1); }
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Halal Status Distribution', value: Array.from(oppHalal.entries()).map(([k, v]) => k + ': ' + v).join(', ') || 'None', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const avgOppScore = opportunities.length > 0 ? Math.round(opportunities.reduce((s, o) => s + o.overallScore, 0) / opportunities.length) : 0;
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Average Opportunity Score', value: opportunities.length > 0 ? avgOppScore + '/100' : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });

    // Experiment KPIs
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Total Experiments', value: String(experiments.length), evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const activeExps = experiments.filter(e => !e.decision || e.decision === 'ITERATE').length;
    const completedExps = experiments.filter(e => ['SCALE', 'KILL', 'PAUSE'].includes(e.decision || '')).length;
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Active / Completed Experiments', value: experiments.length > 0 ? activeExps + ' / ' + completedExps : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const totalVisitors = experiments.reduce((s, e) => s + e.visitors, 0);
    const totalSales = experiments.reduce((s, e) => s + e.sales, 0);
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Total Visitors (experiments)', value: experiments.length > 0 ? String(totalVisitors) : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Total Sales (experiments)', value: experiments.length > 0 ? String(totalSales) : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const expConvRate = this.safeDivide(totalSales, totalVisitors);
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Experiment Conversion Rate', value: expConvRate !== null ? (expConvRate * 100).toFixed(2) + '%' : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const expCompletionRate = this.safeDivide(completedExps, experiments.length);
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Experiment Completion Rate', value: expCompletionRate !== null ? (expCompletionRate * 100).toFixed(1) + '%' : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });

    // Product KPIs
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Total Products', value: String(products.length), evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const prodStatuses = new Map<string, number>();
    for (const p of products) { prodStatuses.set(p.status, (prodStatuses.get(p.status) || 0) + 1); }
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Product Status Distribution', value: Array.from(prodStatuses.entries()).map(([k, v]) => k + ': ' + v).join(', ') || 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });
    const linkedProds = products.filter(p => p.opportunityId).length;
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Products Linked to Opportunities', value: products.length > 0 ? linkedProds + ' / ' + products.length : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true });

    // Revenue KPIs
    const totalGross = revenues.reduce((s, r) => s + r.grossRevenue, 0);
    const totalFees = revenues.reduce((s, r) => s + r.fees, 0);
    const totalNet = revenues.reduce((s, r) => s + r.netRevenue, 0);
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Gross Revenue', value: revenues.length > 0 ? '$' + totalGross.toFixed(2) : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true, unit: 'USD' });
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Total Fees', value: revenues.length > 0 ? '$' + totalFees.toFixed(2) : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true, unit: 'USD' });
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Net Revenue', value: revenues.length > 0 ? '$' + totalNet.toFixed(2) : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true, unit: 'USD' });
    const avgRevPerEntry = this.safeDivide(totalNet, revenues.length);
    kpiMetrics.push({ id: 'kpi-' + kpiIndex++, label: 'Average Net Revenue per Entry', value: avgRevPerEntry !== null ? '$' + avgRevPerEntry.toFixed(2) : 'Insufficient data', evidenceType: 'VERIFIED_DATA' as EvidenceType, isCalculated: true, unit: 'USD' });

    // 8. Experiment Insights (AI_INFERENCE)
    const experimentInsights: ExperimentInsight[] = [];
    if (experiments.length > 0) {
      const bestExp = experiments.reduce((best, e) => (e.revenue > best.revenue ? e : best), experiments[0]);
      if (bestExp.revenue > 0) {
        experimentInsights.push({ id: uuidv4(), label: 'Highest Revenue Experiment', description: '"' + bestExp.hypothesis + '" generated $' + bestExp.revenue.toFixed(2) + ' revenue. This is the top-performing experiment by revenue among ' + experiments.length + ' experiment(s).', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
      const zeroRevenueExps = experiments.filter(e => e.revenue === 0 && e.visitors === 0);
      if (zeroRevenueExps.length > 0) {
        experimentInsights.push({ id: uuidv4(), label: 'Experiments Needing Attention', description: zeroRevenueExps.length + ' experiment(s) have zero visitors and zero revenue. Consider investigating or collecting data for these experiments.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
      const missingMetrics = experiments.filter(e => !e.conversionRate && e.visitors === 0);
      if (missingMetrics.length > 0) {
        experimentInsights.push({ id: uuidv4(), label: 'Missing Experiment Metrics', description: missingMetrics.length + ' experiment(s) lack conversion rate and visitor data. Recommend measuring traffic and conversion for accurate analysis.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
    } else {
      experimentInsights.push({ id: uuidv4(), label: 'No Experiment Data', description: 'Insufficient data: no experiments available for analysis. Run validation tests to generate experiment data.', evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    // 9. Product Insights (AI_INFERENCE)
    const productInsights: ProductInsight[] = [];
    if (products.length > 0) {
      const publishedProds = products.filter(p => ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status));
      productInsights.push({ id: uuidv4(), label: 'Published Products', description: publishedProds.length + ' of ' + products.length + ' product(s) are in earning status.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      const prodsWithCost = products.filter(p => p.cost > 0);
      if (prodsWithCost.length === 0) {
        productInsights.push({ id: uuidv4(), label: 'Cost Data Unavailable', description: 'No product cost data found. Profitability cannot be determined without cost information.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      } else {
        const totalProdRevenue = products.reduce((s, p) => s + p.revenue, 0);
        const totalProdCost = products.reduce((s, p) => s + p.cost, 0);
        productInsights.push({ id: uuidv4(), label: 'Product Financials', description: 'Total product revenue: $' + totalProdRevenue.toFixed(2) + '. Total product cost: $' + totalProdCost.toFixed(2) + '. Note: Revenue is not the same as profit.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
    } else {
      productInsights.push({ id: uuidv4(), label: 'No Product Data', description: 'Insufficient data: no products available for analysis.', evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    // 10. Revenue Insights (AI_INFERENCE)
    const revenueInsights: RevenueInsight[] = [];
    if (revenues.length > 0) {
      const revByProduct = new Map<string, number>();
      for (const r of revenues) { if (r.productId) revByProduct.set(r.productId, (revByProduct.get(r.productId) || 0) + r.netRevenue); }
      if (revByProduct.size > 0) {
        const topProd = Array.from(revByProduct.entries()).sort((a, b) => b[1] - a[1])[0];
        const topProdName = products.find(p => p.id === topProd[0])?.name || 'Product ' + topProd[0].slice(0, 8);
        revenueInsights.push({ id: uuidv4(), label: 'Top Revenue Product', description: '"' + topProdName + '" generated the highest net revenue at $' + topProd[1].toFixed(2) + '.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
      const feeRate = this.safeDivide(totalFees, totalGross);
      if (feeRate !== null && totalGross > 0) {
        revenueInsights.push({ id: uuidv4(), label: 'Fee Rate', description: 'Fees represent ' + (feeRate * 100).toFixed(1) + '% of gross revenue ($' + totalFees.toFixed(2) + ' of $' + totalGross.toFixed(2) + ').', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
    } else {
      revenueInsights.push({ id: uuidv4(), label: 'No Revenue Data', description: 'Insufficient data: no revenue records found. Revenue analysis requires recorded revenue entries.', evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    // 11. Opportunity Insights (AI_INFERENCE)
    const opportunityInsights: OpportunityInsight[] = [];
    if (opportunities.length > 0) {
      const topOpp = opportunities.reduce((best, o) => (o.overallScore > best.overallScore ? o : best), opportunities[0]);
      opportunityInsights.push({ id: uuidv4(), label: 'Top Scoring Opportunity', description: '"' + topOpp.title + '" has the highest score at ' + topOpp.overallScore + '/100 with status ' + topOpp.status + '.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      const notAllowedOpps = opportunities.filter(o => o.halalStatus === 'NOT_ALLOWED');
      if (notAllowedOpps.length > 0) {
        opportunityInsights.push({ id: uuidv4(), label: 'Blocked Opportunities', description: notAllowedOpps.length + ' opportunity(ies) are NOT_ALLOWED and cannot receive execution recommendations.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
      const reviewOpps = opportunities.filter(o => o.halalStatus === 'REVIEW_REQUIRED');
      if (reviewOpps.length > 0) {
        opportunityInsights.push({ id: uuidv4(), label: 'Opportunities Needing Review', description: reviewOpps.length + ' opportunity(ies) require human review before proceeding.', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
    } else {
      opportunityInsights.push({ id: uuidv4(), label: 'No Opportunity Data', description: 'Insufficient data: no opportunities available for analysis.', evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    // 12. Trends (only with 2+ data points)
    const trends: TrendItem[] = [];
    if (revenues.length >= 2) {
      const monthlyRev = new Map<string, number>();
      for (const r of revenues) {
        const key = new Date(r.date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        monthlyRev.set(key, (monthlyRev.get(key) || 0) + r.netRevenue);
      }
      const months = Array.from(monthlyRev.entries());
      if (months.length >= 2) {
        const first = months[0][1];
        const last = months[months.length - 1][1];
        const direction = last > first ? 'INCREASING' : last < first ? 'DECREASING' : 'STABLE';
        trends.push({ id: uuidv4(), label: 'Revenue Trend', direction, description: 'Monthly net revenue went from $' + first.toFixed(2) + ' to $' + last.toFixed(2) + ' across ' + months.length + ' months.', evidenceType: 'AI_INFERENCE' as EvidenceType, dataPoints: months.length });
      }
    }
    if (experiments.length >= 2) {
      const withDecision = experiments.filter(e => e.decision).length;
      const completionRate = this.safeDivide(withDecision, experiments.length);
      if (completionRate !== null) {
        trends.push({ id: uuidv4(), label: 'Experiment Completion Trend', direction: completionRate > 0.5 ? 'INCREASING' : 'STABLE', description: (completionRate * 100).toFixed(0) + '% of experiments have a recorded decision (SCALE/ITERATE/KILL/PAUSE).', evidenceType: 'AI_INFERENCE' as EvidenceType, dataPoints: experiments.length });
      }
    }
    if (trends.length === 0) {
      trends.push({ id: uuidv4(), label: 'Trend Analysis', direction: 'STABLE', description: 'Insufficient data for trend analysis. Trends require at least 2 comparable data points.', evidenceType: 'AI_INFERENCE' as EvidenceType, dataPoints: 0 });
    }

    // 13. Anomalies (deterministic, only with enough data)
    const anomalies: AnomalyItem[] = [];
    if (revenues.length >= 2) {
      const avgRev = totalNet / revenues.length;
      for (const r of revenues) {
        if (avgRev > 0 && r.netRevenue > avgRev * 3) {
          anomalies.push({ id: uuidv4(), severity: 'MEDIUM', description: 'Revenue entry on ' + new Date(r.date).toISOString().slice(0, 10) + ' ($' + r.netRevenue.toFixed(2) + ') is more than 3x the average ($' + avgRev.toFixed(2) + ').', evidenceType: 'AI_INFERENCE' as EvidenceType });
        }
        if (r.netRevenue === 0 && totalNet > 0) {
          anomalies.push({ id: uuidv4(), severity: 'LOW', description: 'Zero revenue entry on ' + new Date(r.date).toISOString().slice(0, 10) + ' despite other revenue existing.', evidenceType: 'AI_INFERENCE' as EvidenceType });
        }
      }
    }
    if (experiments.length >= 1) {
      const staleExps = experiments.filter(e => !e.decision && !e.endDate && e.visitors === 0);
      if (staleExps.length > 0) {
        anomalies.push({ id: uuidv4(), severity: 'MEDIUM', description: staleExps.length + ' experiment(s) appear inactive (no visitors, no decision, no end date).', evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
    }
    if (anomalies.length === 0) {
      anomalies.push({ id: uuidv4(), severity: 'LOW', description: 'Insufficient data for anomaly detection.', evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    // 14. Recommendations (AI_INFERENCE)
    const recommendations: string[] = [];
    const nextBestActions: NextBestActionItem[] = [];
    let actionPriority = 1;

    if (notAllowed) {
      recommendations.push('NOT_ALLOWED: Execution recommendations are blocked for this opportunity. It has been flagged as impermissible.');
    } else if (humanReviewRequired) {
      recommendations.push('REVIEW_REQUIRED: Human review required before acting on any recommendation for this opportunity.');
    }

    if (experiments.length === 0) {
      recommendations.push('No experiment data available. Consider running validation tests to gather real performance signals.');
      nextBestActions.push({ id: uuidv4(), action: 'Run a validation experiment', reason: 'No experiment data exists to analyze', priority: actionPriority++, evidenceType: 'AI_INFERENCE' as EvidenceType });
    } else {
      const zeroDataExps = experiments.filter(e => e.visitors === 0 && e.revenue === 0);
      if (zeroDataExps.length > 0) {
        recommendations.push(zeroDataExps.length + ' experiment(s) have no visitor or revenue data. Collect metrics or investigate inactivity.');
        nextBestActions.push({ id: uuidv4(), action: 'Investigate underperforming experiments', reason: zeroDataExps.length + ' experiment(s) show zero activity', priority: actionPriority++, evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
    }

    if (products.length === 0) {
      recommendations.push('No product data available. Consider creating a product from a validated opportunity.');
      nextBestActions.push({ id: uuidv4(), action: 'Create a product from a validated opportunity', reason: 'No products exist to analyze', priority: actionPriority++, evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    if (revenues.length === 0) {
      recommendations.push('No revenue data found. Record revenue entries to enable financial analysis.');
      nextBestActions.push({ id: uuidv4(), action: 'Record revenue data', reason: 'No revenue entries exist', priority: actionPriority++, evidenceType: 'AI_INFERENCE' as EvidenceType });
    } else if (totalNet <= 0) {
      recommendations.push('Net revenue is zero or negative ($' + totalNet.toFixed(2) + '). Review fee structure and revenue sources.');
      nextBestActions.push({ id: uuidv4(), action: 'Review pricing and fees', reason: 'Net revenue is not positive', priority: actionPriority++, evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    if (opportunities.length > 0) {
      const highScoreOpps = opportunities.filter(o => o.overallScore >= 60 && o.halalStatus === 'HALAL' && !['REJECTED', 'PAUSED'].includes(o.status));
      if (highScoreOpps.length > 0) {
        recommendations.push(highScoreOpps.length + ' opportunity(ies) have strong scores (>=60) and are HALAL. Consider prioritizing these.');
        nextBestActions.push({ id: uuidv4(), action: 'Focus on high-scoring HALAL opportunity: "' + highScoreOpps[0].title + '"', reason: 'Score ' + highScoreOpps[0].overallScore + '/100, status ' + highScoreOpps[0].status, priority: actionPriority++, evidenceType: 'AI_INFERENCE' as EvidenceType });
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('Data appears healthy. Continue monitoring metrics and collecting data for deeper analysis.');
      nextBestActions.push({ id: uuidv4(), action: 'Continue data collection', reason: 'Maintain current trajectory', priority: actionPriority++, evidenceType: 'AI_INFERENCE' as EvidenceType });
    }

    // 15. Risks and Assumptions
    const risks: string[] = [];
    if (notAllowed) risks.push('NOT_ALLOWED: This opportunity is blocked.');
    if (humanReviewRequired) risks.push('REVIEW_REQUIRED: This opportunity needs human review.');
    if (revenues.length === 0) risks.push('No revenue data available for risk assessment.');
    if (experiments.length === 0) risks.push('No experiment data to assess validation risks.');
    if (risks.length === 0) risks.push('No critical risks identified from available data.');

    const assumptions: string[] = [
      'Analysis is based on actual stored database records only.',
      'Revenue figures are recorded values, not inferred or projected.',
      'Recommendations are hypotheses requiring human validation before execution.',
    ];

    // 15.5. BUSINESS INTELLIGENCE / PROFITABILITY (deterministic, VERIFIED_DATA)
    // The profitability layer is authoritative for financial math; this agent
    // never lets AI alter a financial number. AI-only narrative remains in the
    // insights above.
    let businessIntelligence: BusinessIntelligenceResult;
    try {
      businessIntelligence = buildBusinessIntelligence({
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
    } catch (biError) {
      console.error('Business Intelligence computation failed:', biError);
      businessIntelligence = buildBusinessIntelligence({ revenues: [] });
      businessIntelligence.warnings.push('Business Intelligence computation failed; figures reflect no usable data.');
    }

    // 16. Evidence Provenance
    const evidence: EvidenceItem[] = [
      { id: uuidv4(), type: 'USER_ENTERED' as EvidenceType, content: 'Analysis objective: ' + analyticsRequest.analysisObjective, source: 'User input' },
      { id: uuidv4(), type: 'USER_ENTERED' as EvidenceType, content: 'Analysis scope: ' + analyticsRequest.analysisScope, source: 'User input' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Opportunities loaded: ' + opportunities.length + ' records from database', source: 'Prisma db.opportunity' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Experiments loaded: ' + experiments.length + ' records from database', source: 'Prisma db.experiment' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Products loaded: ' + products.length + ' records from database', source: 'Prisma db.product' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Revenue records loaded: ' + revenues.length + ' records from database', source: 'Prisma db.revenue' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Profitability KPIs computed deterministically by the shared business-intelligence layer (contribution profit, margin, ROI where data supports it).', source: 'src/lib/business/profitability.ts' },
      { id: uuidv4(), type: 'AI_INFERENCE' as EvidenceType, content: 'Trends, anomalies, and recommendations are AI-generated inferences based on verified data.', source: 'Analytics Agent' },
    ];

    // 17. Determine overall halal status
    // allHalal determined by anyNotAllowed/anyReview below
    const anyNotAllowed = opportunities.some(o => o.halalStatus === 'NOT_ALLOWED');
    const anyReview = opportunities.some(o => o.halalStatus === 'REVIEW_REQUIRED');
    let overallHalal = 'HALAL';
    if (anyNotAllowed) overallHalal = 'NOT_ALLOWED';
    else if (anyReview) overallHalal = 'REVIEW_REQUIRED';

    // 18. Build final result
    let recommendation: string;
    if (notAllowed) {
      recommendation = 'BLOCKED: Execution recommendations are NOT_ALLOWED for this opportunity. Analytical reporting only.';
    } else if (humanReviewRequired) {
      recommendation = 'HUMAN REVIEW REQUIRED: Analytics completed but recommendations require human review due to REVIEW_REQUIRED status.';
    } else {
      recommendation = 'Analytics completed with ' + kpiMetrics.length + ' KPIs calculated from real database data. ' + recommendations.length + ' recommendation(s) generated as AI inferences.';
    }

    const finalAnalyticsResult: AnalyticsResult = {
      analysisScope: analyticsRequest.analysisScope,
      period: { startDate: analyticsRequest.startDate, endDate: analyticsRequest.endDate, label: periodLabel },
      dataSummary,
      kpiMetrics,
      experimentInsights,
      productInsights,
      revenueInsights,
      opportunityInsights,
      trends,
      anomalies,
      risks,
      assumptions,
      recommendations,
      nextBestActions,
      evidence,
      businessIntelligence,
      confidence: insufficientDataWarnings.length > 0 ? 0.3 : 0.7,
      halalStatus: scopedEntity?.halalStatus || overallHalal,
      humanReviewRequired: notAllowed ? false : (humanReviewRequired || anyReview),
      recommendation,
      capabilityStatus: this.status as AgentStatus,
    };

    // 19. Create AgentLog entry
    try {
      const agentLog = await db.agentLog.create({
        data: {
          agentType: this.type,
          action: request.action,
          input: JSON.stringify(request.input),
          output: JSON.stringify(finalAnalyticsResult),
          reasoning: 'Analytics completed: ' + kpiMetrics.length + ' KPIs, ' + recommendations.length + ' recommendations',
          evidenceType: 'VERIFIED_DATA',
        },
      });
      finalAnalyticsResult.agentLogId = agentLog.id;
    } catch (logError) {
      console.error('Failed to log Analytics Agent execution: ' + logError);
    }

    return {
      success: true,
      output: finalAnalyticsResult,
      reasoning: 'Analytics Agent completed analysis of ' + opportunities.length + ' opportunities, ' + experiments.length + ' experiments, ' + products.length + ' products, ' + revenues.length + ' revenue records. All KPIs calculated from real database data. Profitability: contribution profit $' + businessIntelligence.overall.contributionProfit.toFixed(2) + '.',
      evidenceType: 'VERIFIED_DATA' as EvidenceType,
      executionTime: Date.now() - startTime,
    };
  }
}
