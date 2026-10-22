// ============================================================================
// PRIVATE DELIVERY — DURABLE PERSISTENCE CONTRACT (OFFLINE TESTS)
// ============================================================================
// Hermetic: no database, no network, no provider, no payment gateway.
//
// The rules are exercised against the in-memory delivery store and the
// in-memory private storage; the durable shape they will run against is
// checked against the isolated Prisma proposal with an offline string
// parser.
//
// These tests prove the RULES. They do NOT prove that PostgreSQL enforces
// the constraints: no live database is contacted anywhere in this file.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../product-factory/canonical';
import {
  deliveryIdFor,
  evaluateEntitlement,
  issueDeliveryTicket,
  reconcileDelivery,
  redeemDeliveryTicket,
  revokeEntitlement,
  type DeliveryDeps,
} from '../private-delivery';
import { checkPrivateDeliveryContract } from '../private-delivery-schema';
import {
  createHmacTicketSigner,
  createInMemoryDeliveryStore,
  createInMemoryPrivateStorage,
  type InMemoryDeliveryStore,
} from '../offline-fakes';
import type { AccessHold, DeliveryAsset, DeliveryStorePort, VerifiedPayment } from '../ports';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const BUYER = 'buyer_alice';
const OTHER_BUYER = 'buyer_bob';
const ORDER = 'order_1001';
const VERSION = 'ver_1';
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

function harness(): Harness {
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
    deps: { store, storage, signer: createHmacTicketSigner(SECRET) },
  };
}

async function grantedHarness(): Promise<
  Harness & { ticket: Awaited<ReturnType<typeof issueDeliveryTicket>>; entitlementId: string }
> {
  const h = harness();
  h.store.seedPayment(payment());
  const entitlement = await evaluateEntitlement(
    { orderId: ORDER, buyerId: BUYER, productVersionId: VERSION, assets: [ASSET], now: NOW },
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
  return { ...h, ticket, entitlementId: entitlement.entitlement.entitlementId };
}

function hold(reason: string): AccessHold {
  return {
    orderId: ORDER,
    reason,
    sourceEventId: `evt_${reason.toLowerCase()}`,
    createdAt: NOW.toISOString(),
  };
}

/** A store whose next consume returns STORE_UNAVAILABLE, then behaves normally. */
function withUnknownConsume(store: InMemoryDeliveryStore): DeliveryStorePort {
  let pending = true;
  return {
    ...store,
    async consumeTicket(input) {
      if (pending) {
        pending = false;
        return 'STORE_UNAVAILABLE';
      }
      return store.consumeTicket(input);
    },
  };
}

// ---------------------------------------------------------------------------
// The proposal contract
// ---------------------------------------------------------------------------

describe('private delivery proposal contract', () => {
  const proposal = readFileSync(
    join(process.cwd(), 'prisma', 'proposals', 'private-delivery', 'schema.prisma'),
    'utf8',
  );

  it('the isolated proposal matches the contract in code', () => {
    const check = checkPrivateDeliveryContract(proposal);
    assert.deepEqual(check.problems, []);
    assert.equal(check.ok, true);
  });

  it('detects a ticket that stopped storing a unique token fingerprint', () => {
    const mutated = proposal.replace(
      /^(\s*)tokenFingerprint\s+String\s+@unique/m,
      '$1tokenFingerprint String',
    );
    assert.notEqual(mutated, proposal, 'the mutation must actually change the proposal');
    const check = checkPrivateDeliveryContract(mutated);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => /tokenFingerprint/.test(problem)));
  });

  it('detects a field that stopped being nullable', () => {
    const mutated = proposal.replace(/^(\s*)consumedByDeliveryId\s+String\?/m, '$1consumedByDeliveryId String');
    assert.notEqual(mutated, proposal, 'the mutation must actually change the proposal');
    const check = checkPrivateDeliveryContract(mutated);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => /consumedByDeliveryId/.test(problem)));
  });

  it('detects a dropped audit ledger', () => {
    const mutated = proposal.replace(/^model\s+DeliveryTicketEvent\s*\{/m, 'model DeliveryTicketLedger {');
    assert.notEqual(mutated, proposal, 'the mutation must actually change the proposal');
    const check = checkPrivateDeliveryContract(mutated);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => /DeliveryTicketEvent/.test(problem)));
  });

  it('detects a ticket state that lost its single-use marker', () => {
    const mutated = proposal.replace(/^(\s*)CONSUMED\s*$/m, '$1SPENT');
    assert.notEqual(mutated, proposal, 'the mutation must actually change the proposal');
    const check = checkPrivateDeliveryContract(mutated);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((problem) => /CONSUMED/.test(problem)));
  });
});

// ---------------------------------------------------------------------------
// The ten required scenarios
// ---------------------------------------------------------------------------

describe('durable ticket scenarios', () => {
  it('1. refuses a replayed token and never persists the raw token', async () => {
    const { ticket, store, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    // The raw token is not in the durable record.
    const stored = store.snapshot().tickets[0];
    assert.ok(stored);
    assert.notEqual(stored?.tokenFingerprint, ticket.ticket.token);
    assert.ok(
      !JSON.stringify(store.snapshot()).includes(ticket.ticket.token),
      'the raw bearer token must never be persisted',
    );

    const first = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(first.ok, true);

    // A replay by a different buyer is refused, and the ticket stays spent by
    // the first delivery only.
    const replay = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: OTHER_BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(replay.ok, false);
    if (replay.ok) return;
    assert.equal(replay.code, 'BUYER_MISMATCH');
    assert.equal(store.snapshot().tickets[0]?.state, 'CONSUMED');
    assert.equal(
      store.snapshot().tickets[0]?.consumedByDeliveryId,
      deliveryIdFor(ticket.ticket.ticketId, BUYER),
    );
    assert.equal(store.snapshot().deliveries.length, 1);
  });

  it('2. refuses an expired ticket', async () => {
    const { ticket, store, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: later,
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TICKET_EXPIRED');
    assert.equal(store.snapshot().tickets[0]?.state, 'EXPIRED');
    assert.equal(store.snapshot().deliveries.length, 0);
  });

  it('3. refuses an asset that was substituted in the stored ticket', async () => {
    const { ticket, store, deps, storage } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    // Another package is swapped into the durable ticket. Its digest is
    // valid, but the bytes the private storage holds for it are not the
    // bytes that were promised.
    storage.putAsset({
      assetId: 'pkg_other_pack',
      contentHash: sha256Hex('other-pack-bytes-v2'),
      sizeBytes: 21,
      label: 'Other pack',
      ownerBuyerId: BUYER,
    });
    const stored = store.snapshot().tickets[0];
    assert.ok(stored);
    if (!stored) return;
    store.seedTicket({
      ...stored,
      assets: [
        {
          assetId: 'pkg_other_pack',
          kind: 'PRODUCT_PACKAGE',
          contentHash: sha256Hex('other-pack-bytes'),
          sizeBytes: 21,
          label: 'Other pack',
        },
      ],
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
    assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED', 'a refused attempt never spends the ticket');
  });

  it('4. refuses a version mismatch and a content digest mismatch', async () => {
    const { ticket, store, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    // The entitlement moves to another product version; the ticket is pinned
    // to the version it was issued for.
    const entitlement = store.snapshot().entitlements[0];
    assert.ok(entitlement);
    if (!entitlement) return;
    store.seedEntitlement({ ...entitlement, productVersionId: 'ver_2' });

    const versionMismatch = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(versionMismatch.ok, false);
    if (versionMismatch.ok) return;
    assert.equal(versionMismatch.code, 'VERSION_MISMATCH');
    assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED');

    // With the version restored, a swapped content digest is still refused.
    store.seedEntitlement({ ...entitlement, productVersionId: VERSION });
    const storedTicket = store.snapshot().tickets[0];
    const asset = storedTicket?.assets[0];
    assert.ok(storedTicket);
    assert.ok(asset);
    if (!storedTicket || !asset) return;
    store.seedTicket({
      ...storedTicket,
      assets: [{ ...asset, contentHash: sha256Hex('different-bytes') }],
    });

    const digestMismatch = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      deps,
    );
    assert.equal(digestMismatch.ok, false);
    if (digestMismatch.ok) return;
    assert.equal(digestMismatch.code, 'ASSET_TAMPERED');
    assert.equal(store.snapshot().deliveries.length, 1);
    assert.equal(
      store.snapshot().deliveries[0]?.outcome,
      'FAILED',
      'a refused attempt is recorded as FAILED, never as DELIVERED',
    );
    assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED');
  });

  it('5. refuses a buyer that does not own the ticket', async () => {
    const { ticket, store, deps } = await grantedHarness();
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
    assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED');
    assert.equal(store.snapshot().deliveries.length, 0);
  });

  it('6. refuses delivery while a refund, chargeback, cancellation or dispute holds the order', async () => {
    for (const reason of [
      'REFUND_ISSUED',
      'CHARGEBACK_CREATED',
      'PAYMENT_CANCELED',
      'DISPUTE_OPENED',
    ]) {
      const { ticket, store, deps, storage } = await grantedHarness();
      assert.equal(ticket.ok, true);
      if (!ticket.ok) return;

      // The hold arrives AFTER the ticket was issued.
      store.seedHold(hold(reason));

      const result = await redeemDeliveryTicket(
        {
          ticketId: ticket.ticket.ticketId,
          token: ticket.ticket.token,
          buyerId: BUYER,
          now: NOW,
        },
        deps,
      );
      assert.equal(result.ok, false, `${reason} must stop the delivery`);
      if (result.ok) return;
      assert.equal(result.code, 'ACCESS_HELD');
      assert.equal(result.status, 'REVOKED');
      assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED', 'a hold must not spend the ticket');
      assert.equal(store.snapshot().deliveries.length, 0);
      assert.equal(storage.openCount(), 0, 'a held order must not open a private read');
    }
  });

  it('6b. refuses a held order at entitlement and at ticket issue', async () => {
    const h = harness();
    h.store.seedPayment(payment());
    h.store.seedHold(hold('CHARGEBACK_CREATED'));

    const entitlement = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: VERSION, assets: [ASSET], now: NOW },
      h.deps,
    );
    assert.equal(entitlement.ok, false);
    if (entitlement.ok) return;
    assert.equal(entitlement.code, 'ACCESS_HELD');

    // A hold that arrives after the entitlement was granted stops the ticket.
    const h2 = harness();
    h2.store.seedPayment(payment());
    const granted = await evaluateEntitlement(
      { orderId: ORDER, buyerId: BUYER, productVersionId: VERSION, assets: [ASSET], now: NOW },
      h2.deps,
    );
    assert.equal(granted.ok, true);
    if (!granted.ok) return;
    h2.store.seedHold(hold('DISPUTE_OPENED'));
    const ticket = await issueDeliveryTicket(
      { entitlementId: granted.entitlement.entitlementId, buyerId: BUYER, now: NOW },
      h2.deps,
    );
    assert.equal(ticket.ok, false);
    if (ticket.ok) return;
    assert.equal(ticket.code, 'ACCESS_HELD');
    assert.equal(h2.store.snapshot().tickets.length, 0);
  });

  it('7. lets only one concurrent redemption consume the ticket', async () => {
    const { ticket, store, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    const request = {
      ticketId: ticket.ticket.ticketId,
      token: ticket.ticket.token,
      buyerId: BUYER,
      now: NOW,
    };
    const [first, second] = await Promise.all([
      redeemDeliveryTicket(request, deps),
      redeemDeliveryTicket(request, deps),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.deliveryId, second.deliveryId, 'both attempts share one delivery id');
    assert.equal(store.snapshot().deliveries.length, 1, 'a concurrent race creates one delivery');
    assert.equal(store.snapshot().tickets[0]?.state, 'CONSUMED');
    assert.equal(store.snapshot().tickets[0]?.consumedByDeliveryId, first.deliveryId);
  });

  it('7b. refuses a concurrent redemption by a second buyer', async () => {
    const { ticket, store, deps } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    const [mine, theirs] = await Promise.all([
      redeemDeliveryTicket(
        { ticketId: ticket.ticket.ticketId, token: ticket.ticket.token, buyerId: BUYER, now: NOW },
        deps,
      ),
      redeemDeliveryTicket(
        {
          ticketId: ticket.ticket.ticketId,
          token: ticket.ticket.token,
          buyerId: OTHER_BUYER,
          now: NOW,
        },
        deps,
      ),
    ]);

    assert.equal(mine.ok, true);
    assert.equal(theirs.ok, false, 'a second buyer must never redeem the ticket');
    if (theirs.ok) return;
    assert.equal(theirs.code, 'BUYER_MISMATCH');
    assert.equal(store.snapshot().deliveries.length, 1);
    assert.equal(store.snapshot().tickets[0]?.consumedByDeliveryId, mine.deliveryId);
  });

  it('8. reports an unavailable private object and a storage timeout honestly', async () => {
    // The object is gone from private storage.
    const missing = await grantedHarness();
    assert.equal(missing.ticket.ok, true);
    if (!missing.ticket.ok) return;
    const emptyStorage = createInMemoryPrivateStorage([]);
    const missingResult = await redeemDeliveryTicket(
      {
        ticketId: missing.ticket.ticket.ticketId,
        token: missing.ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      { ...missing.deps, storage: emptyStorage },
    );
    assert.equal(missingResult.ok, false);
    if (missingResult.ok) return;
    assert.equal(missingResult.code, 'ASSET_NOT_FOUND');
    assert.equal(missingResult.status, 'FAILED');
    assert.equal(missing.store.snapshot().tickets[0]?.state, 'ISSUED');

    // The storage times out.
    const timingOut = await grantedHarness();
    assert.equal(timingOut.ticket.ok, true);
    if (!timingOut.ticket.ok) return;
    const timeoutStorage = {
      async verifyContentHash() {
        throw new Error('storage timeout');
      },
      async openForBuyer(): Promise<never> {
        throw new Error('storage timeout');
      },
    };
    const timeoutResult = await redeemDeliveryTicket(
      {
        ticketId: timingOut.ticket.ticket.ticketId,
        token: timingOut.ticket.ticket.token,
        buyerId: BUYER,
        now: NOW,
      },
      { ...timingOut.deps, storage: timeoutStorage },
    );
    assert.equal(timeoutResult.ok, false);
    if (timeoutResult.ok) return;
    assert.equal(timeoutResult.code, 'STORAGE_UNAVAILABLE');
    assert.equal(timeoutResult.status, 'UNAVAILABLE');
    assert.equal(timingOut.store.snapshot().tickets[0]?.state, 'ISSUED');
  });

  it('9. never reports an unknown persistence commit as delivered, and settles it later', async () => {
    const { ticket, store, storage } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    const flaky: DeliveryStorePort = withUnknownConsume(store);
    const deps: DeliveryDeps = { store: flaky, storage, signer: createHmacTicketSigner(SECRET) };
    const request = {
      ticketId: ticket.ticket.ticketId,
      token: ticket.ticket.token,
      buyerId: BUYER,
      now: NOW,
    };

    const first = await redeemDeliveryTicket(request, deps);
    assert.equal(first.ok, false, 'an unknown commit is never a delivery');
    if (first.ok) return;
    assert.equal(first.status, 'PENDING');
    assert.equal(first.code, 'COMMIT_UNKNOWN');
    assert.equal(store.snapshot().deliveries[0]?.outcome, 'PENDING');

    const reconciled = await reconcileDelivery(request, deps);
    assert.equal(reconciled.ok, true);
    if (!reconciled.ok) return;
    assert.equal(reconciled.status, 'DELIVERED');
    assert.equal(store.snapshot().deliveries.length, 1, 'reconciliation never duplicates a delivery');
    assert.equal(store.snapshot().tickets[0]?.state, 'CONSUMED');
  });

  it('10. refuses delivery when the entitlement was revoked after the ticket was issued', async () => {
    const { ticket, store, deps, entitlementId } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    const revoked = await revokeEntitlement(
      { entitlementId, reason: 'refund', now: new Date(NOW.getTime() + 1_000) },
      deps,
    );
    assert.equal(revoked.ok, true);

    const result = await redeemDeliveryTicket(
      {
        ticketId: ticket.ticket.ticketId,
        token: ticket.ticket.token,
        buyerId: BUYER,
        now: new Date(NOW.getTime() + 2_000),
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'ENTITLEMENT_REVOKED');
    assert.equal(result.status, 'REVOKED');
    assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED', 'a revoked entitlement never spends the ticket');
    assert.equal(store.snapshot().deliveries.length, 0);
  });

  it('fails closed when the hold lookup cannot answer', async () => {
    const { ticket, store, storage } = await grantedHarness();
    assert.equal(ticket.ok, true);
    if (!ticket.ok) return;

    const blind: DeliveryStorePort = {
      ...store,
      async findAccessHold(): Promise<null> {
        throw new Error('store unavailable');
      },
    };
    const deps: DeliveryDeps = { store: blind, storage, signer: createHmacTicketSigner(SECRET) };
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
    assert.equal(store.snapshot().tickets[0]?.state, 'ISSUED');
  });
});
