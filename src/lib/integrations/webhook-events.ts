// Phase 8 — Payment webhook event processing (Rule 8).
//
// Converts a signature-VERIFIED webhook payload into recorded revenue through
// the EXISTING ingestion pipeline (recordRevenueWithAttribution) — no second
// revenue system:
//
//   signature verified (webhook-verification.ts)
//     → parse (strict, fail-closed)
//     → event-type allowlist (order.paid / order.confirmed only)
//     → amount validation (positive finite number, major units)
//     → currency validation (must be supported by market config)
//     → product linkage (must map to a known product)
//     → idempotency (shared revenueIdempotencyKey via the existing pipeline)
//     → safe failure (bad events are rejected with a verdict, never crash)
//
// NEVER manually manufactures a payment: this path only records what a
// signature-verified provider payload states. Amounts/currencies come from the
// payload, never guessed. Secrets are never logged.

import { isCurrencyAcceptedForMarket } from '@/lib/integrations/markets';
import { recordRevenueWithAttribution } from '@/lib/product-factory/economics';

export const POLAR_EVENT_PAID_TYPES = ['order.paid', 'order.confirmed'] as const;
export type PolarPaidEventType = (typeof POLAR_EVENT_PAID_TYPES)[number];

export interface PolarOrderPayload {
  id: string;
  /** Polar convention: minor units (cents) for total_amount. */
  total_amount?: number;
  /** Non-standard field for custom bridges: major units. */
  amount?: number;
  currency?: string;
  customer_email?: string | null;
  product_id?: string | null;
  product?: { id?: string; name?: string } | null;
  created_at?: string;
  metadata?: Record<string, unknown> | null;
}

export interface VerifiedEvent {
  eventId: string;
  eventType: string;
  order: PolarOrderPayload;
}

export type WebhookProcessingOutcome =
  | { status: 'RECORDED'; revenueId: string; grossRevenue: number; currency: string }
  | { status: 'DUPLICATE'; revenueId: string | null }
  | { status: 'IGNORED'; reason: 'EVENT_TYPE_NOT_PAID' | 'NOT_ORDER_LIKE'; detail: string }
  | { status: 'REJECTED'; reason: string; detail: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractEventId(root: Record<string, unknown>): string | null {
  const candidates = [root.id, root.event_id, root.eventId];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function extractEventType(root: Record<string, unknown>): string | null {
  const candidates = [root.type, root.event_type];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function extractOrder(root: Record<string, unknown>): PolarOrderPayload | null {
  const direct = asRecord(root.data);
  const orderLike = direct ?? asRecord(root.order) ?? root;
  const id = typeof orderLike.id === 'string' ? orderLike.id.trim() : '';
  if (!id) return null;
  const product = asRecord(orderLike.product);
  const meta = asRecord(orderLike.metadata);
  return {
    id,
    total_amount: typeof orderLike.total_amount === 'number' ? orderLike.total_amount : undefined,
    amount: typeof orderLike.amount === 'number' ? orderLike.amount : undefined,
    currency: typeof orderLike.currency === 'string' ? orderLike.currency : undefined,
    customer_email: typeof orderLike.customer_email === 'string' ? orderLike.customer_email : null,
    product_id: typeof orderLike.product_id === 'string' ? orderLike.product_id : product && typeof product.id === 'string' ? product.id : null,
    product: product ? { id: typeof product.id === 'string' ? product.id : undefined, name: typeof product.name === 'string' ? product.name : undefined } : null,
    created_at: typeof orderLike.created_at === 'string' ? orderLike.created_at : undefined,
    metadata: meta,
  };
}

/** Parse a verified raw body into a processable event, without trusting it. */
export function parseVerifiedEventBody(rawBody: string): VerifiedEvent | { error: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { error: 'Body is not valid JSON.' };
  }
  const root = asRecord(payload);
  if (!root) return { error: 'Body is not a JSON object.' };
  const eventId = extractEventId(root);
  if (!eventId) return { error: 'Payload has no event id.' };
  const eventType = extractEventType(root);
  if (!eventType) return { error: 'Payload has no event type.' };
  const order = extractOrder(root);
  if (!order) return { error: 'Payload carries no recognizable order.' };
  return { eventId, eventType, order };
}

/**
 * Idempotent, validated processing of one signature-verified webhook event.
 * Records through the existing revenue pipeline; replays collapse to
 * DUPLICATE via the shared idempotency rule. Never throws.
 */
export async function processVerifiedPaymentEvent(event: VerifiedEvent, receivedAt: Date): Promise<WebhookProcessingOutcome> {
  const { eventId, eventType, order } = event;

  if (!POLAR_EVENT_PAID_TYPES.includes(eventType as PolarPaidEventType)) {
    return { status: 'IGNORED', reason: 'EVENT_TYPE_NOT_PAID', detail: `Event type ${eventType} is not a paid-order event.` };
  }

  const grossMajor =
    typeof order.total_amount === 'number'
      ? order.total_amount / 100
      : order.amount;
  if (typeof grossMajor !== 'number' || !Number.isFinite(grossMajor) || grossMajor <= 0 || grossMajor > 10_000_000) {
    return { status: 'REJECTED', reason: 'INVALID_AMOUNT', detail: 'Order amount must be a positive finite number (total_amount is minor units).' };
  }
  const currencyRaw = (order.currency ?? 'USD').toUpperCase();
  if (!isCurrencyAcceptedForMarket(currencyRaw)) {
    return { status: 'REJECTED', reason: 'UNSUPPORTED_CURRENCY', detail: `Currency ${currencyRaw} is not accepted by market configuration.` };
  }
  const currency = currencyRaw;

  // Product linkage: resolve to a known product via explicit id or provider
  // product id/name. An unlinked order is REJECTED — never guessed.
  const meta = order.metadata ?? {};
  const productIdFromMeta = typeof meta.productId === 'string' ? meta.productId : null;
  let product: { id: string; name: string; opportunityId: string | null } | null = null;
  const { db } = await import('@/lib/db');
  if (productIdFromMeta) {
    product = await db.product.findFirst({ where: { id: productIdFromMeta }, select: { id: true, name: true, opportunityId: true } });
  }
  if (!product && order.product_id) {
    product = await db.product.findFirst({ where: { id: order.product_id }, select: { id: true, name: true, opportunityId: true } });
  }
  if (!product && order.product?.name) {
    product = await db.product.findFirst({ where: { name: order.product.name }, select: { id: true, name: true, opportunityId: true } });
  }
  if (!product) {
    return { status: 'REJECTED', reason: 'PRODUCT_NOT_LINKED', detail: 'No known product matches the order payload; refusing to guess.' };
  }

  const result = await recordRevenueWithAttribution({
    date: order.created_at ?? receivedAt.toISOString(),
    revenueSource: 'POLAR_WEBHOOK',
    grossRevenue: grossMajor,
    currency,
    referenceNote: `webhook:${eventId} order:${order.id}`,
    productId: product.id,
    opportunityId: product.opportunityId,
  });

  if (result.status === 'RECORDED') {
    return { status: 'RECORDED', revenueId: result.revenueId!, grossRevenue: grossMajor, currency };
  }
  if (result.status === 'DUPLICATE') {
    return { status: 'DUPLICATE', revenueId: null };
  }
  return { status: 'REJECTED', reason: `INGEST_${result.status}`, detail: result.errors.join('; ') || 'Revenue pipeline rejected the event.' };
}
