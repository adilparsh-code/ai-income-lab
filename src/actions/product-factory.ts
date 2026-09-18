'use server';

import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/server-log';
import {
  runProductFactory,
  rehydrateFactoryRun,
  type ProductFactoryRequest,
} from '@/lib/product-factory/factory-service';
import {
  buildFactoryRunView,
  looksLikeFactoryRun,
  type FactoryRunView,
} from '@/lib/product-factory/factory-logic';
import { describeDeploymentStatus } from '@/lib/product-factory/build-contract';
import { describePublishingStatus } from '@/lib/publishing/contract';
import type { PipelineRunResult } from '@/lib/ruflo/orchestrator';

/** Lean opportunity list for the factory selector. */
export interface FactoryOpportunityOption {
  id: string;
  title: string;
  status: string;
  halalStatus: string;
  overallScore: number;
}

export async function getFactoryOpportunities(): Promise<FactoryOpportunityOption[]> {
  const opportunities = await db.opportunity.findMany({
    select: {
      id: true,
      title: true,
      status: true,
      halalStatus: true,
      overallScore: true,
    },
    orderBy: { overallScore: 'desc' },
  });
  return opportunities;
}

/** Serializable run history row for the factory workspace. */
export interface FactoryRunSummary {
  id: string;
  opportunityId: string | null;
  opportunityTitle: string | null;
  objective: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
}

export async function getRecentFactoryRuns(limit = 5): Promise<FactoryRunSummary[]> {
  try {
    const runs = await db.pipelineRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 40,
      include: { opportunity: { select: { title: true } } },
    });
    return runs
      .filter((run) => {
        try {
          return looksLikeFactoryRun(JSON.parse(run.result));
        } catch {
          return false;
        }
      })
      .slice(0, limit)
      .map((run) => ({
        id: run.id,
        opportunityId: run.opportunityId,
        opportunityTitle: run.opportunity?.title ?? null,
        objective: run.objective,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        durationMs: run.durationMs,
      }));
  } catch (error) {
    logger.error('Factory run history could not be loaded', error);
    return [];
  }
}

/**
 * Generate a product concept from a selected opportunity. The orchestrator
 * owns halal gates, agent execution, provenance, and persistence; this action
 * adapts between client and server and surfaces errors safely.
 */
export type GenerateProductResult =
  | { ok: true; runId: string; run: PipelineRunResult; view: FactoryRunView }
  | { ok: false; error: string };

export async function generateProductConcept(input: {
  opportunityId?: string;
  objective?: string;
  productType?: string;
  monetizationPreference?: string;
  constraints?: string[];
}): Promise<GenerateProductResult> {
  if (
    (typeof input?.objective !== 'string' || input.objective.trim().length === 0) &&
    (typeof input?.opportunityId !== 'string' || input.opportunityId.trim().length === 0)
  ) {
    return { ok: false, error: 'Select an opportunity or provide an objective to generate a product concept.' };
  }

  let outcome;
  try {
    outcome = await runProductFactory(input as ProductFactoryRequest);
  } catch (error) {
    logger.error('Factory generate action failed', error);
    return { ok: false, error: 'Product generation failed due to an unexpected error. Try again.' };
  }

  if (!outcome.ok || !outcome.run) {
    return { ok: false, error: outcome.error ?? 'Product generation failed. Try again.' };
  }

  revalidatePath('/product-factory');
  revalidatePath('/');

  return {
    ok: true,
    runId: outcome.run.runId ?? '',
    run: outcome.run,
    view: buildFactoryRunView({ ...outcome.run, steps: outcome.run.steps.map((s) => s.summary) }),
  };
}

/** Rehydrate a persisted run into the workspace view (history browsing). */
export type RehydratedRunResult =
  | { ok: true; view: FactoryRunView; status: string; objective: string }
  | { ok: false; error: string };

export async function getFactoryRunDetail(runId: string): Promise<RehydratedRunResult> {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return { ok: false, error: 'A run id is required.' };
  }

  try {
    const rehydrated = await rehydrateFactoryRun(runId);
    if (!rehydrated) {
      return { ok: false, error: 'The requested run could not be found or its payload is unreadable.' };
    }
    return {
      ok: true,
      view: buildFactoryRunView({ ...rehydrated.run, steps: rehydrated.run.steps.map((s) => s.summary) }),
      status: rehydrated.run.status,
      objective: rehydrated.run.objective,
    };
  } catch (error) {
    logger.error('Factory run detail action failed', error, { runId });
    return { ok: false, error: 'The run detail could not be loaded. Try again.' };
  }
}

// ===========================================================================
// Phase 5.3 — Product Factory dashboard summary (lifecycle + economics +
// truthful provider statuses). Reads REAL records only; degrades gracefully.
// ===========================================================================

export interface FactoryLifecycleRow {
  id: string;
  name: string;
  type: string;
  status: string;
  opportunityId: string | null;
  opportunityTitle: string | null;
  price: number;
  grossRevenueUsd: number;
  feesUsd: number;
  netRevenueUsd: number;
  buildStatus: string | null;
  deploymentStatus: string | null;
  publicationStatus: string | null;
  nextAction: string;
}

export interface ProductFactoryDashboardSummary {
  products: FactoryLifecycleRow[];
  countsByStatus: Record<string, number>;
  totals: {
    grossRevenueUsd: number;
    netRevenueUsd: number;
    estimatedAiCostUsd: number;
  };
  deployment: { status: string; note: string };
  publishing: { status: string; note: string };
}

const LIFECYCLE_ORDER = [
  'IDEA', 'VALIDATED', 'SPEC_READY', 'BUILDING', 'TESTING',
  'READY_TO_DEPLOY', 'DEPLOYED', 'PUBLISHED', 'PAUSED', 'ARCHIVED', 'BLOCKED',
] as const;

export async function getProductFactorySummary(limit = 12): Promise<ProductFactoryDashboardSummary> {
  try {
    const products = await db.product.findMany({
      orderBy: { updatedAt: 'desc' },
      take: Math.min(50, Math.max(1, limit)),
      include: {
        opportunity: { select: { title: true } },
        revenues: { select: { grossRevenue: true, fees: true, netRevenue: true } },
      },
    });

    const [builds, deployments, assets, aiCostGroups] = await Promise.all([
      db.productBuild.findMany({
        orderBy: { createdAt: 'desc' }, take: 100,
        select: { productId: true, status: true },
      }).catch(() => []),
      db.productDeployment.findMany({
        orderBy: { createdAt: 'desc' }, take: 100,
        select: { productId: true, status: true },
      }).catch(() => []),
      db.productAsset.findMany({
        orderBy: { createdAt: 'desc' }, take: 100,
        select: { productId: true, publicationStatus: true },
      }).catch(() => []),
      db.agentLog.groupBy({
        by: ['purpose'],
        _sum: { estimatedCostUsd: true },
        where: { estimatedCostUsd: { not: null } },
      }).catch(() => []),
    ]);

    const latestBuild = new Map<string, string>();
    for (const b of builds) if (!latestBuild.has(b.productId)) latestBuild.set(b.productId, b.status);
    const latestDeployment = new Map<string, string>();
    for (const d of deployments) if (!latestDeployment.has(d.productId)) latestDeployment.set(d.productId, d.status);
    const assetStatus = new Map<string, string>();
    for (const a of assets) if (!assetStatus.has(a.productId)) assetStatus.set(a.productId, a.publicationStatus);

    const totalAiCostUsd = aiCostGroups.reduce((sum, g) => sum + (g._sum.estimatedCostUsd ?? 0), 0);

    const rows: FactoryLifecycleRow[] = products.map((p) => {
      const gross = p.revenues.reduce((s, r) => s + r.grossRevenue, 0);
      const fees = p.revenues.reduce((s, r) => s + r.fees, 0);
      const net = p.revenues.reduce((s, r) => s + r.netRevenue, 0);

      const nextAction = p.status === 'PUBLISHED'
        ? 'Track revenue and analyze (REVENUE_SYNC → PRODUCT_ANALYZE)'
        : p.status === 'DEPLOYED'
          ? 'Prepare listing draft; publishing requires human approval'
          : p.status === 'READY_TO_DEPLOY'
            ? 'Deployment requires a human approval token'
            : p.status === 'BLOCKED'
              ? 'Blocked by halal gate — human review required'
              : 'Continue lifecycle: research → validation → spec';

      return {
        id: p.id,
        name: p.name,
        type: p.type,
        status: (LIFECYCLE_ORDER as readonly string[]).includes(p.status) ? p.status : 'IDEA',
        opportunityId: p.opportunityId,
        opportunityTitle: p.opportunity?.title ?? null,
        price: p.price,
        grossRevenueUsd: Number(gross.toFixed(2)),
        feesUsd: Number(fees.toFixed(2)),
        netRevenueUsd: Number(net.toFixed(2)),
        buildStatus: latestBuild.get(p.id) ?? null,
        deploymentStatus: latestDeployment.get(p.id) ?? null,
        publicationStatus: assetStatus.get(p.id) ?? null,
        nextAction,
      };
    });

    const countsByStatus: Record<string, number> = {};
    for (const status of LIFECYCLE_ORDER) countsByStatus[status] = 0;
    for (const row of rows) countsByStatus[row.status] = (countsByStatus[row.status] ?? 0) + 1;

    return {
      products: rows,
      countsByStatus,
      totals: {
        grossRevenueUsd: Number(rows.reduce((s, r) => s + r.grossRevenueUsd, 0).toFixed(2)),
        netRevenueUsd: Number(rows.reduce((s, r) => s + r.netRevenueUsd, 0).toFixed(2)),
        estimatedAiCostUsd: Number(totalAiCostUsd.toFixed(2)),
      },
      deployment: describeDeploymentStatus(),
      publishing: describePublishingStatus(),
    };
  } catch (error) {
    logger.error('Product Factory dashboard summary failed; degrading to empty', error);
    return {
      products: [],
      countsByStatus: Object.fromEntries(LIFECYCLE_ORDER.map((s) => [s, 0])),
      totals: { grossRevenueUsd: 0, netRevenueUsd: 0, estimatedAiCostUsd: 0 },
      deployment: describeDeploymentStatus(),
      publishing: describePublishingStatus(),
    };
  }
}
