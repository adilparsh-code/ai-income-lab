// Pure tests for the public event-ingestion policy (audit finding N2).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_EVENT_TYPES, isPublicEventType, sanitizePublicEvent } from '@/lib/product-factory/event-policy';

describe('public event policy', () => {
  it('never allows monetary event types anonymously', () => {
    assert.equal(isPublicEventType('PURCHASE'), false);
    assert.equal(isPublicEventType('REFUND'), false);
    assert.equal(isPublicEventType('NOT_A_TYPE'), false);
    assert.equal(isPublicEventType(undefined), false);
  });
  it('allows only top-of-funnel types the storefront sends', () => {
    assert.ok(isPublicEventType('PRODUCT_VIEW') && isPublicEventType('CTA_CLICK'));
    assert.deepEqual([...PUBLIC_EVENT_TYPES].sort(), ['CHECKOUT_STARTED', 'CTA_CLICK', 'PAGE_VIEW', 'PRODUCT_VIEW', 'VISITOR']);
  });
  it('forces unverified evidence, no amount, no experiment, server-derived opportunity', () => {
    const s = sanitizePublicEvent({ opportunityId: 'opp_1' });
    assert.deepEqual(s, { evidenceType: 'USER_ENTERED', amountUsd: null, experimentId: null, opportunityId: 'opp_1' });
    assert.equal(sanitizePublicEvent({ opportunityId: null }).opportunityId, null);
  });
});
