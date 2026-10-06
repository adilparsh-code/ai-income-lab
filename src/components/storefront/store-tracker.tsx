'use client';

import { useEffect, useRef } from 'react';
import { trackStoreEvent } from '@/lib/storefront/track';

/**
 * Records exactly one PRODUCT_VIEW per mounted offer page through the existing
 * /api/events ingestion (fire-and-forget; StrictMode double-invoke guarded).
 * Renders nothing.
 */
export function StoreTracker({ productId }: { productId?: string | null }) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (!productId || firedRef.current) return;
    firedRef.current = true;
    trackStoreEvent('PRODUCT_VIEW', productId);
  }, [productId]);

  return null;
}
