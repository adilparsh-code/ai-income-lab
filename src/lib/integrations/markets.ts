// Phase 8 — Market / country configuration (Rule 9).
//
// Represents country, currency, market, platform, provider, availability, and
// requirements WITHOUT duplicating business logic. The core income engine is
// country-agnostic: markets only (a) restrict which provider adapters are
// considered available and (b) label what a caller must configure for a given
// region. No business rule ever branches on this data — it is declarative
// provider metadata.
//
// Privacy/safety: contains no secrets. Availability claims here are
// configuration-level ("this provider is offered in this market"), never a
// claim that a live operation succeeded (Rule 2: LIVE requires a verified
// provider round-trip).

export type MarketRegion = 'IN' | 'GLOBAL';

export type ProviderCategory =
  | 'PAYMENTS'
  | 'PUBLISHING'
  | 'DEPLOYMENT'
  | 'RESEARCH'
  | 'ANALYTICS';

export interface ProviderMarketInfo {
  providerId: string;
  category: ProviderCategory;
  /** Human-readable provider name (safe to display). */
  name: string;
  /** Markets where the provider is offered at the configuration level. */
  markets: readonly MarketRegion[];
  /** Currencies the provider can settle (configuration-level, not a guarantee). */
  currencies: readonly string[];
  /** Server-side env vars required to activate the adapter. */
  requiredEnv: readonly string[];
  /** Server-side env vars required for webhook verification, when applicable. */
  webhookEnv?: readonly string[];
  /** Deterministic requirements/limitations note (display only). */
  requirements: string;
}

/**
 * Provider-market registry. Deliberately declarative: adding a country or a
 * provider means adding an entry here, not changing the income engine.
 */
export const PROVIDER_MARKET_REGISTRY: readonly ProviderMarketInfo[] = [
  {
    providerId: 'polar',
    category: 'PAYMENTS',
    name: 'Polar (merchant of record)',
    markets: ['GLOBAL'],
    currencies: ['USD', 'EUR'],
    requiredEnv: ['POLAR_ACCESS_TOKEN', 'POLAR_ORG_ID'],
    webhookEnv: ['POLAR_WEBHOOK_SECRET'],
    requirements:
      'Merchant-of-record digital products. Settles in USD/EUR; INR is not a settlement currency, '
      + 'but Indian customers can pay internationally. Human approval token is required per publication.',
  },
  {
    providerId: 'vercel',
    category: 'DEPLOYMENT',
    name: 'Vercel',
    markets: ['GLOBAL'],
    currencies: [],
    requiredEnv: ['VERCEL_TOKEN'],
    webhookEnv: [],
    requirements:
      'Website/app deployment. Optional VERCEL_TEAM_ID and VERCEL_PROJECT_ID scope the deployment; '
      + 'human approval token is required per deployment request.',
  },
  {
    providerId: 'searxng',
    category: 'RESEARCH',
    name: 'SearXNG',
    markets: ['GLOBAL'],
    currencies: [],
    requiredEnv: ['RESEARCH_SEARCH_PROVIDER=searxng', 'SEARXNG_BASE_URL'],
    webhookEnv: [],
    requirements: 'Free, self-hostable meta-search. No API key; requires a reachable instance URL.',
  },
  {
    providerId: 'tavily',
    category: 'RESEARCH',
    name: 'Tavily',
    markets: ['GLOBAL'],
    currencies: [],
    requiredEnv: ['TAVILY_API_KEY'],
    webhookEnv: [],
    requirements: 'Research search API with a free tier; key is server-side only.',
  },
];

const DEFAULT_MARKET: MarketRegion = 'GLOBAL';

/** Read the configured market from env (non-secret app configuration). */
export function getConfiguredMarket(): MarketRegion {
  const raw = process.env.AI_INCOME_MARKET?.trim().toUpperCase();
  return raw === 'IN' ? 'IN' : DEFAULT_MARKET;
}

export interface MarketCapability {
  providerId: string;
  category: ProviderCategory;
  name: string;
  available: boolean;
  /** What must be configured/true before this adapter can operate. */
  requirements: string;
  currencies: readonly string[];
}

/**
 * Deterministic: which providers are configuration-available in a market.
 * GLOBAL is the base market every listed provider serves; a specific region
 * (e.g. IN) sees a provider as available when it is offered there either via
 * an explicit region entry or via its GLOBAL coverage.
 */
export function providersForMarket(market: MarketRegion): MarketCapability[] {
  return PROVIDER_MARKET_REGISTRY.map((p) => ({
    providerId: p.providerId,
    category: p.category,
    name: p.name,
    available: p.markets.includes(market) || (market !== 'GLOBAL' && p.markets.includes('GLOBAL')),
    requirements: p.requirements,
    currencies: p.currencies,
  }));
}

/** Registry entry lookup (category + id). */
export function getProviderMarketInfo(providerId: string, category: ProviderCategory): ProviderMarketInfo | null {
  return PROVIDER_MARKET_REGISTRY.find((p) => p.providerId === providerId && p.category === category) ?? null;
}

/**
 * Currency validation helper for ingestion paths: is this currency acceptable
 * for the configured market? Deterministic allow-list; USD always accepted
 * as the system's recording currency.
 */
export function isCurrencyAcceptedForMarket(currency: string, market: MarketRegion = getConfiguredMarket()): boolean {
  const normalized = currency.trim().toUpperCase();
  if (normalized === 'USD') return true;
  const accepted = PROVIDER_MARKET_REGISTRY.flatMap((p) =>
    p.markets.includes(market) ? p.currencies.map((c) => c.toUpperCase()) : [],
  );
  return accepted.includes(normalized);
}
