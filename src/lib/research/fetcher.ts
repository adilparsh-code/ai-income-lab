// Server-only safe HTTP fetcher for the Real Research Engine.
//
// Safety properties:
// - URL guard on every hop (SSRF: no localhost/private/link-local/metadata).
// - Manual redirect handling: each hop is validated before being followed.
// - Per-attempt timeout via AbortSignal; bounded retries with exponential
//   backoff only for retryable outcomes (network/timeout/5xx/429).
// - Streaming size limit: the body is read incrementally and truncated at
//   maxBytes, so a hostile huge response cannot exhaust memory.
// - Content-type validation: only textual content can be researched.
// - Errors are clear, bounded, and redacted of key-like material. Env values
//   and secrets are never included in errors.

import { isAllowedResearchUrl } from './core';

export type FetchErrorCategory =
  | 'blocked_url'
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'size_limit'
  | 'invalid_content';

export type FetchPageResult =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      contentLength: number;
      text: string;
      durationMs: number;
      attempts: number;
    }
  | {
      ok: false;
      url: string;
      category: FetchErrorCategory;
      error: string;
      httpStatus?: number;
      contentType?: string;
      durationMs: number;
      attempts: number;
    };

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRetries?: number;
  /** Injectable fetch for offline tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KiB per page
const DEFAULT_MAX_RETRIES = 2;
const MAX_REDIRECTS = 3;

const TEXTUAL_CONTENT = /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json))/i;

const KEY_LIKE_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_\-]{10,}/g,
  /sk-[A-Za-z0-9_\-]{10,}/g,
  /key=[A-Za-z0-9_\-]{10,}/gi,
  /(?:api[_-]?key|token|password|secret)\s*[=:]\s*["']?[A-Za-z0-9_\-./:@]{8,}/gi,
];

function redact(text: string): string {
  let out = text;
  for (const pattern of KEY_LIKE_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw).slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Read the body incrementally, capping at maxBytes (+1 to detect overflow). */
async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    return { text: text.slice(0, maxBytes), bytes, truncated: bytes > maxBytes };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let text = '';
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        truncated = true;
        void reader.cancel().catch(() => undefined);
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!truncated) void reader.cancel().catch(() => undefined);
  }
  if (!truncated) text += decoder.decode();
  // When truncated, report the capped size — the overflowing tail was discarded.
  return { text, bytes: Math.min(received, maxBytes), truncated };
}

/**
 * Fetch one web page safely. Never throws: every failure is returned as a
 * structured result with a category, so callers can surface precise, safe
 * errors and aggregate partial success.
 */
export async function fetchPage(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchPageResult> {
  const started = Date.now();
  const timeoutMs = Math.min(30_000, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.min(2 * 1024 * 1024, Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES));
  const maxRetries = Math.min(5, Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES));
  const doFetch = options.fetchImpl ?? fetch;

  if (!isAllowedResearchUrl(rawUrl)) {
    return {
      ok: false,
      url: rawUrl,
      category: 'blocked_url',
      error: 'URL is not allowed: only public http(s) URLs on non-private hosts can be fetched.',
      durationMs: Date.now() - started,
      attempts: 0,
    };
  }

  const errors: string[] = [];
  let attempts = 0;
  let lastCategory: FetchErrorCategory = 'network';

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attempts = attempt;
    const outcome = await attemptOnce(rawUrl, { timeoutMs, maxBytes, doFetch, started });
    if (outcome.ok) return { ...outcome, attempts };

    lastCategory = outcome.category;
    errors.push(`Attempt ${attempt}: ${outcome.error}`);

    const retryable =
      outcome.category === 'timeout' ||
      outcome.category === 'network' ||
      (outcome.category === 'http_error' && typeof outcome.httpStatus === 'number' && isRetryableStatus(outcome.httpStatus));
    if (!retryable || attempt >= maxRetries + 1) break;
    await sleep(Math.min(4000, 300 * 2 ** (attempt - 1)));
  }

  return {
    ok: false,
    url: rawUrl,
    category: lastCategory,
    error: errors[errors.length - 1] ?? 'Fetch failed',
    durationMs: Date.now() - started,
    attempts,
  };
}

async function attemptOnce(
  rawUrl: string,
  ctx: { timeoutMs: number; maxBytes: number; doFetch: typeof fetch; started: number },
): Promise<FetchPageResult> {
  let currentUrl = rawUrl;

  // Manual redirect loop: every hop is re-validated (a public URL must never
  // redirect us into internal/private infrastructure).
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedResearchUrl(currentUrl)) {
      return {
        ok: false,
        url: rawUrl,
        category: 'blocked_url',
        error: 'Redirect target is not allowed: only public http(s) URLs on non-private hosts can be fetched.',
        durationMs: Date.now() - ctx.started,
        attempts: 1,
      };
    }

    let response: Response;
    try {
      response = await ctx.doFetch(currentUrl, {
        headers: {
          // Polite, honest UA; no cookies, no credentials of any kind.
          'User-Agent': 'AIIncomeLab-ResearchBot/1.0 (+https://ai-income-lab.local; research evidence collection)',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
    } catch (error) {
      const message = describe(error);
      const isTimeout = /(?:timed?\s?out|abort)/i.test(message) || (error instanceof Error && error.name === 'TimeoutError');
      return {
        ok: false,
        url: rawUrl,
        category: isTimeout ? 'timeout' : 'network',
        error: isTimeout ? `Request timed out after ${ctx.timeoutMs}ms` : `Network error: ${message}`,
        durationMs: Date.now() - ctx.started,
        attempts: 1,
      };
    }

    // 3xx: follow manually with re-validation.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return {
          ok: false,
          url: rawUrl,
          category: 'http_error',
          httpStatus: response.status,
          error: `HTTP ${response.status} redirect without a Location header`,
          durationMs: Date.now() - ctx.started,
          attempts: 1,
        };
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return {
          ok: false,
          url: rawUrl,
          category: 'blocked_url',
          error: 'Redirect Location header could not be parsed as a URL',
          durationMs: Date.now() - ctx.started,
          attempts: 1,
        };
      }
      continue;
    }

    const contentType = (response.headers.get('content-type') ?? 'unknown').split(';')[0].trim();

    if (!response.ok) {
      return {
        ok: false,
        url: rawUrl,
        category: 'http_error',
        httpStatus: response.status,
        contentType,
        error: `HTTP ${response.status} from origin`,
        durationMs: Date.now() - ctx.started,
        attempts: 1,
      };
    }

    if (!TEXTUAL_CONTENT.test(contentType)) {
      return {
        ok: false,
        url: rawUrl,
        category: 'invalid_content',
        httpStatus: response.status,
        contentType,
        error: `Unsupported content type "${contentType}": only textual content can be researched.`,
        durationMs: Date.now() - ctx.started,
        attempts: 1,
      };
    }

    const body = await readCappedBody(response, ctx.maxBytes);
    if (body.bytes === 0) {
      return {
        ok: false,
        url: rawUrl,
        category: 'invalid_content',
        httpStatus: response.status,
        contentType,
        error: 'Origin returned an empty body',
        durationMs: Date.now() - ctx.started,
        attempts: 1,
      };
    }

    return {
      ok: true,
      url: rawUrl,
      finalUrl: response.url || currentUrl,
      status: response.status,
      contentType,
      contentLength: body.bytes,
      text: body.text,
      durationMs: Date.now() - ctx.started,
      attempts: 1,
    };
  }

  return {
    ok: false,
    url: rawUrl,
    category: 'http_error',
    error: `Too many redirects (more than ${MAX_REDIRECTS})`,
    durationMs: Date.now() - ctx.started,
    attempts: 1,
  };
}
