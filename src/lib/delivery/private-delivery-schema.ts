// ============================================================================
// PRIVATE DELIVERY — DURABLE PERSISTENCE CONTRACT
// ============================================================================
// The declarative contract the durable private-delivery tables must satisfy,
// plus an OFFLINE checker that compares the contract against the isolated
// Prisma proposal (prisma/proposals/private-delivery/schema.prisma).
//
// WHY A CONTRACT IN CODE
// ----------------------
// The proposal is deliberately NOT the active schema: it is a reviewed,
// additive proposal that can be validated and type-checked in isolation
// (scripts/verify-private-delivery-proposal.mjs) before anyone decides to
// apply it as a migration.
//
// A proposal nobody checks drifts. This module is the second half of that
// check: it states, in TypeScript, exactly which models, fields, types,
// nullability, relations, compound-unique constraints and enums the durable
// delivery contract depends on, and it re-reads the proposal to prove they
// still agree. The check is a pure string parse — no database, no Prisma
// engine, no network.
//
// WHAT THE CONTRACT GUARANTEES
// -----------------------------
//   - the bearer token is only ever stored as a keyed fingerprint, and that
//     fingerprint is UNIQUE, so a token cannot be replayed from a dump;
//   - the promised binding (package id, version id, asset id, content
//     digest) is preserved on the ticket itself, so the ticket still says
//     what was sold even if the entitlement changes later;
//   - the single-use transition has a durable marker (state, consumedAt,
//     consumedByDeliveryId) and a unique (entitlementId, tokenFingerprint);
//   - expiry, revocation and consumption are all evidenced;
//   - the audit ledger exists and is unique per (ticket, kind, reference).
//
// It does NOT claim the proposal has been applied anywhere, and it does not
// claim the database enforces the version binding — that check is the
// application's, against the pinned columns this contract preserves.
// ============================================================================

import { hasUnique, parsePrismaEnums, parsePrismaModels } from '../product-factory/prisma-schema-parser';
import type { ModelContract } from '../product-factory/prisma-schema-parser';

export type { FieldContract, ModelContract, RelationContract } from '../product-factory/prisma-schema-parser';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** The models the durable private-delivery contract is made of. */
export const PRIVATE_DELIVERY_MODEL_NAMES = [
  'DeliveryEntitlement',
  'DeliveryEntitlementAsset',
  'DeliveryTicket',
  'DeliveryTicketAsset',
  'DeliveryRecord',
  'DeliveryTicketEvent',
] as const;

/** The enums the durable private-delivery contract depends on. */
export const PRIVATE_DELIVERY_ENUM_NAMES = [
  'DeliveryEntitlementState',
  'DeliveryAssetReviewState',
  'DeliveryTicketState',
  'DeliveryOutcomeState',
  'DeliveryAssetKind',
] as const;

/** The values each enum must contain. */
export const PRIVATE_DELIVERY_ENUM_VALUES: Record<string, readonly string[]> = {
  DeliveryEntitlementState: ['PENDING', 'GRANTED', 'REVOKED', 'EXPIRED'],
  DeliveryAssetReviewState: ['DRAFT', 'REVIEW_READY'],
  DeliveryTicketState: ['ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED'],
  DeliveryOutcomeState: ['PENDING', 'DELIVERED', 'FAILED'],
  DeliveryAssetKind: ['PRODUCT_PACKAGE', 'DELIVERABLE_FILE', 'DOCUMENT', 'ARCHIVE'],
};

export const PRIVATE_DELIVERY_CONTRACT: readonly ModelContract[] = [
  {
    name: 'DeliveryEntitlement',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'orderId', type: 'String', optional: false },
      { name: 'buyerId', type: 'String', optional: false },
      { name: 'productVersionId', type: 'String', optional: false },
      { name: 'packageId', type: 'String', optional: true },
      { name: 'assetReviewState', type: 'DeliveryAssetReviewState', optional: false },
      { name: 'state', type: 'DeliveryEntitlementState', optional: false },
      { name: 'issuedAt', type: 'DateTime', optional: false },
      { name: 'expiresAt', type: 'DateTime', optional: true },
      { name: 'revokedAt', type: 'DateTime', optional: true },
      { name: 'revocationReason', type: 'String', optional: true },
      { name: 'createdAt', type: 'DateTime', optional: false },
      { name: 'updatedAt', type: 'DateTime', optional: false },
    ],
    relations: [
      { name: 'assets', model: 'DeliveryEntitlementAsset', isList: true, optional: false },
      { name: 'tickets', model: 'DeliveryTicket', isList: true, optional: false },
      { name: 'deliveries', model: 'DeliveryRecord', isList: true, optional: false },
    ],
    uniques: [['orderId', 'buyerId', 'productVersionId']],
  },
  {
    name: 'DeliveryEntitlementAsset',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'entitlementId', type: 'String', optional: false },
      { name: 'assetId', type: 'String', optional: false },
      { name: 'kind', type: 'DeliveryAssetKind', optional: false },
      { name: 'contentHash', type: 'String', optional: false },
      { name: 'sizeBytes', type: 'Int', optional: false },
      { name: 'label', type: 'String', optional: false },
      { name: 'createdAt', type: 'DateTime', optional: false },
    ],
    relations: [
      { name: 'entitlement', model: 'DeliveryEntitlement', isList: false, optional: false },
    ],
    uniques: [['entitlementId', 'assetId']],
  },
  {
    name: 'DeliveryTicket',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'tokenFingerprint', type: 'String', optional: false },
      { name: 'entitlementId', type: 'String', optional: false },
      { name: 'orderId', type: 'String', optional: false },
      { name: 'buyerId', type: 'String', optional: false },
      { name: 'productVersionId', type: 'String', optional: false },
      { name: 'packageId', type: 'String', optional: true },
      { name: 'state', type: 'DeliveryTicketState', optional: false },
      { name: 'issuedAt', type: 'DateTime', optional: false },
      { name: 'expiresAt', type: 'DateTime', optional: false },
      { name: 'consumedAt', type: 'DateTime', optional: true },
      { name: 'consumedByDeliveryId', type: 'String', optional: true },
      { name: 'revokedAt', type: 'DateTime', optional: true },
      { name: 'revocationReason', type: 'String', optional: true },
      { name: 'createdAt', type: 'DateTime', optional: false },
      { name: 'updatedAt', type: 'DateTime', optional: false },
    ],
    relations: [
      { name: 'entitlement', model: 'DeliveryEntitlement', isList: false, optional: false },
      { name: 'assets', model: 'DeliveryTicketAsset', isList: true, optional: false },
      { name: 'events', model: 'DeliveryTicketEvent', isList: true, optional: false },
      { name: 'deliveries', model: 'DeliveryRecord', isList: true, optional: false },
    ],
    uniques: [
      ['tokenFingerprint'],
      ['entitlementId', 'tokenFingerprint'],
    ],
  },
  {
    name: 'DeliveryTicketAsset',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'ticketId', type: 'String', optional: false },
      { name: 'assetId', type: 'String', optional: false },
      { name: 'kind', type: 'DeliveryAssetKind', optional: false },
      { name: 'contentHash', type: 'String', optional: false },
      { name: 'sizeBytes', type: 'Int', optional: false },
      { name: 'label', type: 'String', optional: false },
      { name: 'createdAt', type: 'DateTime', optional: false },
    ],
    relations: [{ name: 'ticket', model: 'DeliveryTicket', isList: false, optional: false }],
    uniques: [['ticketId', 'assetId']],
  },
  {
    name: 'DeliveryRecord',
    fields: [
      { name: 'deliveryId', type: 'String', optional: false },
      { name: 'ticketId', type: 'String', optional: false },
      { name: 'entitlementId', type: 'String', optional: false },
      { name: 'orderId', type: 'String', optional: false },
      { name: 'buyerId', type: 'String', optional: false },
      { name: 'outcome', type: 'DeliveryOutcomeState', optional: false },
      { name: 'assetIds', type: 'String', optional: false },
      { name: 'reason', type: 'String', optional: false },
      { name: 'createdAt', type: 'DateTime', optional: false },
      { name: 'updatedAt', type: 'DateTime', optional: false },
    ],
    relations: [
      { name: 'ticket', model: 'DeliveryTicket', isList: false, optional: false },
      { name: 'entitlement', model: 'DeliveryEntitlement', isList: false, optional: false },
    ],
    uniques: [],
  },
  {
    name: 'DeliveryTicketEvent',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'ticketId', type: 'String', optional: false },
      { name: 'kind', type: 'String', optional: false },
      { name: 'reference', type: 'String', optional: false },
      { name: 'detail', type: 'String', optional: false },
      { name: 'createdAt', type: 'DateTime', optional: false },
    ],
    relations: [{ name: 'ticket', model: 'DeliveryTicket', isList: false, optional: false }],
    uniques: [['ticketId', 'kind', 'reference']],
  },
];

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

export interface ContractCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Check the isolated private-delivery proposal against the contract above.
 *
 * Reports every difference it finds (it does not stop at the first), so a
 * reviewer sees the whole gap. A missing field, a changed type, a field that
 * became NOT NULL, a dropped compound unique, a missing relation and a
 * missing enum value are all problems.
 */
export function checkPrivateDeliveryContract(schemaText: string): ContractCheck {
  const problems: string[] = [];
  const models = parsePrismaModels(schemaText);
  const enums = parsePrismaEnums(schemaText);

  for (const contract of PRIVATE_DELIVERY_CONTRACT) {
    const model = models.get(contract.name);
    if (!model) {
      problems.push(`model ${contract.name} is missing from the proposal`);
      continue;
    }

    for (const field of contract.fields) {
      const actual = model.fields.get(field.name);
      if (!actual) {
        problems.push(`${contract.name}.${field.name} is missing from the proposal`);
        continue;
      }
      if (actual.type !== field.type) {
        problems.push(
          `${contract.name}.${field.name} has type ${actual.type}, the contract expects ${field.type}`,
        );
      }
      if (actual.optional !== field.optional) {
        problems.push(
          `${contract.name}.${field.name} is ${actual.optional ? 'nullable' : 'NOT NULL'}, the contract expects ${
            field.optional ? 'nullable' : 'NOT NULL'
          }`,
        );
      }
    }

    for (const relation of contract.relations) {
      const actual = model.fields.get(relation.name);
      if (!actual) {
        problems.push(`${contract.name}.${relation.name} (relation) is missing from the proposal`);
        continue;
      }
      if (actual.type !== relation.model) {
        problems.push(
          `${contract.name}.${relation.name} points at ${actual.type}, the contract expects ${relation.model}`,
        );
      }
      if (actual.isList !== relation.isList) {
        problems.push(
          `${contract.name}.${relation.name} list-ness differs from the contract (${actual.isList} vs ${relation.isList})`,
        );
      }
    }

    for (const unique of contract.uniques) {
      if (!hasUnique(model, unique)) {
        problems.push(
          `${contract.name} is missing the compound unique constraint (${unique.join(', ')})`,
        );
      }
    }
  }

  // A model in the proposal that the contract does not know about is drift in
  // the other direction and must be surfaced, not ignored.
  for (const name of models.keys()) {
    if (!(PRIVATE_DELIVERY_MODEL_NAMES as readonly string[]).includes(name)) {
      problems.push(`the proposal defines model ${name}, which the contract does not describe`);
    }
  }

  for (const [name, values] of Object.entries(PRIVATE_DELIVERY_ENUM_VALUES)) {
    const parsed = enums.get(name);
    if (!parsed) {
      problems.push(`enum ${name} is missing from the proposal`);
      continue;
    }
    for (const value of values) {
      if (!parsed.values.includes(value)) {
        problems.push(`enum ${name} is missing the value ${value}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
