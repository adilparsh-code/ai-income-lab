// Phase 8 — Webhook verification + event processing tests (Rule 8).
// All crypto is real HMAC over synthetic bodies; no network access.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  verifyStandardWebhook,
  verifyLegacyPolarWebhook,
  verifyProviderWebhook,
  type WebhookHeaders,
} from '../webhook-verification';
import { parseVerifiedEventBody, processVerifiedPaymentEvent, POLAR_EVENT_PAID_TYPES } from '../webhook-events';

const SECRET = 'whsec_test_secret_for_verification';
const NOW = 1_700_000_000;

function sign(secret: string, msgId: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${msgId}.${timestamp}.${body}`).digest('base64');
}

function standardHeaders(msgId: string, body: string, ts = NOW): WebhookHeaders {
  return {
    webhookId: msgId,
    webhookTimestamp: String(ts),
    webhookSignature: `v1,${sign(SECRET, msgId, ts, body)}`,
  };
}

describe('standard webhooks verification', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'order.paid' });

  it('verifies a correctly signed request', () => {
    const verdict = verifyStandardWebhook({ secret: SECRET, rawBody: body, headers: standardHeaders('msg_1', body), nowSec: NOW });
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.msgId, 'msg_1');
  });

  it('verifies without the v1, prefix and with multiple candidates', () => {
    const good = sign(SECRET, 'msg_2', NOW, body);
    const verdict = verifyStandardWebhook({
      secret: SECRET,
      rawBody: body,
      headers: { webhookId: 'msg_2', webhookTimestamp: String(NOW), webhookSignature: `v1,AAAA ${good}` },
      nowSec: NOW,
    });
    assert.equal(verdict.ok, true);
  });

  it('rejects a tampered body', () => {
    const verdict = verifyStandardWebhook({
      secret: SECRET,
      rawBody: JSON.stringify({ id: 'evt_1', type: 'order.paid', tampered: true }),
      headers: standardHeaders('msg_1', body),
      nowSec: NOW,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, 'BAD_SIGNATURE');
  });

  it('rejects a stale timestamp (replay protection)', () => {
    const stale = NOW - 3600;
    const verdict = verifyStandardWebhook({ secret: SECRET, rawBody: body, headers: standardHeaders('msg_1', body, stale), nowSec: NOW });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, 'STALE_TIMESTAMP');
  });

  it('rejects missing headers and missing secret', () => {
    const missing = verifyStandardWebhook({
      secret: SECRET,
      rawBody: body,
      headers: { webhookId: null, webhookTimestamp: String(NOW), webhookSignature: 'x' },
      nowSec: NOW,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, 'MISSING_HEADERS');
    const noSecret = verifyStandardWebhook({ secret: '', rawBody: body, headers: standardHeaders('m', body), nowSec: NOW });
    assert.equal(noSecret.ok, false);
    if (!noSecret.ok) assert.equal(noSecret.reason, 'MISSING_SECRET');
  });
});

describe('legacy polar verification', () => {
  const body = JSON.stringify({ id: 'evt_2' });
  const ts = NOW;
  const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');

  it('verifies a legacy signature', () => {
    const verdict = verifyLegacyPolarWebhook({ secret: SECRET, rawBody: body, signatureHeader: `${ts},${sig}`, nowSec: NOW });
    assert.equal(verdict.ok, true);
  });

  it('rejects a wrong signature and a stale one', () => {
    const bad = verifyLegacyPolarWebhook({ secret: SECRET, rawBody: body, signatureHeader: `${ts},deadbeef`, nowSec: NOW });
    assert.equal(bad.ok, false);
    const stale = verifyLegacyPolarWebhook({ secret: SECRET, rawBody: body, signatureHeader: `${NOW - 9999},${sig}`, nowSec: NOW });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, 'STALE_TIMESTAMP');
  });
});

describe('verifyProviderWebhook boundary', () => {
  const body = JSON.stringify({ id: 'evt_3', type: 'order.paid' });

  it('uses the server-side env secret and never throws when unset', () => {
    const previous = process.env.POLAR_WEBHOOK_SECRET;
    delete process.env.POLAR_WEBHOOK_SECRET;
    const unconfigured = verifyProviderWebhook({
      rawBody: body,
      standardHeaders: standardHeaders('m', body),
      legacySignatureHeader: null,
      nowSec: NOW,
    });
    assert.equal(unconfigured.ok, false);
    if (!unconfigured.ok) assert.equal(unconfigured.reason, 'MISSING_SECRET');
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
    const configured = verifyProviderWebhook({
      rawBody: body,
      standardHeaders: standardHeaders('m', body),
      legacySignatureHeader: null,
      nowSec: NOW,
    });
    assert.equal(configured.ok, true);
    if (previous === undefined) delete process.env.POLAR_WEBHOOK_SECRET;
    else process.env.POLAR_WEBHOOK_SECRET = previous;
  });
});

describe('event parsing + processing', () => {
  it('parses a verified paid-order payload', () => {
    const body = JSON.stringify({
      id: 'evt_9',
      type: 'order.paid',
      data: { id: 'order_1', total_amount: 4999, currency: 'USD', product: { name: 'Widget' }, created_at: '2026-01-01T00:00:00Z' },
    });
    const parsed = parseVerifiedEventBody(body);
    assert.ok(!('error' in parsed));
    if (!('error' in parsed)) {
      assert.equal(parsed.eventId, 'evt_9');
      assert.equal(parsed.eventType, 'order.paid');
      assert.equal(parsed.order.total_amount, 4999);
    }
  });

  it('rejects unparseable bodies with clear errors', () => {
    assert.ok('error' in parseVerifiedEventBody('not-json'));
    assert.ok('error' in parseVerifiedEventBody('[]'));
    assert.ok('error' in parseVerifiedEventBody(JSON.stringify({ type: 'order.paid' })));
  });

  it('IGNORED: non-paid event types are never recorded', async () => {
    const outcome = await processVerifiedPaymentEvent(
      { eventId: 'evt_x', eventType: 'refund.created', order: { id: 'o1' } },
      new Date(),
    );
    assert.equal(outcome.status, 'IGNORED');
    if (outcome.status === 'IGNORED') assert.equal(outcome.reason, 'EVENT_TYPE_NOT_PAID');
    assert.ok(POLAR_EVENT_PAID_TYPES.includes('order.paid'));
  });

  it('REJECTED: invalid amount and unsupported currency', async () => {
    const badAmount = await processVerifiedPaymentEvent(
      { eventId: 'evt_a', eventType: 'order.paid', order: { id: 'o2', total_amount: 0, currency: 'USD' } },
      new Date(),
    );
    assert.equal(badAmount.status, 'REJECTED');
    if (badAmount.status === 'REJECTED') assert.equal(badAmount.reason, 'INVALID_AMOUNT');

    const badCurrency = await processVerifiedPaymentEvent(
      { eventId: 'evt_b', eventType: 'order.paid', order: { id: 'o3', total_amount: 1000, currency: 'XXX' } },
      new Date(),
    );
    assert.equal(badCurrency.status, 'REJECTED');
    if (badCurrency.status === 'REJECTED') assert.equal(badCurrency.reason, 'UNSUPPORTED_CURRENCY');
  });

  it('REJECTED: NaN/Infinity amounts can never enter the ledger', async () => {
    const nan = await processVerifiedPaymentEvent(
      { eventId: 'evt_c', eventType: 'order.paid', order: { id: 'o4', amount: Number.NaN, currency: 'USD' } },
      new Date(),
    );
    assert.equal(nan.status, 'REJECTED');
    const inf = await processVerifiedPaymentEvent(
      { eventId: 'evt_d', eventType: 'order.paid', order: { id: 'o5', amount: Number.POSITIVE_INFINITY, currency: 'USD' } },
      new Date(),
    );
    assert.equal(inf.status, 'REJECTED');
  });
});
