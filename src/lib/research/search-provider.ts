// Server-only SearchProvider abstraction for the Real Research Engine.
//
// Providers are replaceable: the Research Agent depends ONLY on the generic
// interface below plus this registry — never on a concrete adapter. Adding a
// provider means adding one adapter class + one registry branch; zero changes
// to agent logic.
//
// Provider policy:
// - SearXNG is the PRIMARY free provider (no API key required). The instance
//   URL is configurable via RESEARCH_SEARXNG_URL (defaults to a public
//   instance); if the instance is unreachable the adapter returns an explicit
//   ERROR — never fabricated results.
// - Tavily is an OPTIONAL provider, active only when TAVILY_API_KEY exists and
//   RESEARCH_SEARCH_PROVIDER=tavily is selected.
// - Brave is a documented FUTURE adapter boundary only — there is deliberately
//   NO Brave implementation or dependency in this codebase. To add one later,
//   implement the SearchProvider interface and register it here.
// - No provider configured / key missing resolves to an explicit
//   NOT_CONFIGURED outcome upstream. Results are never fabricated.
//
// Every adapter accepts an injectable fetch implementation for offline tests.

import { logger } from '@/lib/server-log';
import { isAllowedResearchUrl } from './core';

// ---------------------------------------------------------------------------
// Generic provider contract
// ---------------------------------------------------------------------------

export interface SearchProvider {
  /** Stable id used in logs and result provenance ("searxng", "tavily", ...). */
  readonly id: string;
  /** True when the provider is actually usable (key present / instance set). */
  isConfigured(): boolean;
  /** How to fix configuration, or null when configured. Never echoes secrets. */
  configurationHint(): string | null;
  /** Run one web search. Must never fabricate results. */
  search(
    query: string,
    options?: { limit?: number; timeoutMs?: number },
  ): Promise<SearchProviderResult>;
}

export interface SearchProviderResult {
  status: 'OK' | 'NOT_CONFIGURED' | 'ERROR';
  results: { title: string; url: string; snippet: string }[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Registry (the only place concrete adapters are wired)
// ---------------------------------------------------------------------------

export type SearchProviderId = 'searxng' | 'tavily';

/**
 * Resolve the active search provider id. Env-driven so adapters are swappable
 * without code changes. Default: searxng (free, no key). Unknown/empty values
 * resolve to none (explicit NOT_CONFIGURED upstream).
 */
export function resolveSearchProviderId(): SearchProviderId | null {
  const raw = (process.env.RESEARCH_SEARCH_PROVIDER ?? 'searxng').trim().toLowerCase();
  if (raw === 'searxng' || raw === 'tavily') return raw;
  return null;
}

/** Resolves the active provider, or null when unavailable/unconfigured. */
export function getSearchProvider(fetchImpl: typeof fetch = fetch): SearchProvider | null {
  const id = resolveSearchProviderId();
  if (id === 'searxng') return getSearxngProvider(fetchImpl);
  if (id === 'tavily') return getTavilyProvider(fetchImpl);
  return null;
}

/** Explain the current discovery configuration (safe to show in UI/logs). */
export function describeSearchConfiguration(): { providerId: string | null; configured: boolean; hint: string } {
  const id = resolveSearchProviderId();
  if (!id) {
    return {
      providerId: null,
      configured: false,
      hint:
        'No search provider is selected. Set RESEARCH_SEARCH_PROVIDER=searxng (free) or tavily (requires TAVILY_API_KEY).',
    };
  }
  if (id === 'tavily' && !(process.env.TAVILY_API_KEY ?? '').trim()) {
    return {
      providerId: 'tavily',
      configured: false,
      hint: 'Tavily is selected but TAVILY_API_KEY is not set. Add the key, or switch to RESEARCH_SEARCH_PROVIDER=searxng (free).',
    };
  }
  return { providerId: id, configured: true, hint: '' };
}

// ---------------------------------------------------------------------------
// SearXNG adapter — primary free provider (no API key)
// ---------------------------------------------------------------------------

const DEFAULT_SEARXNG_URL = 'https://searx.be';

export function getSearxngProvider(fetchImpl: typeof fetch = fetch): SearchProvider {
  const baseUrl = (process.env.RESEARCH_SEARXNG_URL ?? '').trim() || DEFAULT_SEARXNG_URL;
  return new SearxngSearchProvider(baseUrl, fetchImpl);
}

export class SearxngSearchProvider implements SearchProvider {
  readonly id = 'searxng';

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  isConfigured(): boolean {
    // SearXNG needs no API key; a base URL is always resolvable.
    return this.baseUrl.length > 0;
  }

  configurationHint(): string | null {
    return null;
  }

  async search(
    query: string,
    options?: { limit?: number; timeoutMs?: number },
  ): Promise<SearchProviderResult> {
    const started = Date.now();
    const limit = Math.min(10, Math.max(1, Math.floor(options?.limit ?? 5)));
    const timeoutMs = Math.min(20000, Math.max(1000, Math.floor(options?.timeoutMs ?? 10000)));

    const endpoint = new URL('/search', this.baseUrl);
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('format', 'json');

    // Phase 8 (Rule 3): bounded retries with backoff for transient outcomes
    // (network errors / 429 / 5xx). Retries never widen limits and never
    // change result semantics; final failure is still an honest ERROR.
    const attempts = 3;
    let backoffMs = 250;
    let response: Response | null = null;
    let transportError: string | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      transportError = null;
      try {
        response = await this.fetchImpl(endpoint, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        transportError = error instanceof Error ? error.message : 'unknown fetch error';
      }
      const retryable =
        transportError !== null ||
        (response !== null && (response.status === 429 || response.status >= 500));
      if (!retryable) break;
      if (attempt < attempts) {
        logger.warn('SearXNG search retrying', { attempt, latencyMs: Date.now() - started });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs *= 2;
      }
    }

    if (response === null) {
      logger.warn('SearXNG search request failed', { latencyMs: Date.now() - started });
      return {
        status: 'ERROR',
        results: [],
        error: `SearXNG request failed: ${(transportError ?? 'unknown').slice(0, 200)}`,
      };
    }

    if (!response.ok) {
      return {
        status: 'ERROR',
        results: [],
        error: `SearXNG instance returned HTTP ${response.status} (many public instances block the JSON API; set RESEARCH_SEARXNG_URL to your own instance)`,
      };
    }

    try {
      const payload = (await response.json()) as SearxngResponse;
      const results = (Array.isArray(payload.results) ? payload.results : [])
        .slice(0, limit)
        .map((r) => ({
          title: typeof r.title === 'string' ? r.title : '',
          url: typeof r.url === 'string' ? r.url : '',
          snippet: typeof r.content === 'string' ? r.content : '',
        }))
        .filter((r) => r.url.length > 0 && isAllowedResearchUrl(r.url));
      return { status: 'OK', results };
    } catch (error) {
      return {
        status: 'ERROR',
        results: [],
        error: `SearXNG returned an unreadable response: ${error instanceof Error ? error.message.slice(0, 150) : 'unknown'}`,
      };
    }
  }
}

interface SearxngResponse {
  results?: { title?: unknown; url?: unknown; content?: unknown }[];
}

// ---------------------------------------------------------------------------
// Tavily adapter — optional (only when TAVILY_API_KEY exists)
// ---------------------------------------------------------------------------

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

/** Returns the Tavily adapter only when TAVILY_API_KEY exists; else null. */
export function getTavilyProvider(fetchImpl: typeof fetch = fetch): SearchProvider | null {
  const apiKey = (process.env.TAVILY_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return new TavilySearchProvider(apiKey, fetchImpl);
}

export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  configurationHint(): string | null {
    return this.isConfigured() ? null : 'Set TAVILY_API_KEY to enable Tavily discovery.';
  }

  async search(
    query: string,
    options?: { limit?: number; timeoutMs?: number },
  ): Promise<SearchProviderResult> {
    const started = Date.now();
    const limit = Math.min(10, Math.max(1, Math.floor(options?.limit ?? 5)));
    const timeoutMs = Math.min(20000, Math.max(1000, Math.floor(options?.timeoutMs ?? 10000)));

    let response: Response;
    try {
      response = await this.fetchImpl(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ api_key: this.apiKey, query, max_results: limit }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown fetch error';
      logger.warn('Tavily search request failed', { latencyMs: Date.now() - started });
      return {
        status: 'ERROR',
        results: [],
        error: `Tavily request failed: ${message.slice(0, 200)}`,
      };
    }

    if (!response.ok) {
      // Never echo the request body or key material in errors.
      return {
        status: 'ERROR',
        results: [],
        error: `Tavily returned HTTP ${response.status}`,
      };
    }

    try {
      const payload = (await response.json()) as TavilyResponse;
      const results = (Array.isArray(payload.results) ? payload.results : [])
        .slice(0, limit)
        .map((r) => ({
          title: typeof r.title === 'string' ? r.title : '',
          url: typeof r.url === 'string' ? r.url : '',
          snippet: typeof r.content === 'string' ? r.content : '',
        }))
        .filter((r) => r.url.length > 0 && isAllowedResearchUrl(r.url));
      return { status: 'OK', results };
    } catch (error) {
      return {
        status: 'ERROR',
        results: [],
        error: `Tavily returned an unreadable response: ${error instanceof Error ? error.message.slice(0, 150) : 'unknown'}`,
      };
    }
  }
}

interface TavilyResponse {
  results?: { title?: unknown; url?: unknown; content?: unknown }[];
}
