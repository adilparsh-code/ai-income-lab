// Server-only research engine — shared core.
//
// Provenance model (the core invariant of the Real Research Engine):
// - SEARCH_DISCOVERY: metadata returned by a search provider (title, snippet,
//   url). NEVER fetched; never VERIFIED_DATA. Carries `retrievedAt` only.
// - VERIFIED_DATA: content actually fetched from the origin over HTTP and
//   passing validation. Carries fetch metadata (httpStatus, contentType,
//   contentLength, fetchedAt, fetchDurationMs).
// - AI interpretation of evidence stays AI_INFERENCE. AI can summarize or
//   classify evidence but can NEVER upgrade SEARCH_DISCOVERY (or anything
//   else) into VERIFIED_DATA. No code path exists for that upgrade here.
//
// This module stays dependency-free (no db, no fetch, no React) so it is
// unit-testable offline and importable from server and client surfaces.

// ---------------------------------------------------------------------------
// Provenance types
// ---------------------------------------------------------------------------

export const SEARCH_DISCOVERY = 'SEARCH_DISCOVERY';
export const VERIFIED_DATA = 'VERIFIED_DATA';
export const AI_INFERENCE = 'AI_INFERENCE';

export type SearchDiscoveryType = typeof SEARCH_DISCOVERY;
export type VerifiedDataType = typeof VERIFIED_DATA;
export type AiInferenceType = typeof AI_INFERENCE;

/** Evidence produced by a search provider (never fetched). */
export type SourceDiscovery = {
  readonly evidenceType: SearchDiscoveryType;
  readonly url: string;
  readonly domain: string;
  readonly title: string;
  readonly snippet: string;
  readonly retrievedAt: string; // ISO 8601
};

/** Evidence fetched and validated from a real source. */
export type SourceEvidence = {
  readonly evidenceType: VerifiedDataType;
  readonly url: string;
  readonly domain: string;
  title: string;
  excerpt: string;
  readonly httpStatus: number;
  readonly contentType: string;
  /** Byte size of the fetched body (after size-limit enforcement). */
  readonly contentLength: number;
  readonly fetchedAt: string; // ISO 8601
  readonly fetchDurationMs: number;
};

/** AI interpretation over evidence — always AI_INFERENCE, never VERIFIED_DATA. */
export type AiInterpretation = {
  readonly evidenceType: AiInferenceType;
  summary: string;
  risks: string[];
  assumptions: string[];
  validationQuestions: string[];
  nextAction: string;
};

export interface ResearchRequestOptions {
  objective: string;
  opportunityId?: string;
  query?: string;
  maxSources: number;
  maxFetches: number;
  includeAiSynthesis: boolean;
}

export interface ResearchSourceResult {
  status: 'OK' | 'PARTIAL' | 'NOT_CONFIGURED' | 'BLOCKED' | 'FAILED';
  discovery: SourceDiscovery[];
  evidence: SourceEvidence[];
  ai: AiInterpretation | null;
  sourcesDiscovered: number;
  sourcesFetched: number;
  sourcesSucceeded: number;
  fetchErrors: string[];
  reasoning: string;
  humanReviewRequired: boolean;
  /** Which search provider served discovery (for provenance display). */
  searchProviderId: string | null;
  /** How results were served: 'live' (network) or 'cache' (previously fetched). */
  servedFrom: 'live' | 'cache' | 'none';
  /** Wall-clock duration of the whole research pass (ms). */
  executionTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Safe URL guard (SSRF + protocol + host allow/deny controls)
// ---------------------------------------------------------------------------

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd[0-9a-f]{2}:/i,
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
];

export function isAllowedResearchUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return false;
  if (BLOCKED_HOSTNAMES.includes(host)) return false;
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) return false;
  return true;
}

/** Registrable-looking domain (host minus leading "www."). Never throws. */
export function domainOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Text extraction helpers (pure)
// ---------------------------------------------------------------------------

/** Extract a human title from fetched HTML: <title>, first <h1>, or fallback. */
export function extractTitle(html: string, fallback: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1].trim().length > 0) return decodeEntities(titleMatch[1]).slice(0, 200);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match && h1Match[1].trim().length > 0) return decodeEntities(h1Match[1]).slice(0, 200);
  return fallback.slice(0, 200);
}

const BLOCK_TAGS =
  /<(script|style|noscript|svg|iframe|nav|footer|header|form|template|canvas)[^>]*>[\s\S]*?<\/\1>/gi;

/** Strip tags/scripts and collapse whitespace into a plain-text excerpt. */
export function extractExcerpt(html: string, maxChars = 600): string {
  let text = html.replace(BLOCK_TAGS, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
