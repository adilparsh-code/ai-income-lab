// ============================================================================
// STOREFRONT TRACKING (client) — funnel events through the EXISTING ingestion.
// ============================================================================
// Reuses POST /api/events (public, rate-limited, idempotent). Never blocks or
// fails the buyer's flow: every call is fire-and-forget and swallows errors.
// Only first-party, non-PII data is sent (productId + page path).
// ============================================================================

type StoreEventType = 'PRODUCT_VIEW' | 'CTA_CLICK';

export function trackStoreEvent(eventType: StoreEventType, productId: string): void {
  try {
    const key =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    void fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        productId,
        idempotencyKey: `store:${key}`,
        source: 'storefront',
        landingPage: typeof window !== 'undefined' ? window.location.pathname : '/store',
      }),
    }).catch(() => {
      /* instrumentation never interrupts a purchase */
    });
  } catch {
    /* instrumentation never interrupts a purchase */
  }
}
