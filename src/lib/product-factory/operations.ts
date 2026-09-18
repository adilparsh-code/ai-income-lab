// Phase 5.5 — Operations dashboard (Part 14).
//
// The single server-side surface the operations dashboard consumes. Every
// figure derives from REAL DB rows (JobRun, WorkflowRun, Product, Revenue,
// ProductEvent, AgentLog) — never invented, never sampled from aspirations.
// Any aggregate that would depend on missing evidence carries an honest
// label (INSUFFICIENT_DATA / NOT_CONNECTED / etc.) instead of a fabricated
// number.
//
// SECURITY: reads only metadata/count columns; never selects AI prompts or
// outputs; never reads credentials. Safe for server components.

import { db } from '@/lib/db';
import { describeCapabilityCenter, type CapabilityCenterReport } from './capability-center';
import { assessProductGrowth, type ProductGrowthAssessment } from './events';
import { attributeRevenueRow, type RevenueAttribution } from './economics';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface JobActivity {
  today: number;
  running: number;
  blocked: number;
  humanReview: number;
  failed24h: number;
  succeeded24h: number;
}

export interface ProductOperationsRow {
  id: string;
  name: string;
  status: string;
  opportunityId: string | null;
  lifecycleStage: string;
  buildStatus: string | null;
  deploymentStatus: string | null;
  publicationStatus: string | null;
  visitors: number | null;
  purchases: number | null;
  conversionRate: number | null;
  grossRevenueUsd: number;
  feesUsd: number;
  netRevenueUsd: number;
  estimatedAiCostUsd: number;
  estimatedProfitUsd: number | null;
  profitLabel: 'INSUFFICIENT_DATA' | 'ESTIMATED' | 'VERIFIED';
  growth: ProductGrowthAssessment | null;
  hasRevenue: boolean;
  nextAction: string;
}

export interface OperationsSummary {
  generatedAt: string;
  jobs: JobActivity;
  workflowRuns: { total: number; blocked: number; humanReview: number; lastStatus: string | null };
  products: ProductOperationsRow[];
  totals: {
    grossRevenueUsd: number;
    feesUsd: number;
    netRevenueUsd: number;
    estimatedAiCostUsd: number;
    estimatedProfitUsd: number | null;
    profitLabel: 'INSUFFICIENT_DATA' | 'ESTIMATED' | 'VERIFIED';
  };
  /** Where recorded revenue is attributed to — real rows, never invented. */
  revenueAttribution: {
    total: number;
    product: number;
    opportunity: number;
    campaign: number;
    unknownSource: number;
  };
  treasury: {
    note: string;
  };
  nextBestAction: {
    action: string;
    basis: string;
    evidenceStatus: 'SUPPORTED' | 'INSUFFICIENT_DATA';
    requiresHuman: boolean;
  };
  capabilities: CapabilityCenterReport;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function nextActionFor(row: {
  status: string;
  buildStatus: string | null;
  deploymentStatus: string | null;
  publicationStatus: string | null;
  hasRevenue: boolean;
  growth: ProductGrowthAssessment | null;
}): string {
  if (row.status === 'BLOCKED') return 'Blocked by halal gate — human review required';
  if (row.status === 'IDEA' || row.status === 'VALIDATED') {
    return 'Run product creation through the factory workflow';
  }
  if (row.status === 'SPEC_READY' || row.status === 'BUILDING') return 'Build through the sandboxed builder contract';
  if (row.status === 'TESTING') return 'Await quality-gate results before READY_TO_DEPLOY';
  if (row.status === 'READY_TO_DEPLOY') return 'Deployment requires a human approval token';
  if (row.status === 'DEPLOYED') return 'Prepare listing draft; publishing requires human approval';
  if (row.status === 'PUBLISHED') {
    if (!row.hasRevenue) return 'Track traffic and revenue events (REVENUE_SYNC)';
    if (row.growth?.recommendation) return `Growth recommends: ${row.growth.recommendation}`;
    return 'Analyze recorded performance (PRODUCT_ANALYZE)';
  }
  if (row.status === 'PAUSED' || row.status === 'ARCHIVED') return 'Human decision recorded; no autonomous action';
  return 'Review product state';
}

/** Deterministic business-level next-best-action from REAL state only. */
function computeNextBestAction(input: {
  blockedJobs: number;
  humanReviewJobs: number;
  productsReady: number;
  productsPublishedWithoutRevenue: number;
  publishedCount: number;
  underperforming: number;
  aiCostUsd: number;
  netRevenueUsd: number;
}): OperationsSummary['nextBestAction'] {
  // Human gates dominate everything else.
  if (input.humanReviewJobs > 0) {
    return {
      action: 'RESOLVE_HUMAN_REVIEW',
      basis: `${input.humanReviewJobs} job(s) are waiting for a human decision; autonomous work stays paused at the gate.`,
      evidenceStatus: 'SUPPORTED',
      requiresHuman: true,
    };
  }
  if (input.blockedJobs > 0) {
    return {
      action: 'INSPECT_BLOCKED_JOBS',
      basis: `${input.blockedJobs} job(s) were blocked by deterministic gates (halal/lifecycle); inspect before further work.`,
      evidenceStatus: 'SUPPORTED',
      requiresHuman: true,
    };
  }
  if (input.productsReady > 0) {
    return {
      action: 'PREPARE_DEPLOYMENT_APPROVAL',
      basis: `${input.productsReady} product(s) are READY_TO_DEPLOY; deployment is prepared but requires explicit human approval.`,
      evidenceStatus: 'SUPPORTED',
      requiresHuman: true,
    };
  }
  if (input.productsPublishedWithoutRevenue > 0) {
    return {
      action: 'CAPTURE_TRAFFIC_AND_REVENUE',
      basis: `${input.productsPublishedWithoutRevenue} published product(s) have no recorded revenue events yet; set up traffic capture and record events.`,
      evidenceStatus: 'SUPPORTED',
      requiresHuman: false,
    };
  }
  if (input.underperforming > 0) {
    return {
      action: 'REVIEW_UNDERPERFORMING_PRODUCTS',
      basis: `${input.underperforming} product(s) classify as UNDERPERFORMING on recorded evidence; review before further spend.`,
      evidenceStatus: 'SUPPORTED',
      requiresHuman: false,
    };
  }
  if (input.netRevenueUsd > input.aiCostUsd && input.publishedCount > 0) {
    return {
      action: 'EVALUATE_REINVESTMENT',
      basis: 'Recorded net revenue exceeds recorded estimated AI cost; evaluate the configured reinvestment policy.',
      evidenceStatus: 'SUPPORTED',
      requiresHuman: true,
    };
  }
  return {
    action: 'CONTINUE_DISCOVERY',
    basis: 'No blocked work, no pending approvals, and no product has recorded revenue evidence yet; discovery (research/validation) is the highest-value next step.',
    evidenceStatus: 'SUPPORTED',
    requiresHuman: false,
  };
}

// ---------------------------------------------------------------------------
// Main summary
// ---------------------------------------------------------------------------

export async function getOperationsSummary(): Promise<OperationsSummary> {
  const now = new Date();
  const since24h = new Date(now.getTime() - MS_PER_DAY);

  const [jobRows, workflowRuns, products, revenueRows, aiCostGroups] = await Promise.all([
    db.jobRun.findMany({
      where: { createdAt: { gte: since24h } },
      select: { status: true, createdAt: true },
    }),
    db.workflowRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: { status: true },
    }),
    db.product.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 20,
      include: {
        revenues: { select: { grossRevenue: true, fees: true, netRevenue: true } },
        builds: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
        deployments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
      },
    }),
    db.revenue.findMany({
      orderBy: { date: 'desc' },
      take: 200,
      select: {
        id: true, date: true, revenueSource: true, grossRevenue: true, fees: true, netRevenue: true,
        productId: true, opportunityId: true,
      },
    }),
    db.agentLog.groupBy({
      by: ['productId'],
      _sum: { estimatedCostUsd: true },
      where: { productId: { not: null } },
    }).catch(() => [] as { productId: string | null; _sum: { estimatedCostUsd: number | null } }[]),
  ]);

  const jobActivity: JobActivity = {
    today: jobRows.length,
    running: jobRows.filter((j) => j.status === 'RUNNING').length,
    blocked: jobRows.filter((j) => j.status === 'BLOCKED').length,
    humanReview: jobRows.filter((j) => j.status === 'HUMAN_REVIEW').length,
    failed24h: jobRows.filter((j) => j.status === 'FAILED').length,
    succeeded24h: jobRows.filter((j) => j.status === 'SUCCEEDED').length,
  };

  const aiCostByProduct = new Map<string, number>();
  for (const g of aiCostGroups) {
    if (g.productId) aiCostByProduct.set(g.productId, g._sum.estimatedCostUsd ?? 0);
  }
  const totalAiCostUsd = [...aiCostByProduct.values()].reduce((s, v) => s + v, 0);

  const rows: ProductOperationsRow[] = [];
  for (const p of products) {
    const gross = p.revenues.reduce((s, r) => s + r.grossRevenue, 0);
    const fees = p.revenues.reduce((s, r) => s + r.fees, 0);
    const net = p.revenues.reduce((s, r) => s + r.netRevenue, 0);
    const aiCost = aiCostByProduct.get(p.id) ?? 0;
    const buildStatus = p.builds[0]?.status ?? null;
    const deploymentStatus = p.deployments[0]?.status ?? null;
    const hasRevenue = gross > 0;

    let growth: ProductGrowthAssessment | null = null;
    if (p.status === 'PUBLISHED' || p.status === 'DEPLOYED') {
      try {
        const funnel = await computeProductFunnelSafe(p.id);
        if (funnel) {
          growth = assessProductGrowth({
            productId: p.id,
            productStatus: p.status,
            funnel,
            netRevenueMinor: Math.round(net * 100),
          });
        }
      } catch {
        growth = null; // honest absence, never fabricated
      }
    }

    const profitUsd = hasRevenue ? net - aiCost : null;
    const profitLabel: ProductOperationsRow['profitLabel'] = hasRevenue ? 'ESTIMATED' : 'INSUFFICIENT_DATA';

    rows.push({
      id: p.id,
      name: p.name,
      status: p.status,
      opportunityId: p.opportunityId,
      lifecycleStage: p.status,
      buildStatus,
      deploymentStatus,
      publicationStatus: p.status === 'PUBLISHED' ? 'PUBLISHED' : 'NOT_PUBLISHED',
      visitors: null,
      purchases: null,
      conversionRate: null,
      grossRevenueUsd: gross,
      feesUsd: fees,
      netRevenueUsd: net,
      estimatedAiCostUsd: aiCost,
      estimatedProfitUsd: profitUsd,
      profitLabel,
      growth,
      nextAction: nextActionFor({
        status: p.status,
        buildStatus,
        deploymentStatus,
        publicationStatus: p.status,
        hasRevenue,
        growth,
      }),
      hasRevenue,
    });
  }

  const totalsGross = rows.reduce((s, r) => s + r.grossRevenueUsd, 0);
  const totalsFees = rows.reduce((s, r) => s + r.feesUsd, 0);
  const totalsNet = rows.reduce((s, r) => s + r.netRevenueUsd, 0);
  const anyRevenue = totalsGross > 0;
  const totalsProfit = anyRevenue ? totalsNet - totalAiCostUsd : null;

  // Honest attribution breakdown over every recorded revenue row: where the
  // money is linked to (product / opportunity / campaign) or explicitly
  // UNKNOWN_SOURCE. Never invented — derived by the shared attribution rule.
  const attribution = revenueRows.reduce(
    (acc, r) => {
      const a = attributeRevenueRow({
        id: r.id,
        date: r.date,
        revenueSource: r.revenueSource,
        grossRevenue: r.grossRevenue,
        fees: r.fees,
        netRevenue: r.netRevenue,
        productId: r.productId,
        opportunityId: r.opportunityId,
      });
      acc.total += 1;
      if (a.source === 'PRODUCT') acc.product += 1;
      else if (a.source === 'OPPORTUNITY') acc.opportunity += 1;
      else if (a.source === 'UNKNOWN_SOURCE') acc.unknownSource += 1;
      else acc.campaign += 1;
      return acc;
    },
    { total: 0, product: 0, opportunity: 0, campaign: 0, unknownSource: 0 },
  );

  const nextBestAction = computeNextBestAction({
    blockedJobs: jobActivity.blocked,
    humanReviewJobs: jobActivity.humanReview,
    productsReady: rows.filter((r) => r.status === 'READY_TO_DEPLOY').length,
    productsPublishedWithoutRevenue: rows.filter((r) => r.status === 'PUBLISHED' && !r.hasRevenue).length,
    publishedCount: rows.filter((r) => r.status === 'PUBLISHED').length,
    underperforming: rows.filter((r) => r.growth?.state === 'UNDERPERFORMING').length,
    aiCostUsd: totalAiCostUsd,
    netRevenueUsd: totalsNet,
  });

  return {
    generatedAt: now.toISOString(),
    jobs: jobActivity,
    workflowRuns: {
      total: workflowRuns.length,
      blocked: workflowRuns.filter((w) => w.status === 'BLOCKED').length,
      humanReview: workflowRuns.filter((w) => w.status === 'HUMAN_REVIEW').length,
      lastStatus: workflowRuns[0]?.status ?? null,
    },
    products: rows,
    totals: {
      grossRevenueUsd: totalsGross,
      feesUsd: totalsFees,
      netRevenueUsd: totalsNet,
      estimatedAiCostUsd: totalAiCostUsd,
      estimatedProfitUsd: totalsProfit,
      profitLabel: anyRevenue ? 'ESTIMATED' : 'INSUFFICIENT_DATA',
    },
    revenueAttribution: attribution,
    treasury: {
      note: 'Agent Treasury is internal accounting only (automaticTransfer=false); no real money movement occurs.',
    },
    nextBestAction,
    capabilities: describeCapabilityCenter(),
  };
}

/** Bounded funnel read (best-effort; failures degrade to null). */
async function computeProductFunnelSafe(productId: string) {
  try {
    const { computeProductFunnel } = await import('./events');
    const end = new Date();
    const start = new Date(end.getTime() - 30 * MS_PER_DAY);
    return await computeProductFunnel(productId, { start, end });
  } catch {
    return null;
  }
}

// Re-export so the dashboard module can render attribution source labels.
export type { RevenueAttribution };
