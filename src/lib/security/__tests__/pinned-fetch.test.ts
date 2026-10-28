// N6: address validation is bound to the real connection (hermetic: local
// servers + injected resolvers, no external network).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pinnedFetch, createPinnedLookup, isSsrfBlockedError } from '@/lib/security/pinned-fetch';
import { isPrivateOrReservedAddress } from '@/lib/security/ssrf';
import { fetchPage } from '@/lib/research/fetcher';

const servers: Server[] = [];
async function localServer(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(String(req.headers.host));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('internal-secret');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, hits };
}
after(() => { for (const s of servers) s.close(); });

describe('pinned connection', () => {
  it('refuses to connect when a public-looking name resolves to loopback — server never sees a request', async () => {
    const { port, hits } = await localServer();
    await assert.rejects(
      pinnedFetch(`http://rebind.example:${port}/`, { pinned: { resolver: async () => ['127.0.0.1'] } }),
      (error: unknown) => isSsrfBlockedError(error),
    );
    assert.equal(hits.length, 0);
  });

  it('refuses when ANY resolved address is private (mixed answer)', async () => {
    const { port, hits } = await localServer();
    await assert.rejects(
      pinnedFetch(`http://mixed.example:${port}/`, { pinned: { resolver: async () => ['93.184.216.34', '10.0.0.5'] } }),
      (error: unknown) => isSsrfBlockedError(error),
    );
    assert.equal(hits.length, 0);
  });

  it('connects to the validated address returned by the resolver, not to system DNS (proves binding)', async () => {
    const { port, hits } = await localServer();
    // Test-only policy override lets the validated address be loopback so the
    // local server can answer; "pinned.example" has no real DNS record.
    const response = await pinnedFetch(`http://pinned.example:${port}/`, {
      pinned: { resolver: async () => ['127.0.0.1'], isAddressBlocked: () => false },
    });
    assert.equal(await response.text(), 'internal-secret');
    assert.deepEqual(hits, [`pinned.example:${port}`]);
  });

  it('a resolver that flips between calls cannot split check from connect (single resolution per connect)', async () => {
    const { hits } = await localServer();
    let calls = 0;
    const resolver = async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    // First (and only) answer is public -> lookup passes it through; the
    // socket targets 93.184.216.34, never the later loopback answer.
    const lookup = createPinnedLookup({ resolver });
    const result = await new Promise<string>((resolve, reject) =>
      lookup('flip.example', { family: 0 } as never, ((err: unknown, address: string) => (err ? reject(err) : resolve(address))) as never));
    assert.equal(result, '93.184.216.34');
    assert.equal(calls, 1);
    assert.equal(hits.length, 0);
  });

  it('refuses IP-literal private hosts and credentials syntactically before any socket opens', async () => {
    await assert.rejects(pinnedFetch('http://127.0.0.1:1/'), (e: unknown) => isSsrfBlockedError(e));
    await assert.rejects(pinnedFetch('http://169.254.169.254/latest/meta-data/'), (e: unknown) => isSsrfBlockedError(e));
    await assert.rejects(pinnedFetch('http://user:pw@example.com/'), (e: unknown) => isSsrfBlockedError(e));
  });
});

describe('fetchPage uses the pinned transport by default', () => {
  it('reports blocked_dns when the connection target is private, and never reaches the server', async () => {
    const { port, hits } = await localServer();
    const result = await fetchPage(`http://rebind2.example:${port}/`, {
      maxRetries: 0,
      // Pre-check resolver says "public" (the classic rebinding setup)...
      dnsLookup: async () => ['93.184.216.34'],
      // ...but the connection-time resolver answers loopback.
      pinned: { resolver: async () => ['127.0.0.1'] },
    });
    // fetchImpl is not injected, so dnsLookup feeds the pre-check while the
    // pinned resolver governs the socket.
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'blocked_dns');
    assert.equal(hits.length, 0);
  });

  it('refuses an https -> http redirect downgrade', async () => {
    const result = await fetchPage('https://example.com/start', {
      maxRetries: 0,
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'http://example.org/next' } })) as typeof fetch,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'blocked_url');
  });

  it('still validates every redirect hop against private targets', async () => {
    const result = await fetchPage('https://example.com/start', {
      maxRetries: 0,
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } })) as typeof fetch,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'blocked_url');
  });
});

describe('IPv6 / reserved classification (N6 gaps)', () => {
  const blocked = [
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::7f00:1', '::10.0.0.1', '2002:7f00:1::1', '2002:a9fe:a9fe::',
    '64:ff9b::7f00:1', '64:ff9b:1::1', '2001::1', '2001:db8::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1',
    'ff02::1', '100::1', '[::1]', 'fe80::1%eth0', '::ffff:169.254.169.254', '1::1', '4000::1', 'not-an-ip', '',
  ];
  for (const address of blocked) it(`blocks ${JSON.stringify(address)}`, () => assert.equal(isPrivateOrReservedAddress(address), true));
  const allowed = ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:81a::200e'];
  for (const address of allowed) it(`allows public ${address}`, () => assert.equal(isPrivateOrReservedAddress(address), false));
});
