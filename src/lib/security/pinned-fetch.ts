// SSRF hardening (audit N6): bind address validation to the ACTUAL connection.
//
// Validating a hostname and then calling fetch(hostname) is a TOCTOU bug: the
// HTTP client resolves the name again, so a hostile DNS server (TTL 0) can
// answer "public" for the check and "169.254.169.254" for the connection
// (DNS rebinding). Here the check happens INSIDE the socket's own lookup, and
// the validated address is the one the socket connects to. TLS still
// verifies the certificate against the original hostname (SNI is unchanged).
//
// Uses undici's documented `Agent({ connect: { lookup } })` extension point —
// no monkey-patching of node internals.
//
// Not covered by this layer (callers keep doing them): protocol/credential
// syntax checks (checkHostSyntax), manual redirect validation, size/time caps.
// IP-literal hosts never hit DNS, so callers MUST run checkHostSyntax first;
// pinnedFetch does this itself.

import { Agent, fetch as undiciFetch } from 'undici';
import type { LookupFunction } from 'node:net';
import { checkHostSyntax, isPrivateOrReservedAddress, systemDnsLookup, type DnsLookup } from '@/lib/security/ssrf';

export const SSRF_BLOCKED_CODE = 'ESSRF_BLOCKED';

export class SsrfBlockedError extends Error {
  readonly code = SSRF_BLOCKED_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface PinnedLookupOptions {
  /** Resolver (injectable for hermetic tests). Defaults to the system resolver. */
  resolver?: DnsLookup;
  /** TEST ONLY: override the address policy. Production never passes this. */
  isAddressBlocked?: (address: string) => boolean;
}

/**
 * Build the socket-level lookup. It resolves ONCE per connection attempt,
 * refuses if ANY returned address is private/reserved, and hands the socket
 * only the validated addresses — so the connection cannot go anywhere else.
 */
export function createPinnedLookup(options: PinnedLookupOptions = {}): LookupFunction {
  const resolver = options.resolver ?? systemDnsLookup;
  const blocked = options.isAddressBlocked ?? isPrivateOrReservedAddress;

  return ((hostname: string, lookupOptions: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    resolver(hostname)
      .then((addresses) => {
        if (!Array.isArray(addresses) || addresses.length === 0) {
          throw new SsrfBlockedError(`Host "${hostname}" resolved to no addresses.`);
        }
        if (addresses.some((address) => blocked(address))) {
          throw new SsrfBlockedError(`Host "${hostname}" resolves to a private/reserved address; connection refused.`);
        }
        const family = lookupOptions?.family;
        const usable = addresses.filter((a) => (family === 4 ? !a.includes(':') : family === 6 ? a.includes(':') : true));
        if (usable.length === 0) throw new SsrfBlockedError(`Host "${hostname}" has no usable address for the requested family.`);
        const entries = usable.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
        if (lookupOptions?.all) callback(null, entries);
        else callback(null, entries[0].address, entries[0].family);
      })
      .catch((error: unknown) => {
        callback(error instanceof SsrfBlockedError ? error : new SsrfBlockedError(`Host "${hostname}" could not be resolved safely.`));
      });
  }) as unknown as LookupFunction;
}

export function createPinnedDispatcher(options: PinnedLookupOptions & { timeoutMs?: number } = {}): Agent {
  const timeout = options.timeoutMs ?? 10_000;
  return new Agent({
    connect: { lookup: createPinnedLookup(options), timeout },
    headersTimeout: timeout,
    bodyTimeout: timeout,
    // Redirects are validated manually by callers (redirect: 'manual').
    maxRedirections: 0,
    // No connection reuse across hops: each hop is re-resolved and re-validated.
    pipelining: 0,
    keepAliveTimeout: 1,
  } as ConstructorParameters<typeof Agent>[0]);
}

/** True when the error (or its cause) is an SSRF block raised by the pinned lookup. */
export function isSsrfBlockedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === SSRF_BLOCKED_CODE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * fetch() whose every connection is address-validated at connect time.
 * Pass redirect:'manual' and validate hops yourself; each hop calls this again.
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit & { pinned?: PinnedLookupOptions & { timeoutMs?: number } } = {},
): Promise<Response> {
  const syntax = checkHostSyntax(url);
  if (!syntax.allowed) throw new SsrfBlockedError(syntax.detail ?? 'URL refused by SSRF syntax guard.');
  const { pinned, ...rest } = init;
  const dispatcher = createPinnedDispatcher(pinned);
  try {
    const response = await undiciFetch(url, { ...(rest as object), dispatcher } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  } finally {
    // close() is graceful: it lets the in-flight response body finish streaming.
    void dispatcher.close().catch(() => undefined);
  }
}
