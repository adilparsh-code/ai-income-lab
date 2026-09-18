// Phase 5.1 — Unified provider-neutral research interface.
//
// A SINGLE contract that all research providers — search/discovery, content
// fetch+extract, and future sources (marketplace, datasets, affiliate, social)
// — implement. The existing SearXNG/Tavily search adapters and the safe HTTP
// fetcher (src/lib/research/search-provider.ts, fetcher.ts) are wrapped as the
// first adapters, so nothing is rebuilt and no behavior changes.
//
// Contract (per Phase 5.1 spec):
//   search(query)   → discovery metadata (SEARCH_DISCOVERY provenance)
//   fetch(url)      → fetched page content (VERIFIED_DATA provenance)
//   extract(page)   → normalized, bounded facts from fetched content
//   health()        → truthful configuration/availability status
//
// Honesty rules (hard invariants):
// - An unconfigured/unavailable provider reports EXPLICITLY
//   (RESEARCH_UNAVAILABLE) — never fabricated results.
// - Search metadata is SEARCH_DISCOVERY; only actually-fetched+validated
//   content is VERIFIED_DATA. No code path can promote one to the other.
// - Provider adapters receive injectable fetch for offline tests.

import { fetchPage, type FetchPageResult } from './fetcher';
import { getSearchProvider, type SearchProvider } from './search-provider';
import { extractExcerpt, extractTitle, domainOf } from './core';

// ---------------------------------------------------------------------------
// Unified evidence shapes (provenance-preserving)
// ---------------------------------------------------------------------------

export type ProviderEvidenceType = 'SEARCH_DISCOVERY' | 'VERIFIED_DATA' | 'AI_INFERENCE' | 'USER_ENTERED' | 'MOCKED';

export interface ProviderDiscovery {
  evidenceType: 'SEARCH_DISCOVERY';
  sourceProvider: string;
  sourceUrl: string;
  sourceTitle: string;
  /** Search-result snippet — never promoted to VERIFIED_DATA. */
  snippet: string;
  retrievedAt: string;
  /** ISO-8601 source publication date when the provider supplies one. */
  publishedAt: string | null;
  freshnessDays: number | null;
  relevance: number | null;
}

export interface ProviderFact {
  /** Normalized, bounded extracted fact from fetched content. */
  fact: string;
  /** Provenance of the fact — VERIFIED_DATA only when actually fetched. */
  evidenceType: 'VERIFIED_DATA';
  confidence: number | null;
}

export interface ProviderPageEvidence {
  evidenceType: 'VERIFIED_DATA';
  sourceProvider: string;
  sourceUrl: string;
  sourceTitle: string;
  domain: string;
  excerpt: string;
  facts: ProviderFact[];
  retrievedAt: string;
  httpStatus: number;
  contentType: string;
  contentLength: number;
  fetchDurationMs: number;
}

// ---------------------------------------------------------------------------
// Health / availability (truthful statuses only)
// ---------------------------------------------------------------------------

export type ResearchProviderStatus = 'AVAILABLE' | 'RESEARCH_UNAVAILABLE' | 'DEGRADED';

export interface ResearchProviderHealth {
  providerId: string | null;
  status: ResearchProviderStatus;
  /** Human-readable configuration guidance; safe to display, no secrets. */
  hint: string;
}

/**
 * Truthful health report for the currently configured provider chain.
 * SearXNG needs no key (always resolvable → AVAILABLE); Tavily requires
 * TAVILY_API_KEY; nothing selected → RESEARCH_UNAVAILABLE with guidance.
 */
export function describeResearchProviderHealth(): ResearchProviderHealth {
  const search = getSearchProvider();
  const configured = describeSelectedProvider();
  if (!search || !configured) {
    return {
      providerId: null,
      status: 'RESEARCH_UNAVAILABLE',
      hint:
        'No research provider is configured. External research is UNAVAILABLE — nothing will be fetched and nothing will be fabricated. '
        + 'Set RESEARCH_SEARCH_PROVIDER=searxng (free, no key; optional RESEARCH_SEARXNG_URL for your own instance) '
        + 'or RESEARCH_SEARCH_PROVIDER=tavily with TAVILY_API_KEY.',
    };
  }
  return {
    providerId: search.id,
    status: 'AVAILABLE',
    hint: '',
  };
}

function describeSelectedProvider(): SearchProvider | null {
  return getSearchProvider();
}

// ---------------------------------------------------------------------------
// The ResearchProvider contract (interface + result shapes)
// ---------------------------------------------------------------------------

export interface ResearchProvider {
  readonly id: string;
  /** Discovery: search-result metadata (never fetched; SEARCH_DISCOVERY). */
  search(query: string, options?: { limit?: number }): Promise<ProviderSearchResult>;
  /** Fetch + validate one page (VERIFIED_DATA when ok). */
  fetch(url: string): Promise<ProviderFetchResult>;
  /** Normalize fetched content into bounded facts. */
  extract(page: ProviderFetchSuccess): ProviderPageEvidence;
  /** Truthful availability status. */
  health(): ResearchProviderHealth;
}

export interface ProviderSearchResult {
  status: 'OK' | 'RESEARCH_UNAVAILABLE' | 'ERROR';
  discovery: ProviderDiscovery[];
  error?: string;
}

export interface ProviderFetchResult {
  ok: boolean;
  page?: ProviderFetchSuccess;
  error?: string;
}

export interface ProviderFetchSuccess {
  url: string;
  finalUrl: string;
  title: string;
  excerpt: string;
  httpStatus: number;
  contentType: string;
  contentLength: number;
  fetchDurationMs: number;
}

// ---------------------------------------------------------------------------
// Default adapter over the EXISTING search + fetch layers (no duplication)
// ---------------------------------------------------------------------------

export function buildDefaultResearchProvider(now: () => Date = () => new Date()): ResearchProvider {
  return new DefaultResearchProvider(getSearchProvider(), now);
}

// ---------------------------------------------------------------------------
// The ResearchProvider contract
// ---------------------------------------------------------------------------

export class DefaultResearchProvider implements ResearchProvider {
  readonly id: string;

  constructor(
    private readonly searchProvider: SearchProvider | null,
    private readonly now: () => Date,
  ) {
    this.id = searchProvider?.id ?? 'unconfigured';
  }

  async search(query: string, options?: { limit?: number }): Promise<ProviderSearchResult> {
    if (!this.searchProvider) {
      // Self-contained honest message: no external resolution, no fabrication.
      return {
        status: 'RESEARCH_UNAVAILABLE',
        discovery: [],
        error:
          'RESEARCH_UNAVAILABLE: no search provider is wired into this provider instance. '
          + 'Nothing was fetched and nothing was fabricated. '
          + 'Set RESEARCH_SEARCH_PROVIDER=searxng (free) or tavily with TAVILY_API_KEY.',
      };
    }
    const result = await this.searchProvider.search(query, { limit: options?.limit });
    if (result.status !== 'OK') {
      return {
        status: result.status === 'NOT_CONFIGURED' ? 'RESEARCH_UNAVAILABLE' : 'ERROR',
        discovery: [],
        error: result.error ?? 'Search provider failed.',
      };
    }
    const nowIso = this.now().toISOString();
    const nowMs = this.now().getTime();
    return {
      status: 'OK',
      discovery: result.results.map((r, index) => {
        const publishedAt = parsePublishedDate(r.snippet);
        return {
          evidenceType: 'SEARCH_DISCOVERY' as const,
          sourceProvider: this.searchProvider!.id,
          sourceUrl: r.url,
          sourceTitle: r.title.slice(0, 200),
          snippet: r.snippet.slice(0, 500),
          retrievedAt: nowIso,
          publishedAt,
          freshnessDays: publishedAt
            ? Math.max(0, Math.round((nowMs - new Date(publishedAt).getTime()) / 86_400_000))
            : null,
          relevance: result.results.length > 0 ? Math.round(((result.results.length - index) / result.results.length) * 100) / 100 : null,
        };
      }),
    };
  }

  async fetch(url: string): Promise<ProviderFetchResult> {
    const result: FetchPageResult = await fetchPage(url);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const title = extractTitle(result.text, url);
    const excerpt = extractExcerpt(result.text, 800);
    return {
      ok: true,
      page: {
        url: result.url,
        finalUrl: result.finalUrl,
        title,
        excerpt,
        httpStatus: result.status,
        contentType: result.contentType,
        contentLength: result.contentLength,
        fetchDurationMs: result.durationMs,
      },
    };
  }

  extract(page: ProviderFetchSuccess): ProviderPageEvidence {
    const sentences = page.excerpt
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 40 && s.length <= 320)
      .slice(0, 6);
    return {
      evidenceType: 'VERIFIED_DATA',
      sourceProvider: this.searchProvider?.id ?? 'direct_fetch',
      sourceUrl: page.url,
      sourceTitle: page.title,
      domain: domainOf(page.url),
      excerpt: page.excerpt,
      facts: sentences.map((fact) => ({
        fact,
        evidenceType: 'VERIFIED_DATA' as const,
        confidence: null,
      })),
      retrievedAt: this.now().toISOString(),
      httpStatus: page.httpStatus,
      contentType: page.contentType,
      contentLength: page.contentLength,
      fetchDurationMs: page.fetchDurationMs,
    };
  }

  health(): ResearchProviderHealth {
    // Truthful about THIS instance's wiring (not the global env): a provider
    // constructed without a wrapped search adapter is unavailable.
    if (!this.searchProvider) {
      return {
        providerId: null,
        status: 'RESEARCH_UNAVAILABLE',
        hint:
          'No search provider is wired into this provider instance. '
          + 'Set RESEARCH_SEARCH_PROVIDER=searxng (free) or tavily with TAVILY_API_KEY.',
      };
    }
    return { providerId: this.searchProvider.id, status: 'AVAILABLE', hint: '' };
  }
}

/**
 * Best-effort ISO date extraction from a snippet (e.g. "2025-11-03", or
 * "Jan 4, 2025"). Purely observational — when absent, freshness is reported
 * as unknown (null) rather than guessed.
 */
export function parsePublishedDate(snippet: string): string | null {
  const iso = snippet.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const candidate = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    if (!Number.isNaN(candidate.getTime()) && candidate.getTime() <= Date.now()) return candidate.toISOString();
  }
  const longForm = snippet.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b/i);
  if (longForm) {
    const candidate = new Date(longForm[0]);
    if (!Number.isNaN(candidate.getTime()) && candidate.getTime() <= Date.now()) return candidate.toISOString();
  }
  return null;
}

/** Internal helper for tests: construct the default provider with a mock search. */
export function buildProviderForTests(searchProvider: SearchProvider | null, now: () => Date): ResearchProvider {
  return new DefaultResearchProvider(searchProvider, now);
}
