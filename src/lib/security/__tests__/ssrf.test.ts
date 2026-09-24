// Phase 9 - SSRF protection tests (syntactic + DNS resolution).
// Hermetic: resolvers are injected; no network is touched.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateOrReservedAddress, checkHostSyntax, validatePublicUrl } from '../ssrf';
import { fetchPage } from '@/lib/research/fetcher';

const resolveTo = (addresses: string[]) => async () => addresses;
const resolveFails = async () => {
  throw new Error('ENOTFOUND');
};

describe('address classification', () => {
  it('flags loopback, private, link-local, CGNAT and reserved IPv4 space', () => {
    for (const address of [
      '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1',
      '198.51.100.7', '203.0.113.9', '255.255.255.255', '224.0.0.1', '192.0.2.5',
    ]) {
      assert.equal(isPrivateOrReservedAddress(address), true, address);
    }
  });

  it('allows ordinary public IPv4 addresses', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '203.1.113.9', '172.32.0.1']) {
      assert.equal(isPrivateOrReservedAddress(address), false, address);
    }
  });

  it('flags loopback/ULA/link-local/multicast IPv6 and IPv4-mapped forms', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '2001:db8::1']) {
      assert.equal(isPrivateOrReservedAddress(address), true, address);
    }
    assert.equal(isPrivateOrReservedAddress('2606:4700:4700::1111'), false);
  });

  it('treats unparseable input as unsafe (fail closed)', () => {
    assert.equal(isPrivateOrReservedAddress(''), true);
    assert.equal(isPrivateOrReservedAddress('not-an-address'), true);
  });
});

describe('host syntax guard', () => {
  it('refuses non-http(s) protocols, credentials, and private hosts', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com/x',
      'http://user:pass@example.com/x',
      'http://localhost:3000/admin',
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://[::1]/x',
      'not a url',
    ]) {
      const verdict = checkHostSyntax(url);
      assert.equal(verdict.allowed, false, url);
    }
  });

  it('allows ordinary public https hosts', () => {
    assert.equal(checkHostSyntax('https://example.com/page').allowed, true);
    assert.equal(checkHostSyntax('http://93.184.216.34/page').allowed, true);
  });
});

describe('resolution guard', () => {
  it('blocks a public hostname that resolves into private space (DNS rebinding)', async () => {
    const verdict = await validatePublicUrl('https://looks-public.example/x', { lookup: resolveTo(['10.0.0.7']) });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'PRIVATE_ADDRESS');
  });

  it('blocks when ANY resolved address is private', async () => {
    const verdict = await validatePublicUrl('https://mixed.example/x', { lookup: resolveTo(['93.184.216.34', '127.0.0.1']) });
    assert.equal(verdict.allowed, false);
  });

  it('allows a hostname that resolves only to public addresses', async () => {
    const verdict = await validatePublicUrl('https://example.com/x', { lookup: resolveTo(['93.184.216.34']) });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.addresses, ['93.184.216.34']);
  });

  it('fails closed when resolution fails or returns nothing', async () => {
    const failure = await validatePublicUrl('https://example.com/x', { lookup: resolveFails });
    assert.equal(failure.allowed, false);
    assert.equal(failure.reason, 'DNS_FAILURE');

    const empty = await validatePublicUrl('https://example.com/x', { lookup: resolveTo([]) });
    assert.equal(empty.allowed, false);
    assert.equal(empty.reason, 'NO_ADDRESSES');
  });

  it('never issues a request to a host that resolves privately', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('<html><title>x</title></html>', { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const result = await fetchPage('https://rebind.example/x', {
      fetchImpl,
      dnsLookup: resolveTo(['169.254.169.254']),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, 'blocked_dns');
    assert.equal(calls, 0, 'the transport must not be touched for a blocked host');
  });

  it('proceeds when the resolver returns a public address', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('<html><title>Public page</title></html>', { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const result = await fetchPage('https://example.com/x', {
      fetchImpl,
      dnsLookup: resolveTo(['93.184.216.34']),
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
  });
});
