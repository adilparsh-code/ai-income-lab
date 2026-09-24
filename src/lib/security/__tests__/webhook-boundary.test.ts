// Phase 9 (additive) — payment webhook boundary tests.
//
// Complements the existing security regression suite with the two properties
// this change adds:
//   1. the raw webhook body is bounded before signature verification, and
//   2. a failed signature with no legacy signature header is classified as
//      BAD_SIGNATURE (not MISSING_HEADERS).
//
// Hermetic: crypto is real HMAC over synthetic bodies; DATABASE_URL points at a
// throwaway file so the audit write is a no-op failure; no network is touched.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-webhook-'));
process.env.DATABASE_URL = 'file:' + join(tempDir, 'audit.db');

const SECRET = 'whsec_…tion';

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function sign(msgId: string, timestamp: number, body: string): string {
  return createHmac('sha256', SECRET).update(`${msgId}.${timestamp}.${body}`).digest('base64');
}

function webhookRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://app.example.com/api/webhooks/polar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('payment webhook body bound', () => {
  it('refuses an oversized raw body with 413 before verification', async () => {
    delete process.env.POLAR_WEBHOOK_SECRET;
    const { POST } = await import('@/app/api/webhooks/polar/route');
    const res = await POST(webhookRequest('x'.repeat(1_100_000)));
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'PAYLOAD_TOO_LARGE');
  });
});

describe('payment webhook signature verdicts', () => {
  it('fails closed with 503 MISSING_SECRET when no secret is configured', async () => {
    delete process.env.POLAR_WEBHOOK_SECRET;
    const { POST } = await import('@/app/api/webhooks/polar/route');
    const res = await POST(
      webhookRequest(JSON.stringify({ id: 'evt_1', type: 'order.paid' }), {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,AAAA',
      }),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'MISSING_SECRET');
  });

  it('classifies a bad signature as BAD_SIGNATURE (not MISSING_HEADERS)', async () => {
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
    try {
      const { POST } = await import('@/app/api/webhooks/polar/route');
      const now = Math.floor(Date.now() / 1000);
      const res = await POST(
        webhookRequest(JSON.stringify({ id: 'evt_2', type: 'order.paid' }), {
          'webhook-id': 'msg_2',
          'webhook-timestamp': String(now),
          'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'BAD_SIGNATURE');
      assert.ok(!JSON.stringify(body).includes(SECRET), 'the secret must never appear in a response');
    } finally {
      delete process.env.POLAR_WEBHOOK_SECRET;
    }
  });

  it('rejects a stale timestamp (replay protection)', async () => {
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
    try {
      const { POST } = await import('@/app/api/webhooks/polar/route');
      const stale = Math.floor(Date.now() / 1000) - 3_600;
      const raw = JSON.stringify({ id: 'evt_3', type: 'order.paid' });
      const res = await POST(
        webhookRequest(raw, {
          'webhook-id': 'msg_3',
          'webhook-timestamp': String(stale),
          'webhook-signature': `v1,${sign('msg_3', stale, raw)}`,
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'STALE_TIMESTAMP');
    } finally {
      delete process.env.POLAR_WEBHOOK_SECRET;
    }
  });

  it('accepts a correctly signed non-paid event and ignores it without touching the ledger', async () => {
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
    try {
      const { POST } = await import('@/app/api/webhooks/polar/route');
      const now = Math.floor(Date.now() / 1000);
      const raw = JSON.stringify({ id: 'evt_4', type: 'refund.created', data: { id: 'order_9' } });
      const res = await POST(
        webhookRequest(raw, {
          'webhook-id': 'msg_4',
          'webhook-timestamp': String(now),
          'webhook-signature': `v1,${sign('msg_4', now, raw)}`,
        }),
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        status: string;
        outcome?: { status: string; reason?: string };
      };
      assert.equal(body.ok, true);
      assert.equal(body.status, 'IGNORED');
      assert.equal(body.outcome?.reason, 'EVENT_TYPE_NOT_PAID');
    } finally {
      delete process.env.POLAR_WEBHOOK_SECRET;
    }
  });
});
