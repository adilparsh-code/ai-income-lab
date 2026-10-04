// ============================================================================
// PHASE 11.4 — PAYMENT EVIDENCE (pure unit tests)
// ============================================================================
// The payment trust boundary is tested in isolation, with no DB and no clock,
// because it is the one place where being wrong means either losing real money
// or shipping unpaid work.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPaymentEvidence,
  evidenceStrengthFor,
  isPaymentEventType,
  isReversalEventType,
  isWithinReplayWindow,
  manualReviewIdempotencyKey,
  paymentEventReplayKey,
  recognizedRevenueAfterReversal,
  UNTRUSTED_PAYMENT_CLAIM_KINDS,
  validateManualReview,
  validatePaymentAmount,
} from '../payment-evidence';

describe('Phase 11.4 — untrusted payment claims are refused', () => {
  it('refuses every named untrusted input class, by name', () => {
    for (const kind of UNTRUSTED_PAYMENT_CLAIM_KINDS) {
      const verdict = classifyPaymentEvidence({
        method: 'PROVIDER_WEBHOOK',
        signatureVerified: true,
        claimKind: kind,
      });
      assert.equal(verdict.ok, false, `${kind} must not establish payment truth`);
      if (verdict.ok) continue;
      assert.equal(verdict.untrustedKind, kind);
      assert.match(verdict.reason, /not payment evidence/i);
    }
  });

  it('refuses a screenshot claim EVEN WHEN a valid method is also supplied', () => {
    // This is the ordering guarantee: the untrusted class is checked FIRST, so
    // smuggling a real method string alongside it does not help.
    const verdict = classifyPaymentEvidence({
      method: 'PROVIDER_WEBHOOK',
      signatureVerified: true,
      claimKind: 'CLIENT_SCREENSHOT',
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.untrustedKind, 'CLIENT_SCREENSHOT');
  });

  it('refuses an arbitrary "paid: true" style method', () => {
    for (const bogus of ['PAID', 'client_says_paid', 'SCREENSHOT', 'AI_VERIFIED', '', 42, null, undefined]) {
      const verdict = classifyPaymentEvidence({ method: bogus });
      assert.equal(verdict.ok, false, `${String(bogus)} must not be a payment method`);
    }
  });
});

describe('Phase 11.4 — evidence method preconditions', () => {
  it('requires a verified signature for PROVIDER_WEBHOOK', () => {
    const unsigned = classifyPaymentEvidence({ method: 'PROVIDER_WEBHOOK', signatureVerified: false });
    assert.equal(unsigned.ok, false);
    assert.match(unsigned.ok ? '' : unsigned.reason, /signature/i);

    const signed = classifyPaymentEvidence({ method: 'PROVIDER_WEBHOOK', signatureVerified: true });
    assert.equal(signed.ok, true);
    assert.equal(signed.ok && signed.strength, 'CRYPTOGRAPHIC');
    assert.equal(signed.ok && signed.establishesPaymentTruth, true);
  });

  it('requires a confirmed provider read for PROVIDER_API', () => {
    const unread = classifyPaymentEvidence({ method: 'PROVIDER_API', providerReadVerified: false });
    assert.equal(unread.ok, false);
    const read = classifyPaymentEvidence({ method: 'PROVIDER_API', providerReadVerified: true });
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.strength, 'PROVIDER_READ');
  });

  it('treats MANUAL_ADMIN_APPROVED as human review, not cryptographic proof', () => {
    const verdict = classifyPaymentEvidence({ method: 'MANUAL_ADMIN_APPROVED' });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.strength, 'HUMAN_REVIEW');
    assert.equal(evidenceStrengthFor('MANUAL_ADMIN_APPROVED'), 'HUMAN_REVIEW');
  });
});

describe('Phase 11.4 — replay protection', () => {
  it('accepts an event inside the window and refuses one outside it', () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    assert.equal(isWithinReplayWindow({ eventTimestampMs: now.getTime() - 1000, now }).ok, true);
    const stale = isWithinReplayWindow({ eventTimestampMs: now.getTime() - 3_600_000, now });
    assert.equal(stale.ok, false);
    assert.match(stale.ok ? '' : stale.reason, /replay window/i);
  });

  it('refuses an implausibly future timestamp rather than clamping it', () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const future = isWithinReplayWindow({ eventTimestampMs: now.getTime() + 3_600_000, now });
    assert.equal(future.ok, false);
    assert.match(future.ok ? '' : future.reason, /future/i);
  });

  it('derives the SAME replay key for two deliveries of one event', () => {
    const a = paymentEventReplayKey('POLAR', 'evt_123');
    const b = paymentEventReplayKey('polar', ' evt_123 ');
    assert.equal(a, b, 'a replayed delivery must collapse to one identity');
    assert.notEqual(a, paymentEventReplayKey('POLAR', 'evt_124'));
  });
});

describe('Phase 11.4 — amount and currency validation', () => {
  it('normalizes minor units and rounds to cents', () => {
    const result = validatePaymentAmount({ amount: 1250, unit: 'MINOR', currency: 'usd' });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.amountUsd, 12.5);
    assert.equal(result.ok && result.currency, 'USD');
  });

  it('refuses zero, negative, non-finite and absurd amounts', () => {
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '100', null, undefined]) {
      assert.equal(validatePaymentAmount({ amount }).ok, false, `${String(amount)} must be refused`);
    }
    assert.equal(validatePaymentAmount({ amount: 99_999_999 }).ok, false);
  });

  it('refuses a malformed currency code', () => {
    assert.equal(validatePaymentAmount({ amount: 10, currency: 'DOLLARS' }).ok, false);
    assert.equal(validatePaymentAmount({ amount: 10, currency: 'US' }).ok, false);
  });
});

describe('Phase 11.4 — event type classification', () => {
  it('recognizes paid and reversal event types as distinct classes', () => {
    assert.equal(isPaymentEventType('order.paid'), true);
    assert.equal(isReversalEventType('order.paid'), false);
    assert.equal(isReversalEventType('order.refunded'), true);
    assert.equal(isPaymentEventType('order.refunded'), false);
  });
});

describe('Phase 11.4 — manual review must be fully attributable', () => {
  const valid = {
    reviewer: 'admin@example.com',
    reason: 'Bank statement line 4471 shows a matching transfer.',
    evidenceRefs: ['bank-ref:4471'],
    reviewedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('accepts a complete review', () => {
    const verdict = validateManualReview(valid);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.reviewer, 'admin@example.com');
  });

  it('refuses a review with no reviewer, reason, evidence or timestamp', () => {
    const verdict = validateManualReview({});
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.deepEqual(verdict.missing.sort(), ['evidenceRefs', 'reason', 'reviewedAt', 'reviewer']);
  });

  it('refuses an approval with an empty reviewer string', () => {
    const verdict = validateManualReview({ ...valid, reviewer: '   ' });
    assert.equal(verdict.ok, false);
  });

  it('refuses an approval with no evidence at all', () => {
    const verdict = validateManualReview({ ...valid, evidenceRefs: [] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.missing.join(','), /evidenceRefs/);
  });

  it('derives an idempotency key so re-running a review is a no-op', () => {
    const a = manualReviewIdempotencyKey({ engagementId: 'eng1', milestoneId: 'ms1', providerRef: 'ref-9' });
    const b = manualReviewIdempotencyKey({ engagementId: 'eng1', milestoneId: 'ms1', providerRef: ' ref-9 ' });
    assert.equal(a, b);
    assert.notEqual(a, manualReviewIdempotencyKey({ engagementId: 'eng1', milestoneId: 'ms2', providerRef: 'ref-9' }));
  });
});

describe('Phase 11.4 — reversal arithmetic', () => {
  it('takes recognized revenue to zero on a full refund or chargeback', () => {
    for (const outcome of ['REFUNDED', 'CHARGEBACK', 'REVERSED'] as const) {
      const next = recognizedRevenueAfterReversal({ recognizedUsd: 500, refundUsd: 100, outcome });
      assert.equal(next.recognizedUsd, 0, `${outcome} must zero out recognized revenue`);
    }
  });

  it('reduces recognized revenue on a partial refund', () => {
    const next = recognizedRevenueAfterReversal({ recognizedUsd: 500, refundUsd: 120, outcome: 'PARTIALLY_REFUNDED' });
    assert.equal(next.recognizedUsd, 380);
    assert.equal(next.refundTotalUsd, 120);
  });

  it('never produces negative recognized revenue on a double refund', () => {
    const first = recognizedRevenueAfterReversal({ recognizedUsd: 100, refundUsd: 60, outcome: 'PARTIALLY_REFUNDED' });
    const second = recognizedRevenueAfterReversal({ recognizedUsd: first.recognizedUsd, refundUsd: 60, outcome: 'PARTIALLY_REFUNDED' });
    assert.equal(second.recognizedUsd, 0);
    assert.ok(second.recognizedUsd >= 0);
  });
});
