// Phase 5.4 — Product event ingestion + deterministic conversion metrics
// (Parts 6 & 7).
//
// Provider-agnostic ingestion contract: any traffic/commerce source may record
// events through recordProductEvent(), which validates, stamps provenance, and
// persists idempotently (a duplicate idempotency key is a no-op, never a
// second row). The Growth Engine consumes ONLY these recorded events — no
// event is ever synthesized, and deterministic metrics computed from them are
// labelled INSUFFICIENT_DATA when sample sizes are too small to support a
// conclusion.
//
// No unnecessary personal data is stored: identifiers are caller-provided
// opaque session/visitor keys; IPs, emails, user agents, and payloads are not
// accepted by the contract at all.

import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// ---------------------------------------------------------------------------
// Event contract
// ---------------------------------------------------------------------------

export type ProductEventType =
  | 'VISITOR'
  | 'PAGE_VIEW'
  | 'PRODUCT_VIEW'
  | 'CTA_CLICK'
  | 'CHECKOUT_STARTED'
  | 'PURCHASE'
  | 'REFUND';

export const PRODUCT_EVENT_TYPES: readonly ProductEventType[] = [
  'VISITOR', 'PAGE_VIEW', 'PRODUCT_VIEW', 'CTA_CLICK', 'CHECKOUT_STARTED', 'PURCHASE', 'REFUND',
];

/** Money values are floats in USD as recorded by the source (schema field). */
export interface ProductEventInput {
  eventType: ProductEventType;
  productId: string;
  /** Opaque, pre-anonymized identifiers — never raw PII. */
  sessionId?: string | null;
  campaignId?: string | null;
  opportunityId?: string | null;
  experimentId?: string | null;
  /** Idempotency: same key ⇒ same event, recorded once. */
  idempotencyKey: string;
  source: string;
  /** Evidence class of the event — VERIFIED_DATA or USER_ENTERED only. */
  evidenceType?: 'VERIFIED_DATA' | 'USER_ENTERED';
  /** Recorded monetary value in USD; only meaningful for PURCHASE/REFUND. */
  amountUsd?: number | null;
  occurredAt?: string | null;
  // Phase 8 (Rules 6–7) — distribution attribution (additive, all optional,
  // bounded, non-PII). These extend the same event contract; funnel logic is
  // unchanged and older rows simply have null attribution.
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  referrer?: string | null;
  landingPage?: string | null;
}

export type EventIngestStatus =
  | 'RECORDED'
  | 'DUPLICATE'
  | 'INVALID'
  | 'STORAGE_UNAVAILABLE';

export interface EventIngestResult {
  status: EventIngestStatus;
  eventId: string | null;
  errors: string[];
}

function validateEventInput(input: ProductEventInput): string[] {
  const errors: string[] = [];
  if (!PRODUCT_EVENT_TYPES.includes(input.eventType)) errors.push(`Unknown event type: ${String(input.eventType)}`);
  if (typeof input.productId !== 'string' || input.productId.trim().length === 0) errors.push('productId is required.');
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) errors.push('idempotencyKey is required.');
  if (typeof input.source !== 'string' || input.source.trim().length === 0) errors.push('source is required.');
  if (input.amountUsd !== undefined && input.amountUsd !== null) {
    if (typeof input.amountUsd !== 'number' || !Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
      errors.push('amountUsd must be a non-negative number.');
    }
  }
  if (input.sessionId && input.sessionId.length > 256) errors.push('sessionId exceeds 256 chars.');
  for (const [field, value] of [
    ['utmSource', input.utmSource],
    ['utmMedium', input.utmMedium],
    ['utmCampaign', input.utmCampaign],
    ['utmContent', input.utmContent],
    ['utmTerm', input.utmTerm],
    ['referrer', input.referrer],
    ['landingPage', input.landingPage],
  ] as const) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > 300)) {
      errors.push(`${field} must be a string of at most 300 characters.`);
    }
  }
  return errors;
}

/**
 * Safe persistence: validates, then records with idempotent key. A Prisma
 * unique-violation on the idempotency key is a DUPLICATE, not an error.
 * Storage failure degrades to STORAGE_UNAVAILABLE — ingestion never throws.
 */
export async function recordProductEvent(input: ProductEventInput): Promise<EventIngestResult> {
  const errors = validateEventInput(input);
  if (errors.length > 0) return { status: 'INVALID', eventId: null, errors };

  const idempotencyKey = input.idempotencyKey.trim();
  try {
    const row = await db.productEvent.create({
      data: {
        eventType: input.eventType,
        productId: input.productId.trim(),
        sessionId: input.sessionId?.trim() || null,
        campaignId: input.campaignId?.trim() || null,
        opportunityId: input.opportunityId?.trim() || null,
        experimentId: input.experimentId?.trim() || null,
        idempotencyKey,
        source: input.source.trim(),
        evidenceType: input.evidenceType ?? 'VERIFIED_DATA',
        amountUsd: input.amountUsd ?? null,
        utmSource: input.utmSource?.trim() || null,
        utmMedium: input.utmMedium?.trim() || null,
        utmCampaign: input.utmCampaign?.trim() || null,
        utmContent: input.utmContent?.trim() || null,
        utmTerm: input.utmTerm?.trim() || null,
        referrer: input.referrer?.trim() || null,
        landingPage: input.landingPage?.trim() || null,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      },
    });
    return { status: 'RECORDED', eventId: row.id, errors: [] };
  } catch (error) {
    const isUniqueViolation =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
    if (isUniqueViolation) {
      return { status: 'DUPLICATE', eventId: null, errors: [] };
    }
    // Storage genuinely unavailable — honest status, never a fabricated row.
    return {
      status: 'STORAGE_UNAVAILABLE',
      eventId: null,
      errors: ['Event storage is unavailable; the event was not recorded.'],
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic funnel metrics over recorded events only
// ---------------------------------------------------------------------------

export interface ProductFunnelSnapshot {
  productId: string;
  visitors: number;
  productViews: number;
  ctaClicks: number;
  checkoutStarts: number;
  purchases: number;
  refunds: number;
  grossRevenueUsd: number;
  refundedAmountUsd: number;
  conversionRate: number | null;
  revenuePerVisitorUsd: number | null;
  refundRate: number | null;
  /** Honest data-quality label for the whole snapshot. */
  evidenceStatus: 'SUPPORTED' | 'INSUFFICIENT_DATA';
  windowStart: string;
  windowEnd: string;
}

/** Visitors required before a conversion rate is considered supported. */
const MIN_VISITORS_FOR_RATE = 30;
/** Purchases required before revenue-per-visitor is considered supported. */
const MIN_PURCHASES_FOR_RPV = 5;

function countUnique(rows: { sessionId: string | null }[]): number {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.sessionId) keys.add(row.sessionId);
  }
  return keys.size;
}

/**
 * Compute funnel metrics from RECORDED events in a time window. Deterministic:
 * same rows ⇒ same numbers. Labels follow the evidence rules: with fewer than
 * MIN_VISITORS_FOR_RATE visitors, rates are null + INSUFFICIENT_DATA.
 */
export async function computeProductFunnel(
  productId: string,
  window: { start: Date; end: Date },
): Promise<ProductFunnelSnapshot> {
  const rows = await db.productEvent.findMany({
    where: {
      productId,
      occurredAt: { gte: window.start, lte: window.end },
    },
    orderBy: { occurredAt: 'asc' },
  });

  const byType = (type: ProductEventType) => rows.filter((r) => r.eventType === type);
  const visitorRows = byType('VISITOR');
  const purchaseRows = byType('PURCHASE');
  const refundRows = byType('REFUND');

  const visitors = countUnique(visitorRows);
  const purchases = purchaseRows.length;
  const refunds = refundRows.length;

  const grossRevenueUsd = purchaseRows.reduce((sum, r) => sum + (r.amountUsd ?? 0), 0);
  const refundedAmountUsd = refundRows.reduce((sum, r) => sum + (r.amountUsd ?? 0), 0);

  const enoughVisitors = visitors >= MIN_VISITORS_FOR_RATE;
  const conversionRate = enoughVisitors ? purchases / visitors : null;
  const revenuePerVisitorUsd = enoughVisitors && purchases >= MIN_PURCHASES_FOR_RPV
    ? grossRevenueUsd / Math.max(visitors, 1)
    : null;
  const refundRate = purchases >= MIN_PURCHASES_FOR_RPV ? refunds / purchases : null;

  return {
    productId,
    visitors,
    productViews: byType('PRODUCT_VIEW').length,
    ctaClicks: byType('CTA_CLICK').length,
    checkoutStarts: byType('CHECKOUT_STARTED').length,
    purchases,
    refunds,
    grossRevenueUsd,
    refundedAmountUsd,
    conversionRate,
    revenuePerVisitorUsd,
    refundRate,
    evidenceStatus: enoughVisitors ? 'SUPPORTED' : 'INSUFFICIENT_DATA',
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Growth Engine integration (Part 7)
// ---------------------------------------------------------------------------

export type ProductGrowthState = 'TESTING' | 'PROMISING' | 'PROVEN' | 'UNDERPERFORMING' | 'PAUSED';
export type GrowthRecommendation = 'SCALE' | 'IMPROVE' | 'TEST' | 'PAUSE' | 'STOP' | 'REINVEST' | 'NEW_OPPORTUNITY';

export interface ProductGrowthAssessment {
  productId: string;
  state: ProductGrowthState;
  recommendation: GrowthRecommendation;
  /** Deterministic reason string — safe for dashboards. */
  basis: string;
  evidenceStatus: 'SUPPORTED' | 'INSUFFICIENT_DATA';
}

/** Environment-configurable thresholds (same convention as growth-engine.ts). */
function minProvenRevenueMinor(): number {
  const raw = Number(process.env.GROWTH_PROVEN_REVENUE_MINOR ?? '50000');
  return Number.isFinite(raw) && raw >= 0 ? raw : 50000;
}
function minPromisingRevenueMinor(): number {
  const raw = Number(process.env.GROWTH_PROMISING_REVENUE_MINOR ?? '5000');
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}
function minVisitors(): number {
  const raw = Number(process.env.GROWTH_MIN_VISITORS_MINOR ?? '30');
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/**
 * Classify a product's growth state from recorded evidence only. Human
 * PAUSE/KILL dominance is enforced by the caller passing the current product
 * status: PAUSED/ARCHIVED products stay PAUSED regardless of metrics.
 * No revenue prediction, no guaranteed-income language, deterministic output.
 */
export function assessProductGrowth(input: {
  productId: string;
  productStatus: string;
  funnel: ProductFunnelSnapshot;
  netRevenueMinor: number;
}): ProductGrowthAssessment {
  const { productId, productStatus, funnel } = input;

  // Human decisions dominate (Phase 5.3 lifecycle pause/archive wins).
  if (productStatus === 'PAUSED' || productStatus === 'ARCHIVED') {
    return {
      productId,
      state: 'PAUSED',
      recommendation: 'PAUSE',
      basis: `Product status is ${productStatus}; human decision dominates metrics.`,
      evidenceStatus: 'SUPPORTED',
    };
  }

  if (funnel.evidenceStatus === 'INSUFFICIENT_DATA' || funnel.visitors < minVisitors()) {
    return {
      productId,
      state: 'TESTING',
      recommendation: 'TEST',
      basis: `Only ${funnel.visitors} recorded visitors (need ${minVisitors()}); INSUFFICIENT_DATA for any stronger state.`,
      evidenceStatus: 'INSUFFICIENT_DATA',
    };
  }

  if (funnel.purchases === 0) {
    return {
      productId,
      state: 'UNDERPERFORMING',
      recommendation: 'IMPROVE',
      basis: `${funnel.visitors} visitors with zero recorded purchases.`,
      evidenceStatus: 'SUPPORTED',
    };
  }

  const net = input.netRevenueMinor;
  if (net < 0) {
    return {
      productId,
      state: 'UNDERPERFORMING',
      recommendation: 'STOP',
      basis: `Recorded net revenue is negative (${net} minor units).`,
      evidenceStatus: 'SUPPORTED',
    };
  }
  if (net >= minProvenRevenueMinor()) {
    return {
      productId,
      state: 'PROVEN',
      recommendation: 'SCALE',
      basis: `Net revenue ${net} minor units ≥ proven threshold with ${funnel.purchases} recorded purchases.`,
      evidenceStatus: 'SUPPORTED',
    };
  }
  if (net >= minPromisingRevenueMinor()) {
    return {
      productId,
      state: 'PROMISING',
      recommendation: 'REINVEST',
      basis: `Net revenue ${net} minor units ≥ promising threshold; continue testing before scaling.`,
      evidenceStatus: 'SUPPORTED',
    };
  }
  return {
    productId,
    state: 'TESTING',
    recommendation: 'TEST',
    basis: `Net revenue ${net} minor units below the promising threshold; keep testing.`,
    evidenceStatus: 'SUPPORTED',
  };
}

export type { Prisma };
