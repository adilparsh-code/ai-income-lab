// Phase 9 - Request body + origin (CSRF) boundary tests.
// Hermetic: no database, no network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoundedText,
  readBoundedJson,
  hasJsonContentType,
  isJsonObject,
} from '../body';

const LIMIT = 1_024;

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('content-type detection', () => {
  it('accepts application/json and +json, rejects others', () => {
    assert.equal(hasJsonContentType(jsonRequest('{}')), true);
    const vendor = new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/vnd.api+json' }, body: '{}' });
    assert.equal(hasJsonContentType(vendor), true);
    const text = new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(hasJsonContentType(text), false);
  });
});

describe('readBoundedText', () => {
  it('rejects an oversized declared Content-Length without reading the body', async () => {
    const request = jsonRequest('{}', { 'Content-Length': String(LIMIT + 1) });
    const result = await readBoundedText(request, LIMIT);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'TOO_LARGE');
      assert.equal(result.status, 413);
    }
  });

  it('rejects an oversized streamed body (no Content-Length to lie about)', async () => {
    const payload = 'a'.repeat(LIMIT * 4);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    // A stream body has no Content-Length: the cap must still hold.
    const request = new Request('http://localhost/api/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: string });
    assert.equal(request.headers.get('content-length'), null);
    const result = await readBoundedText(request, LIMIT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 413);
  });

  it('accepts a body exactly at the limit', async () => {
    const body = 'x'.repeat(LIMIT);
    const result = await readBoundedText(jsonRequest(body), LIMIT);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.byteLength, LIMIT);
  });
});

describe('readBoundedJson', () => {
  it('refuses a non-JSON content type with 415', async () => {
    const request = new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"a":1}',
    });
    const result = await readBoundedJson(request, { maxBytes: LIMIT });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 415);
  });

  it('refuses malformed JSON with 400', async () => {
    const result = await readBoundedJson(jsonRequest('{"a": '), { maxBytes: LIMIT });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  });

  it('refuses an empty body unless empty is explicitly allowed', async () => {
    const strict = await readBoundedJson(jsonRequest(''), { maxBytes: LIMIT });
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.equal(strict.status, 400);

    const lenient = await readBoundedJson(jsonRequest(''), { maxBytes: LIMIT, allowEmpty: true });
    assert.equal(lenient.ok, true);
    if (lenient.ok) assert.deepEqual(lenient.value, {});
  });

  it('treats SQL-injection payloads as inert data (never as SQL)', async () => {
    const payload = { title: "'; DROP TABLE users; --", note: "1' OR '1'='1", nested: { raw: 'UNION SELECT password FROM users' } };
    const result = await readBoundedJson(jsonRequest(JSON.stringify(payload)), { maxBytes: LIMIT });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, payload, 'the payload round-trips as untouched data');
      assert.equal(isJsonObject(result.value), true);
    }
  });

  it('rejects an oversized payload with 413 even when it is valid JSON', async () => {
    const big = JSON.stringify({ blob: 'y'.repeat(LIMIT * 2) });
    const result = await readBoundedJson(jsonRequest(big), { maxBytes: LIMIT });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 413);
  });
});
