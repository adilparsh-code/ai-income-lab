// Phase 9 - Request body hardening.
//
// Two independent protections, because either one alone is bypassable:
//   1. `Content-Length` pre-check - cheap rejection for honest oversized bodies.
//   2. Streaming read with a hard byte cap - defeats a lying/missing
//      Content-Length and chunked transfer encoding.
//
// Nothing here trusts a client-declared value.

export const JSON_CONTENT_TYPE = 'application/json';

/** Does the request declare a JSON (or +json) content type? */
export function hasJsonContentType(request: Request): boolean {
  const raw = request.headers.get('content-type');
  if (!raw) return false;
  const mime = raw.split(';')[0].trim().toLowerCase();
  return mime === JSON_CONTENT_TYPE || mime.endsWith('+json');
}

export type BoundedTextResult =
  | { ok: true; text: string; byteLength: number }
  | { ok: false; reason: 'TOO_LARGE' | 'UNREADABLE'; status: 413 | 400; error: string; byteLength: number };

/**
 * Read the request body as text, refusing anything above `maxBytes`.
 *
 * The stream is consumed incrementally so a hostile body cannot exhaust memory
 * before the cap is enforced.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<BoundedTextResult> {
  const cap = Math.max(1, Math.floor(maxBytes));

  // 1. Cheap pre-check on the declared length.
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10);
    if (Number.isFinite(parsed) && parsed > cap) {
      return {
        ok: false,
        reason: 'TOO_LARGE',
        status: 413,
        error: `Request body exceeds the ${cap}-byte limit for this endpoint.`,
        byteLength: parsed,
      };
    }
  }

  // 2. Streaming read with a hard cap.
  const body = request.body;
  if (!body) {
    try {
      const text = await request.text();
      const byteLength = Buffer.byteLength(text, 'utf8');
      if (byteLength > cap) {
        return { ok: false, reason: 'TOO_LARGE', status: 413, error: `Request body exceeds the ${cap}-byte limit for this endpoint.`, byteLength };
      }
      return { ok: true, text, byteLength };
    } catch {
      return { ok: false, reason: 'UNREADABLE', status: 400, error: 'Request body could not be read.', byteLength: 0 };
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > cap) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: 'TOO_LARGE',
          status: 413,
          error: `Request body exceeds the ${cap}-byte limit for this endpoint.`,
          byteLength: received,
        };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: 'UNREADABLE', status: 400, error: 'Request body could not be read.', byteLength: received };
  }
  return { ok: true, text, byteLength: received };
}

export type BoundedJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413 | 415; error: string };

export interface ReadJsonOptions {
  maxBytes: number;
  /** When true, an empty body is treated as `{}` instead of a parse error. */
  allowEmpty?: boolean;
  /** When true (default), a non-JSON content type is refused with 415. */
  requireJsonContentType?: boolean;
}

/**
 * Read + parse a JSON request body under a byte cap. Never throws.
 *
 * Returns the same shape used by the API boundary so handlers can map it
 * directly onto a response.
 */
export async function readBoundedJson<T = unknown>(request: Request, options: ReadJsonOptions): Promise<BoundedJsonResult<T>> {
  const requireJson = options.requireJsonContentType ?? true;
  if (requireJson && !hasJsonContentType(request)) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json for this endpoint.',
    };
  }

  const bounded = await readBoundedText(request, options.maxBytes);
  if (!bounded.ok) {
    return { ok: false, status: bounded.status, error: bounded.error };
  }
  if (bounded.text.trim().length === 0) {
    if (options.allowEmpty) return { ok: true, value: {} as T };
    return { ok: false, status: 400, error: 'Request body must be valid JSON (it was empty).' };
  }
  try {
    return { ok: true, value: JSON.parse(bounded.text) as T };
  } catch {
    return { ok: false, status: 400, error: 'Request body must be valid JSON.' };
  }
}

/** True when the parsed value is a plain JSON object (not null/array/scalar). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
