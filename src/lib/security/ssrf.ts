// Phase 9 - SSRF protection (hardened).
//
// The research fetcher already refuses syntactically private hosts. That is
// necessary but not sufficient: a public hostname can resolve to a private
// address (DNS rebinding / hostile A records / a CNAME into RFC1918 space).
// This module adds the second layer:
//
//   1. Syntactic guard  - protocol + hostname rules (no localhost, no RFC1918,
//      no link-local/metadata, no unique-local IPv6, ...).
//   2. Resolution guard - resolve the hostname and refuse when ANY returned
//      address is private, loopback, link-local, multicast, or reserved.
//
// Failure posture: FAIL CLOSED. A resolution failure blocks the fetch (the
// request would fail anyway) so a DNS-based bypass can never be met with a
// "could not resolve, proceeding anyway".

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export interface SsrfVerdict {
  allowed: boolean;
  reason?: 'BAD_PROTOCOL' | 'BAD_HOSTNAME' | 'PRIVATE_ADDRESS' | 'DNS_FAILURE' | 'NO_ADDRESSES';
  detail?: string;
  /** Resolved addresses (audit only). */
  addresses?: string[];
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function isPrivateIpv4(ip: string): boolean {
  const match = IPV4_PATTERN.exec(ip);
  if (!match) return false;
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (octets.some((o) => !Number.isFinite(o) || o < 0 || o > 255)) return true; // malformed -> treat as unsafe
  const [a, b] = octets;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 (IETF/TEST-NET)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0) return true; // 203.0.113/24 TEST-NET-3
  if (a === 255) return true; // broadcast
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
  return false;
}

/** Normalize an IPv6 literal (lowercase, no zone id, no brackets). */
function normalizeIpv6(ip: string): string {
  return ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
}

/** Extract an embedded IPv4 address from IPv4-mapped/compatible IPv6 forms. */
function embeddedIpv4(ip: string): string | null {
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (dotted) return dotted[1];
  const hexTail = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexTail) {
    const hi = Number.parseInt(hexTail[1], 16);
    const lo = Number.parseInt(hexTail[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = normalizeIpv6(ip);
  if (!normalized.includes(':')) return false;

  // IPv4-mapped / IPv4-compatible: classify by the embedded IPv4 address.
  const embedded = embeddedIpv4(normalized);
  if (embedded) return isPrivateIpv4(embedded);

  if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true; // ff00::/8 multicast
  if (/^2001:0?db8:/.test(normalized)) return true; // documentation range
  if (/^64:ff9b:/.test(normalized)) return true; // NAT64 well-known prefix
  return false;
}

/** True when `address` is a private/reserved/loopback/link-local address. */
export function isPrivateOrReservedAddress(address: string): boolean {
  const value = typeof address === 'string' ? address.trim() : '';
  if (value.length === 0) return true;
  if (IPV4_PATTERN.test(value)) return isPrivateIpv4(value);
  if (value.includes(':')) return isPrivateIpv6(value);
  // Not recognizable as an IP literal: refuse (fail closed) rather than skip.
  return true;
}

// ---------------------------------------------------------------------------
// Hostname-level guard (reuses the research core rules, plus extras)
// ---------------------------------------------------------------------------

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd[0-9a-f]{2}:/i,
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '169.254.169.254',
  'metadata',
]);

/** Purely syntactic host/protocol check (no DNS). */
export function checkHostSyntax(rawUrl: string): SsrfVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'BAD_HOSTNAME', detail: 'URL could not be parsed.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'BAD_PROTOCOL', detail: 'Only http(s) URLs may be fetched.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return { allowed: false, reason: 'BAD_HOSTNAME', detail: 'URL has no host.' };
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { allowed: false, reason: 'BAD_HOSTNAME', detail: 'URLs with embedded credentials are refused.' };
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { allowed: false, reason: 'PRIVATE_ADDRESS', detail: `Host "${host}" is a blocked hostname.` };
  }
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return { allowed: false, reason: 'PRIVATE_ADDRESS', detail: `Host "${host}" is in a private/reserved range.` };
  }
  if (IPV4_PATTERN.test(host) && isPrivateIpv4(host)) {
    return { allowed: false, reason: 'PRIVATE_ADDRESS', detail: `Host "${host}" is a private IPv4 address.` };
  }
  if (host.includes(':') && isPrivateIpv6(host)) {
    return { allowed: false, reason: 'PRIVATE_ADDRESS', detail: `Host "${host}" is a private IPv6 address.` };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Resolution guard
// ---------------------------------------------------------------------------

export type DnsLookup = (hostname: string) => Promise<string[]>;

/** Default resolver: every address the name resolves to. */
export const systemDnsLookup: DnsLookup = async (hostname) => {
  const { promises: dns } = await import('node:dns');
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/**
 * Full SSRF validation: syntax first, then DNS.
 * `lookup` is injectable so tests never touch the network.
 */
export async function validatePublicUrl(
  rawUrl: string,
  options: { lookup?: DnsLookup } = {},
): Promise<SsrfVerdict> {
  const syntax = checkHostSyntax(rawUrl);
  if (!syntax.allowed) return syntax;

  const host = new URL(rawUrl).hostname.toLowerCase();
  // IP literals are already fully classified by the syntax pass.
  if (IPV4_PATTERN.test(host) || host.includes(':')) return { allowed: true, addresses: [host] };

  const lookup = options.lookup ?? systemDnsLookup;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return { allowed: false, reason: 'DNS_FAILURE', detail: `Host "${host}" could not be resolved; refusing to fetch.` };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { allowed: false, reason: 'NO_ADDRESSES', detail: `Host "${host}" resolved to no addresses.` };
  }
  const offenders = addresses.filter((address) => isPrivateOrReservedAddress(address));
  if (offenders.length > 0) {
    return {
      allowed: false,
      reason: 'PRIVATE_ADDRESS',
      detail: `Host "${host}" resolves to a private/reserved address; refusing to fetch.`,
      addresses,
    };
  }
  return { allowed: true, addresses };
}
