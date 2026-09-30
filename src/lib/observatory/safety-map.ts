// Phase 10.9 — Halal / Safety Income Map + Phase 10.4 / 10.5 external
// activity observability (publishing, customer interactions).
//
// All verdicts come from locally persisted screening columns
// (Opportunity.halalStatus / Product.halalStatus / OpportunityHandoff.halalStatus).
// Producer-asserted eligibility is never an input here — receiver-side
// re-derivation remains the authority. No screening is presented as a fatwa.

import { db } from '@/lib/db';
import type { CustomerInteractionView, HalalMap, IntegrationHealth, PublishingRow } from './types';

export async function getHalalMap(): Promise<HalalMap> {
  const [opportunities, products, revenues, handoffs] = await Promise.all([
    db.opportunity.findMany({ select: { id: true, halalStatus: true }, take: 2000 }),
    db.product.findMany({ select: { id: true, opportunityId: true, status: true }, take: 2000 }),
    db.revenue.findMany({ select: { grossRevenue: true, currency: true, opportunityId: true, productId: true }, take: 2000 }),
    db.opportunityHandoff.findMany({ select: { halalStatus: true }, take: 500 }),
  ]);

  // Screening verdict lookup used for products and revenue linkage.
  const oppStatusMap = new Map(opportunities.map((o) => [o.id, o.halalStatus]));

  const bucket = (status: string) =>
    status === 'HALAL' || status === 'ALLOWED'
      ? 'allowed' as const
      : status === 'REVIEW_REQUIRED' || status === 'NEEDS_HUMAN_REVIEW'
        ? 'reviewRequired' as const
        : 'blocked' as const;

  const opportunityBuckets = { allowed: 0, reviewRequired: 0, blocked: 0 };
  for (const o of opportunities) opportunityBuckets[bucket(o.halalStatus)] += 1;

  const productBuckets = { allowed: 0, reviewRequired: 0, blocked: 0 };
  for (const p of products) {
    // Products carry no screening column of their own; the verdict is derived
    // deterministically from the parent opportunity's locally screened status.
    const status = p.opportunityId ? oppStatusMap.get(p.opportunityId) : undefined;
    productBuckets[bucket(status ?? 'REVIEW_REQUIRED')] += 1;
  }

  // Revenue → product/opportunity → screening verdict. Rows whose screening
  // verdict cannot be reached stay UNKNOWN — never folded into 0 or ALLOWED.
  const prodStatus = new Map(products.map((p) => [p.id, p.opportunityId ? oppStatusMap.get(p.opportunityId) : undefined]));
  const currencies = new Set(revenues.map((r) => r.currency));
  const mixed = currencies.size > 1;

  const revenueBuckets = { allowedUsd: null as number | null, reviewRequiredUsd: null as number | null, blockedUsd: null as number | null, unknownUsd: 0 };
  let allowedSum = 0;
  let reviewSum = 0;
  let blockedSum = 0;
  for (const r of revenues) {
    const status = (r.opportunityId ? oppStatusMap.get(r.opportunityId) : undefined) ?? (r.productId ? prodStatus.get(r.productId) : undefined);
    if (!status) {
      revenueBuckets.unknownUsd += r.grossRevenue;
      continue;
    }
    if (bucket(status) === 'allowed') allowedSum += r.grossRevenue;
    else if (bucket(status) === 'reviewRequired') reviewSum += r.grossRevenue;
    else blockedSum += r.grossRevenue;
  }
  if (revenues.length > 0 && !mixed) {
    const round = (v: number) => Math.round(v * 100) / 100;
    revenueBuckets.allowedUsd = round(allowedSum);
    revenueBuckets.reviewRequiredUsd = round(reviewSum);
    revenueBuckets.blockedUsd = round(blockedSum);
  }

  const handoffCounts = { allowed: 0, reviewRequired: 0, blocked: 0 };
  for (const h of handoffs) handoffCounts[bucket(h.halalStatus)] += 1;

  return {
    opportunities: opportunityBuckets,
    products: productBuckets,
    revenue: revenueBuckets,
    note:
      'Verdicts are locally re-derived screening outcomes (halal gate), not religious rulings. '
      + `Producer-asserted eligibility is audit-only. Handoff rows seen: ${handoffCounts.allowed} allowed / ${handoffCounts.reviewRequired} review / ${handoffCounts.blocked} blocked.`,
  };
}

// ---------------------------------------------------------------------------
// Phase 10.4 — Publishing / external activity observability.
// ---------------------------------------------------------------------------

export async function getPublishingRows(limit = 40): Promise<{
  rows: PublishingRow[];
  providerState: IntegrationHealth;
}> {
  const [products, deployments, events, revenueRows, publishingStatus, parentOpportunities] = await Promise.all([
    db.product.findMany({ orderBy: { updatedAt: 'desc' }, take: limit, select: { id: true, name: true, status: true, opportunityId: true, createdAt: true, updatedAt: true } }),
    db.productDeployment.findMany({ orderBy: { createdAt: 'desc' }, take: limit * 3, select: { productId: true, status: true, providerId: true, url: true, errors: true, createdAt: true } }),
    db.productEvent.groupBy({ by: ['productId', 'eventType'], _count: { _all: true } }),
    db.revenue.findMany({ select: { productId: true, grossRevenue: true, currency: true }, take: 2000 }),
    import('@/lib/publishing/contract').then((m) => m.describePublishingStatus()),
    db.opportunity.findMany({ select: { id: true, halalStatus: true }, take: 2000 }),
  ]);

  const publishingOppStatus = new Map(parentOpportunities.map((o) => [o.id, o.halalStatus]));

  const latestDeployment = new Map<string, (typeof deployments)[number]>();
  for (const d of deployments) if (!latestDeployment.has(d.productId)) latestDeployment.set(d.productId, d);

  const visitorsByProduct = new Map<string, number>();
  const purchasesByProduct = new Map<string, number>();
  for (const g of events) {
    if (g.eventType === 'VISITOR') visitorsByProduct.set(g.productId, g._count._all);
    if (g.eventType === 'PURCHASE') purchasesByProduct.set(g.productId, g._count._all);
  }

  const revenueCurrencies = new Set(revenueRows.map((r) => r.currency));
  const singleCurrency = revenueCurrencies.size <= 1;
  const revenueByProduct = new Map<string, number>();
  for (const r of revenueRows) {
    if (!r.productId) continue;
    revenueByProduct.set(r.productId, (revenueByProduct.get(r.productId) ?? 0) + r.grossRevenue);
  }

  const rows: PublishingRow[] = products.map((p) => {
    const dep = latestDeployment.get(p.id) ?? null;
    const revUsd = revenueByProduct.get(p.id);
    return {
      productId: p.id,
      productName: p.name,
      status: p.status,
      halalStatus: p.opportunityId ? (publishingOppStatus.get(p.opportunityId) ?? 'UNKNOWN') : 'UNKNOWN',
      destination: dep?.providerId ?? null,
      publishState: dep?.status ?? 'NOT_PUBLISHED_NO_DEPLOYMENT_RECORD',
      url: dep?.url ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      lastDeploymentAt: dep ? dep.createdAt.toISOString() : null,
      deploymentErrors: dep ? (JSON.parse(dep.errors || '[]') as string[]).slice(0, 3) : [],
      traffic: { visitors: visitorsByProduct.get(p.id) ?? 0, purchases: purchasesByProduct.get(p.id) ?? 0 },
      attributedRevenueUsd: singleCurrency && revUsd !== undefined ? Math.round(revUsd * 100) / 100 : null,
      revenueQuality: revUsd !== undefined && singleCurrency ? 'REAL' : 'UNKNOWN',
    };
  });

  const providerState: IntegrationHealth = {
    name: 'Publishing Provider',
    state: publishingStatus.status === 'AVAILABLE' ? 'CONNECTED' : publishingStatus.status === 'PUBLISHING_READY' ? 'NOT_CONFIGURED' : 'NOT_CONNECTED',
    detail: publishingStatus.note,
    requiredForConnected: publishingStatus.status === 'AVAILABLE' ? [] : ['POLAR_ACCESS_TOKEN (server-side)', 'Verified provider round-trip before any LIVE label'],
  };

  return { rows, providerState };
}

// ---------------------------------------------------------------------------
// Phase 10.5 — Client / customer interaction observability.
// ---------------------------------------------------------------------------

/** No customer-communication connector exists in the codebase — always truthful. */
export async function getCustomerInteractions(): Promise<CustomerInteractionView> {
  return {
    state: 'NOT_CONNECTED',
    detail:
      'No customer communication connector exists in this system. ProductEvent rows record anonymous '
      + 'funnel events (no PII); no conversations, tickets or client sessions are captured or fabricated.',
    interactions: [],
    requiredForConnected: ['A real customer-communication provider adapter (none implemented)'],
  };
}
