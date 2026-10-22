// ============================================================================
// PRIVATE DELIVERY — OFFLINE TESTS
// ============================================================================
// Hermetic: no database, no network, no provider. The payment ledger, the
// durable store and the private asset storage are the in-memory fakes; the
// content hashes are real sha256 digests of synthetic bytes.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../../product-factory/canonical';
import {
  deliveryIdFor,
  deliveryStatus,
  evaluateEntitlement,
  issueDeliveryTicket,
  reconcileDelivery,
  redeemDeliveryTicket,
  revokeEntitlement,
  type DeliveryDeps,
} from '../private-delivery';
import {
  createHmacTicketSigner,
  createInMemoryDeliveryStore,
  createInMemoryPrivateStorage,
  type InMemoryDeliveryStore,
} from '../offline-fakes';
import type { DeliveryAsset, DeliveryStorePort, VerifiedPayment } from '../ports';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const BUYER = 'buyer_alice';
const OTHER_BUYER = 'buyer_bob';
const ORDER = 'order_1001';
const SECRET = 'test-ticket-signing-secret';

const ASSET: DeliveryAsset = {
  assetId: 'pkg_starter_pack',
  kind: 'PRODUCT_PACKAGE',
  contentHash: sha256Hex('starter-pack-bytes'),
  sizeBytes: 17,
  label: 'Starter pack',
};

function payment(overrides: Partial<VerifiedPayment> = {}): VerifiedPayment {
  return {
    orderId: ORDER,
    providerEventId: 'evt_1',
    buyerId: BUYER,
    amountUsd: 49,
    currency: 'USD',
    verificationSource: 'PROVIDER_WEBHOOK',
    verifiedAt: NOW.toISOString(),
    ...overrides,
  };
}

interface Harness {
  deps: DeliveryDeps;
  store: InMemoryDeliveryStore;
  storage: ReturnType<typeof createInMemoryPrivateStorage>;
}

function harness(overrides: { storage?: DeliveryDeps['storage'] } = {}): Harness {
  const store = createInMemoryDeliveryStore();
  const storage = createInMemoryPrivateStorage([
    {
      assetId: ASSET.assetId,
      contentHash: ASSET.contentHash,
      sizeBytes: ASSET.sizeBytes,
      label: ASSET.label,
      ownerBuyerId: BUYER,
    },
  ]);
  return {
    store,
    storage,
    deps: {
      store,
      storage: overrides.storage === undefined ? storage : overrides.storage,
      signer: createHmacTicketSigner(SECRET),
    },
  };
}

/** Wrap a store so the next consume returns the given outcome, then behaves normally. */
function withConsumeOutcome(store: InMemoryDeliveryStore, outcome: 'STORE_UNAVAILABLE'): DeliveryStorePort {
  let pending = true;
  return {
    ...store,
    async consumeTicket(input) {
      if (pending) {
        pending = false;
        return outcome;
      }
      return store.consumeTicket(input);
    },
  };
}

async function grantedHarness(): Promise<Harness & { ticket: Awaited<ReturnType<typeof issueDeliveryTicket>> }> {
  const h = harness();
  h.store.seedPayment(payment());
  const entitlement = await evaluateEntitlement(
    { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
    h.deps,
  );
  assert.equal(entitlement.ok, true);
  if (!entitlement.ok) throw new Error('unreachable');
  const ticket = await issueDeliveryTicket(
    { entitlementId: entitlement.entitlement.entitlementId, buyerId: BUYER, now: NOW },
    h.deps,
  );
  assert.equal(ticket.ok, true);
  if (!ticket.ok) throw new Error('unreachable');
  return { ...h, ticket };
}

// ---------------------------------------------------------------------------

describe('entitlement', () => {
  it('is not granted without an evidence-backed payment', async () => {
    const h = harness();
    const result = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'PAYMENT_NOT_VERIFIED');
    assert.equal(result.status, 'DRAFT');
  });

  it('is granted from a verified payment and pins the asset content hash', async () => {
    const h = harness();
    h.store.seedPayment(payment());
    const result = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.created, true);
    assert.equal(result.entitlement.buyerId, BUYER);
    assert.equal(result.entitlement.state, 'GRANTED');
    assert.equal(result.entitlement.assets[0]?.contentHash, ASSET.contentHash);
  });

  it('is idempotent for the same order and buyer', async () => {
    const h = harness();
    h.store.seedPayment(payment());
    const first = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    const second = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(second.created, false);
    assert.equal(second.entitlement.entitlementId, first.entitlement.entitlementId);
    assert.equal(h.store.snapshot().entitlements.length, 1);
  });

  it('refuses a buyer that does not own the order, without disclosing the owner', async () => {
    const h = harness();
    h.store.seedPayment(payment({ buyerId: OTHER_BUYER }));
    const result = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'BUYER_MISMATCH');
    assert.ok(!result.reason.includes(OTHER_BUYER), 'the refusal must not name the real buyer');
  });

  it('refuses a zero-amount order', async () => {
    const h = harness();
    h.store.seedPayment(payment({ amountUsd: 0 }));
    const result = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'PAYMENT_NOT_VERIFIED');
  });

  it('refuses an asset without a verifiable content hash', async () => {
    const h = harness();
    h.store.seedPayment(payment());
    const result = await evaluateEntitlement(
      {
        orderId: ORDER,
        buyerId: BUYER,
        productVersionId: 'ver_1',
        assets: [{ ...ASSET, contentHash: 'not-a-hash' }],
        now: NOW,
      },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'ASSET_INVALID');
  });

  it('refuses an order with no assets', async () => {
    const h = harness();
    h.store.seedPayment(payment());
    const result = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [], now: NOW },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'NO_ASSETS');
  });
});

// ---------------------------------------------------------------------------

describe('delivery ticket', () => {
  it('stores only a keyed fingerprint of the token', async () => {
    const { store, ticket, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const stored = store.snapshot().tickets[0];
    assert.ok(stored, 'the ticket must be stored');
    assert.notEqual(stored?.tokenFingerprint, ticket.ticket.token);
    assert.ok(
      !JSON.stringify(stored).includes(ticket.ticket.token),
      'the raw token must never be persisted',
    );
    assert.equal(stored?.buyerId, BUYER);
    assert.ok(deps.signer.fingerprint(ticket.ticket.token) === stored?.tokenFingerprint);
  });

  it('is refused for a buyer that does not own the entitlement', async () => {
    const h = harness();
    h.store.seedPayment(payment());
    const entitlement = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(entitlement.ok, true);
    if (!entitlement.ok) return;
    const result = await issueDeliveryTicket(
      { entitlementId: entitlement.entitlement.entitlementId, buyerId: OTHER_BUYER, now: NOW },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'BUYER_MISMATCH');
    assert.equal(result.status, 'REVOKED');
  });

  it('is refused for an unknown entitlement', async () => {
    const h = harness();
    const result = await issueDeliveryTicket(
      { entitlementId: 'ent_missing', buyerId: BUYER, now: NOW },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'NOT_FOUND');
  });

  it('is refused once the entitlement is revoked', async () => {
    const { store, deps } = await grantedHarness();
    const entitlementId = store.snapshot().entitlements[0]?.entitlementId;
    assert.ok(entitlementId);
    const revoked = await revokeEntitlement(
      { entitlementId: entitlementId as string, reason: 'chargeback', now: NOW },
      deps,
    );
    assert.equal(revoked.ok, true);
    const result = await issueDeliveryTicket(
      { entitlementId: entitlementId as string, buyerId: BUYER, now: NOW },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'ENTITLEMENT_REVOKED');
  });
});

// ---------------------------------------------------------------------------

describe('redemption', () => {
  it('refuses an unknown ticket', async () => {
    const h = harness();
    const result = await redeemDeliveryTicket(
      { ticketId: 'tkt_missing', token: 'a-token-value-that-is-long-enough', buyerId: BUYER, now: NOW },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVALID_TICKET');
    assert.equal(result.status, 'FAILED');
  });

  it('refuses a buyer substitution', async () => {
    const { ticket, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: OTHER_BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'BUYER_MISMATCH');
    assert.equal(result.status, 'FAILED');
  });

  it('refuses an expired ticket', async () => {
    const { ticket, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TICKET_EXPIRED');
  });

  it('delivers the private asset and records the delivery', async () => {
    const { ticket, store, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, 'DELIVERED');
    assert.equal(result.assets.length, 1);
    const handle = result.assets[0]?.handle ?? '';
    assert.ok(handle.length > 0);
    assert.ok(!handle.startsWith('http'), 'a private handle is never a public URL');
    assert.equal(result.assets[0]?.contentHash, ASSET.contentHash);

    const snapshot = store.snapshot();
    assert.equal(snapshot.tickets[0]?.state, 'CONSUMED');
    assert.equal(snapshot.deliveries[0]?.outcome, 'DELIVERED');
    assert.equal(snapshot.deliveries[0]?.buyerId, BUYER);
    assert.ok(
      !JSON.stringify(snapshot).includes(handle),
      'the private handle is never persisted',
    );
  });

  it('is idempotent when the same buyer retries the same ticket', async () => {
    const { ticket, store, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const request = {
      ticketId: ticket.ticket.ticketId,
      token: ticket.ticket.token,
      buyerId: BUYER,
      now: NOW,
    };
    const first = await redeemDeliveryTicket(request, deps);
    const second = await redeemDeliveryTicket(request, deps);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.deliveryId, second.deliveryId);
    assert.equal(store.snapshot().deliveries.length, 1, 'a retry never creates a second delivery');
  });

  it('refuses an asset whose stored content no longer matches the pinned hash', async () => {
    const { ticket, store, deps, storage } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    storage.putAsset({
      assetId: ASSET.assetId,
      contentHash: sha256Hex('tampered-bytes'),
      sizeBytes: ASSET.sizeBytes,
      label: ASSET.label,
      ownerBuyerId: BUYER,
    });
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'ASSET_TAMPERED');
    assert.equal(result.status, 'FAILED');
    assert.equal(store.snapshot().deliveries[0]?.outcome, 'FAILED');
    assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED', 'a refused attempt never spends the ticket');
  });

  it('refuses when the private storage is not configured', async () => {
    const h = harness({ storage: null });
    h.store.seedPayment(payment());
    const entitlement = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: 'ver_1', assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(entitlement.ok, true);
    if (!entitlement.ok) return;
    const ticket = await issueDeliveryTicket(
      { entitlementId: entitlement.entitlement.entitlementId, buyerId: BUYER, now: NOW },
      h.deps,
    );
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      h.deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'STORAGE_NOT_CONFIGURED');
    assert.equal(result.status, 'UNAVAILABLE');
  });

  it('reports PENDING (never DELIVERED) when the ticket spend cannot be confirmed', async () => {
    const { ticket, store, storage } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const deps: DeliveryDeps = {
      store: withConsumeOutcome(store, 'STORE_UNAVAILABLE'),
      storage,
      signer: createHmacTicketSigner(SECRET),
    };
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 'PENDING');
    assert.equal(result.code, 'COMMIT_UNKNOWN');
  });

  it('settles an unknown commit on retry with the same delivery id', async () => {
    const { ticket, store, storage } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const flaky = withConsumeOutcome(store, 'STORE_UNAVAILABLE');
    const deps: DeliveryDeps = { store: flaky, storage, signer: createHmacTicketSigner(SECRET) };
    const request = {
      ticketId: ticket.ticket.ticketId,
      token: ticket.ticket.token,
      buyerId: BUYER,
      now: NOW,
    };
    const first = await redeemDeliveryTicket(request, deps);
    assert.equal(first.ok, false);
    if (first.ok) return;
    assert.equal(first.status, 'PENDING');
    assert.equal(first.deliveryId, deliveryIdFor(ticket.ticket.ticketId, BUYER));

    const reconciled = await reconcileDelivery(request, deps);
    assert.equal(reconciled.ok, true);
    if (!reconciled.ok) return;
    assert.equal(reconciled.status, 'DELIVERED');
    assert.equal(reconciled.deliveryId, first.deliveryId);
    assert.equal(store.snapshot().deliveries.length, 1);
  });

  it('reports PENDING when the durable store cannot be read', async () => {
    const { ticket, storage } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;
    const broken = createInMemoryDeliveryStore({ failReads: true });
    const deps: DeliveryDeps = { store: broken, storage, signer: createHmacTicketSigner(SECRET) };
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 'PENDING');
    assert.equal(result.code, 'STORE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------

describe('single use', () => {
  it('refuses a second consumption of the same ticket by another delivery', async () => {
    const store = createInMemoryDeliveryStore();
    store.seedTicket({
      ticketId: 'tkt_1',
      tokenFingerprint: 'fingerprint-1',
      entitlementId: 'ent_1',
      orderId: ORDER,
      buyerId: BUYER,
      productVersionId: 'ver_1',
      packageId: 'pkg_1',
      assets: [ASSET],
      state: 'ISSUED',
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
      consumedAt: null,
      consumedByDeliveryId: null,
    });
    const first = await store.consumeTicket({
      ticketId: 'tkt_1',
      tokenFingerprint: 'fingerprint-1',
      buyerId: BUYER,
      deliveryId: 'dlv_a',
      at: NOW.toISOString(),
    });
    assert.equal(first, 'CONSUMED');
    const same = await store.consumeTicket({
      ticketId: 'tkt_1',
      tokenFingerprint: 'fingerprint-1',
      buyerId: BUYER,
      deliveryId: 'dlv_a',
      at: NOW.toISOString(),
    });
    assert.equal(same, 'ALREADY_CONSUMED');
    const other = await store.consumeTicket({
      ticketId: 'tkt_1',
      tokenFingerprint: 'fingerprint-1',
      buyerId: BUYER,
      deliveryId: 'dlv_b',
      at: NOW.toISOString(),
    });
    assert.equal(other, 'CONFLICT');
  });
});

// ---------------------------------------------------------------------------

describe('delivery status', () => {
  const entitlement = {
    entitlementId: 'ent_1',
    orderId: ORDER,
    buyerId: BUYER,
    productVersionId: 'ver_1',
    packageId: 'pkg_1',
    assets: [ASSET],
    assetReviewState: 'REVIEW_READY' as const,
    state: 'GRANTED' as const,
    issuedAt: NOW.toISOString(),
    expiresAt: null,
    revocationReason: '',
  };
  const ticket = {
    ticketId: 'tkt_1',
    tokenFingerprint: 'fp',
    entitlementId: 'ent_1',
    orderId: ORDER,
    buyerId: BUYER,
    productVersionId: 'ver_1',
    packageId: 'pkg_1',
    assets: [ASSET],
    state: 'ISSUED' as const,
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
    consumedAt: null,
    consumedByDeliveryId: null,
  };

  it('reports DRAFT when nothing is entitled yet', () => {
    assert.equal(
      deliveryStatus({ entitlement: null, ticket: null, delivery: null, storageAvailable: true }),
      'DRAFT',
    );
  });

  it('reports DRAFT while the assets are not review-ready', () => {
    assert.equal(
      deliveryStatus({
        entitlement: { ...entitlement, assetReviewState: 'DRAFT' },
        ticket: null,
        delivery: null,
        storageAvailable: true,
      }),
      'DRAFT',
    );
  });

  it('reports REVIEW_READY when the delivery can run', () => {
    assert.equal(
      deliveryStatus({ entitlement, ticket: null, delivery: null, storageAvailable: true }),
      'REVIEW_READY',
    );
  });

  it('reports UNAVAILABLE when private storage is not configured', () => {
    assert.equal(
      deliveryStatus({ entitlement, ticket: null, delivery: null, storageAvailable: false }),
      'UNAVAILABLE',
    );
  });

  it('reports PENDING while a ticket is issued and unspent', () => {
    assert.equal(
      deliveryStatus({ entitlement, ticket, delivery: null, storageAvailable: true }),
      'PENDING',
    );
  });

  it('reports REVOKED for a revoked entitlement', () => {
    assert.equal(
      deliveryStatus({
        entitlement: { ...entitlement, state: 'REVOKED' },
        ticket: null,
        delivery: null,
        storageAvailable: true,
      }),
      'REVOKED',
    );
  });

  it('lets the recorded delivery decide the status', () => {
    const delivered = {
      deliveryId: 'dlv_1',
      ticketId: 'tkt_1',
      entitlementId: 'ent_1',
      orderId: ORDER,
      buyerId: BUYER,
      outcome: 'DELIVERED' as const,
      assetIds: [ASSET.assetId],
      reason: '',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    assert.equal(
      deliveryStatus({ entitlement, ticket, delivery: delivered, storageAvailable: true }),
      'DELIVERED',
    );
    assert.equal(
      deliveryStatus({
        entitlement,
        ticket,
        delivery: { ...delivered, outcome: 'FAILED' },
        storageAvailable: true,
      }),
      'FAILED',
    );
    assert.equal(
      deliveryStatus({
        entitlement,
        ticket,
        delivery: { ...delivered, outcome: 'PENDING' },
        storageAvailable: true,
      }),
      'PENDING',
    );
  });
});
