// ============================================================================
// PRIVATE DELIVERY — OFFLINE FAKES
// ============================================================================
// In-memory implementations of the private-delivery ports.
//
// They exist so the rules in ./private-delivery can be exercised end to end
// without a database, a payment provider or a storage bucket — and so a
// future local dev server can run the whole delivery flow offline.
//
// THEY ARE NOT A PRODUCTION ADAPTER. A live implementation must satisfy the
// same contract with durable, transactional semantics:
//   - consumeTicket must be an atomic compare-and-set in the database, not an
//     in-process check (see the implementation note in the method);
//   - the storage adapter must be private and buyer-scoped, never a public URL.
// ============================================================================

import { createHmac, randomBytes } from 'node:crypto';
import type {
  DeliveryRecord,
  DeliveryStorePort,
  DeliveryAsset,
  ConsumeOutcome,
  EntitlementRecord,
  PrivateStoragePort,
  TicketRecord,
  TicketSignerPort,
  VerifiedPayment,
} from './ports';

export interface InMemoryDeliveryStore extends DeliveryStorePort {
  /** Seed an evidence-backed payment (the ledger the rules read from). */
  seedPayment(payment: VerifiedPayment): void;
  seedEntitlement(record: EntitlementRecord): void;
  seedTicket(record: TicketRecord): void;
  /** A read-only view of everything the store holds. */
  snapshot(): {
    entitlements: EntitlementRecord[];
    tickets: TicketRecord[];
    deliveries: DeliveryRecord[];
    payments: VerifiedPayment[];
  };
}

export interface InMemoryDeliveryStoreOptions {
  /** Simulate a store outage for the unknown-commit path. */
  failConsumeWith?: ConsumeOutcome;
  failReads?: boolean;
}

/**
 * An in-memory delivery store.
 *
 * The methods are `async` so the port can be swapped for a real database
 * adapter without touching the rules.
 */
export function createInMemoryDeliveryStore(
  options: InMemoryDeliveryStoreOptions = {},
): InMemoryDeliveryStore {
  const payments = new Map<string, VerifiedPayment>();
  const entitlements = new Map<string, EntitlementRecord>();
  const tickets = new Map<string, TicketRecord>();
  const deliveries = new Map<string, DeliveryRecord>();

  const store: InMemoryDeliveryStore = {
    seedPayment(payment) {
      payments.set(payment.orderId, { ...payment });
    },

    seedEntitlement(record) {
      entitlements.set(record.entitlementId, { ...record, assets: record.assets.map((asset) => ({ ...asset })) });
    },

    seedTicket(record) {
      tickets.set(record.ticketId, { ...record, assets: record.assets.map((asset) => ({ ...asset })) });
    },

    snapshot() {
      return {
        entitlements: [...entitlements.values()].map((record) => ({ ...record })),
        tickets: [...tickets.values()].map((record) => ({ ...record })),
        deliveries: [...deliveries.values()].map((record) => ({ ...record })),
        payments: [...payments.values()].map((record) => ({ ...record })),
      };
    },

    async findVerifiedPayment(orderId) {
      if (options.failReads) throw new Error('store unavailable');
      return payments.get(orderId) ?? null;
    },

    async findEntitlement(entitlementId) {
      if (options.failReads) throw new Error('store unavailable');
      const record = entitlements.get(entitlementId);
      return record ? { ...record, assets: record.assets.map((asset) => ({ ...asset })) } : null;
    },

    async findEntitlementByOrder(orderId, buyerId) {
      if (options.failReads) throw new Error('store unavailable');
      for (const record of entitlements.values()) {
        if (record.orderId === orderId && record.buyerId === buyerId) {
          return { ...record, assets: record.assets.map((asset) => ({ ...asset })) };
        }
      }
      return null;
    },

    async saveEntitlement(record) {
      if (options.failReads) throw new Error('store unavailable');
      if (entitlements.has(record.entitlementId)) {
        return { ok: false, reason: 'entitlement-already-exists' };
      }
      entitlements.set(record.entitlementId, { ...record, assets: record.assets.map((asset) => ({ ...asset })) });
      return { ok: true };
    },

    async revokeEntitlement(entitlementId, reason, at) {
      if (options.failReads) throw new Error('store unavailable');
      const record = entitlements.get(entitlementId);
      if (!record) return { ok: false, reason: 'not-found' };
      record.state = 'REVOKED';
      record.revocationReason = reason.slice(0, 300);
      record.issuedAt = record.issuedAt || at;
      return { ok: true };
    },

    async findTicket(ticketId) {
      if (options.failReads) throw new Error('store unavailable');
      const record = tickets.get(ticketId);
      return record ? { ...record, assets: record.assets.map((asset) => ({ ...asset })) } : null;
    },

    async findTicketByFingerprint(tokenFingerprint) {
      if (options.failReads) throw new Error('store unavailable');
      for (const record of tickets.values()) {
        if (record.tokenFingerprint === tokenFingerprint) {
          return { ...record, assets: record.assets.map((asset) => ({ ...asset })) };
        }
      }
      return null;
    },

    async saveTicket(record) {
      if (options.failReads) throw new Error('store unavailable');
      if (tickets.has(record.ticketId)) return { ok: false, reason: 'ticket-already-exists' };
      tickets.set(record.ticketId, { ...record, assets: record.assets.map((asset) => ({ ...asset })) });
      return { ok: true };
    },

    async expireTicket(ticketId, at) {
      if (options.failReads) throw new Error('store unavailable');
      const record = tickets.get(ticketId);
      if (!record) return { ok: false, reason: 'not-found' };
      if (record.state === 'ISSUED') {
        record.state = 'EXPIRED';
        record.consumedAt = record.consumedAt ?? at;
      }
      return { ok: true };
    },

    /**
     * The atomic single-use consumption.
     *
     * The check and the write happen without an intervening await, so no other
     * caller can interleave between them: exactly one (ticket, deliveryId)
     * pair can move the ticket from ISSUED to CONSUMED.
     */
    async consumeTicket(input): Promise<ConsumeOutcome> {
      if (options.failReads) throw new Error('store unavailable');
      if (options.failConsumeWith) return options.failConsumeWith;
      const ticket = tickets.get(input.ticketId);
      if (!ticket) return 'NOT_FOUND';
      if (ticket.tokenFingerprint !== input.tokenFingerprint) return 'NOT_FOUND';
      if (ticket.buyerId !== input.buyerId) return 'CONFLICT';
      if (ticket.state === 'CONSUMED') {
        return ticket.consumedByDeliveryId === input.deliveryId ? 'ALREADY_CONSUMED' : 'CONFLICT';
      }
      if (ticket.state !== 'ISSUED') return 'CONFLICT';
      ticket.state = 'CONSUMED';
      ticket.consumedAt = input.at;
      ticket.consumedByDeliveryId = input.deliveryId;
      return 'CONSUMED';
    },

    async findDelivery(deliveryId) {
      if (options.failReads) throw new Error('store unavailable');
      const record = deliveries.get(deliveryId);
      return record ? { ...record } : null;
    },

    async saveDelivery(record) {
      if (options.failReads) throw new Error('store unavailable');
      deliveries.set(record.deliveryId, { ...record, assetIds: [...record.assetIds] });
      return { ok: true };
    },
  };

  return store;
}

export interface InMemoryAsset {
  assetId: string;
  /** The sha256 of the stored bytes. */
  contentHash: string;
  sizeBytes: number;
  label: string;
  /** When set, only this buyer may open the asset. */
  ownerBuyerId?: string;
}

export interface InMemoryPrivateStorage extends PrivateStoragePort {
  /** Register (or replace) an asset. */
  putAsset(asset: InMemoryAsset): void;
  /** The number of handles opened so far (test helper). */
  openCount(): number;
}

export interface InMemoryPrivateStorageOptions {
  handleTtlSeconds?: number;
  now?: () => Date;
}

/**
 * An in-memory private asset store.
 *
 * It models the two properties a real private bucket must have: the bytes
 * have a verifiable content hash, and only the entitled buyer can open them.
 */
export function createInMemoryPrivateStorage(
  assets: InMemoryAsset[] = [],
  options: InMemoryPrivateStorageOptions = {},
): InMemoryPrivateStorage {
  const ttlSeconds = options.handleTtlSeconds ?? 300;
  const now = options.now ?? (() => new Date());
  const catalog = new Map<string, InMemoryAsset>();
  let opens = 0;

  for (const asset of assets) catalog.set(asset.assetId, { ...asset });

  return {
    putAsset(asset) {
      catalog.set(asset.assetId, { ...asset });
    },

    openCount() {
      return opens;
    },

    async verifyContentHash(asset: DeliveryAsset) {
      const stored = catalog.get(asset.assetId);
      if (!stored) {
        return { ok: false, reason: `No private asset is stored under ${asset.assetId}.`, failure: 'DENIED' };
      }
      return { ok: true, contentHash: stored.contentHash };
    },

    async openForBuyer({ asset, buyerId }) {
      const stored = catalog.get(asset.assetId);
      if (!stored) {
        return { ok: false, reason: `No private asset is stored under ${asset.assetId}.`, failure: 'DENIED' };
      }
      if (stored.ownerBuyerId && stored.ownerBuyerId !== buyerId) {
        return { ok: false, reason: 'This asset is not available to the requesting buyer.', failure: 'DENIED' };
      }
      opens += 1;
      const expiresAt = new Date(now().getTime() + ttlSeconds * 1000).toISOString();
      return {
        ok: true,
        handle: {
          assetId: stored.assetId,
          contentHash: stored.contentHash,
          sizeBytes: stored.sizeBytes,
          label: stored.label,
          handle: `handle_${randomBytes(16).toString('hex')}`,
          expiresAt,
        },
      };
    },
  };
}

/**
 * The keyed token deriver.
 *
 * A keyed HMAC is required: a plain hash of a random token would let anyone
 * holding a database dump replay the token.
 */
export function createHmacTicketSigner(secret: string): TicketSignerPort {
  if (typeof secret !== 'string' || secret.length < 8) {
    throw new Error('The ticket signing secret must be a string of at least 8 characters.');
  }
  return {
    fingerprint(token: string): string {
      return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
    },
  };
}
