// ============================================================================
// PRIVATE DELIVERY — BUYER-SAFE VIEW — OFFLINE TESTS
// ============================================================================
// Hermetic and pure: the view takes records and returns records. These tests
// exist because a projection is only as safe as its allow-list: the failure
// mode being guarded against is a field that quietly finds its way into a
// buyer-facing response.
//
// They make no claim about a live database or a live storage bucket.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliveryView, DELIVERY_STATUS_MESSAGES } from '../delivery-view';
import { DELIVERY_STATUSES, type DeliveryAsset, type EntitlementRecord, type TicketRecord } from '../ports';

const NOW = new Date('2026-04-01T09:00:00.000Z');

const ASSET: DeliveryAsset = {
  assetId: 'asset1',
  kind: 'PRODUCT_PACKAGE',
  contentHash: 'a'.repeat(64),
  sizeBytes: 2048,
  label: 'The playbook',
};

const ENTITLEMENT: EntitlementRecord = {
  entitlementId: 'ent1',
  orderId: 'eng2001',
  buyerId: 'alice',
  productVersionId: 'ver1',
  packageId: 'pkg1',
  assets: [ASSET],
  assetReviewState: 'REVIEW_READY',
  state: 'GRANTED',
  issuedAt: NOW.toISOString(),
  expiresAt: null,
  revocationReason: 'the provider reported a chargeback on the original payment',
};

const TICKET: TicketRecord = {
  ticketId: 'tkt1',
  tokenFingerprint: 'a-keyed-fingerprint-that-must-never-be-shown',
  entitlementId: 'ent1',
  orderId: 'eng2001',
  buyerId: 'alice',
  productVersionId: 'ver1',
  packageId: 'pkg1',
  assets: [ASSET],
  state: 'ISSUED',
  issuedAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
  consumedAt: null,
  consumedByDeliveryId: null,
};

const DELIVERY = {
  deliveryId: 'dlv1',
  ticketId: 'tkt1',
  entitlementId: 'ent1',
  orderId: 'eng2001',
  buyerId: 'alice',
  outcome: 'DELIVERED' as const,
  assetIds: [ASSET.assetId],
  reason: 'an internal reason that must never be shown to a buyer',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

describe('the buyer-safe delivery view', () => {
  it('never carries the token fingerprint, the buyer id or the internal reasons', () => {
    const view = buildDeliveryView({
      entitlement: ENTITLEMENT,
      ticket: TICKET,
      delivery: DELIVERY,
      storageAvailable: true,
    });

    const serialized = JSON.stringify(view);
    assert.ok(!serialized.includes('a-keyed-fingerprint-that-must-never-be-shown'));
    assert.ok(!serialized.includes('alice'), 'the buyer id is not part of the view');
    assert.ok(!serialized.includes('the provider reported a chargeback'));
    assert.ok(!serialized.includes('an internal reason that must never be shown'));
    assert.ok(!serialized.includes('tokenFingerprint'));
    assert.ok(!serialized.includes('revocationReason'));
  });

  it('names only the fields the buyer may see', () => {
    const view = buildDeliveryView({
      entitlement: ENTITLEMENT,
      ticket: TICKET,
      delivery: DELIVERY,
      storageAvailable: true,
    });

    assert.deepEqual(Object.keys(view).sort(), [
      'assets',
      'delivery',
      'entitlement',
      'status',
      'ticket',
    ]);
    assert.deepEqual(Object.keys(view.ticket ?? {}).sort(), [
      'consumedAt',
      'expiresAt',
      'issuedAt',
      'state',
      'ticketId',
    ]);
    assert.deepEqual(Object.keys(view.delivery ?? {}).sort(), [
      'assetIds',
      'createdAt',
      'deliveryId',
      'outcome',
      'updatedAt',
    ]);
    assert.deepEqual(Object.keys(view.entitlement ?? {}).sort(), [
      'entitlementId',
      'expiresAt',
      'issuedAt',
      'orderId',
      'packageId',
      'productVersionId',
      'state',
    ]);
  });

  it('reports the status from the durable facts', () => {
    assert.equal(
      buildDeliveryView({ entitlement: ENTITLEMENT, ticket: TICKET, delivery: DELIVERY, storageAvailable: true })
        .status,
      'DELIVERED',
    );
    assert.equal(
      buildDeliveryView({
        entitlement: { ...ENTITLEMENT, state: 'REVOKED' },
        ticket: TICKET,
        delivery: null,
        storageAvailable: true,
      }).status,
      'REVOKED',
    );
    assert.equal(
      buildDeliveryView({ entitlement: null, ticket: null, delivery: null, storageAvailable: true }).status,
      'DRAFT',
    );
  });

  it('shows the assets the ticket pinned', () => {
    const view = buildDeliveryView({
      entitlement: ENTITLEMENT,
      ticket: TICKET,
      delivery: null,
      storageAvailable: true,
    });
    assert.equal(view.assets.length, 1);
    assert.equal(view.assets[0]?.contentHash, ASSET.contentHash);
    assert.equal(view.assets[0]?.label, ASSET.label);
  });

  it('falls back to the entitlement assets when there is no ticket', () => {
    const view = buildDeliveryView({
      entitlement: ENTITLEMENT,
      ticket: null,
      delivery: null,
      storageAvailable: true,
    });
    assert.equal(view.assets.length, 1);
    assert.equal(view.ticket, null);
  });

  it('has a buyer-safe message for every status', () => {
    for (const status of DELIVERY_STATUSES) {
      const message = DELIVERY_STATUS_MESSAGES[status];
      assert.equal(typeof message, 'string');
      assert.ok(message.length > 0);
      assert.ok(!/chargeback|refund|fingerprint|token|buyer|entitlement id/i.test(message));
    }
  });
});
