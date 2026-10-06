// Display-only labels for storefront surfaces. Never used for logic decisions.

export const OFFER_TYPE_LABELS: Record<string, string> = {
  DIGITAL_PRODUCT: 'Digital product',
  MICRO_SERVICE: 'Micro-service',
  CLIENT_SERVICE: 'Client service',
};

export function offerTypeLabel(type: string): string {
  return OFFER_TYPE_LABELS[type] ?? type;
}
