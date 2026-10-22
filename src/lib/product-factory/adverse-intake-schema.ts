// ============================================================================
// DURABLE ADVERSE-INTAKE — MODEL CONTRACT
// ============================================================================
// The declarative contract of the durable tables the adverse-intake pipeline
// needs, plus an OFFLINE checker that compares the contract against the
// isolated Prisma proposal (prisma/proposals/adverse-intake/schema.prisma).
//
// WHY A CONTRACT IN CODE
// ---------------------
// The proposal is deliberately NOT the active schema: it is a reviewed,
// additive proposal that can be validated and type-checked in isolation
// (scripts/verify-adverse-intake-proposal.mjs) before anyone decides to
// apply it as a migration.
//
// A proposal nobody checks drifts. This module is the second half of that
// check: it states, in TypeScript, exactly which models, fields, types,
// nullability, relations and compound-unique constraints the runtime code
// depends on, and it re-reads the proposal to prove they still agree. The
// check is a pure string parse — no database, no Prisma engine, no network.
//
// WHAT THE CONTRACT GUARANTEES
// -----------------------------
//   - every field the runtime writes is present, with the type it expects;
//   - nullable fields are nullable (a NOT NULL surprise would break the
//     "event arrives before its order" path);
//   - the compound uniqueness the dedupe and idempotency rules depend on
//     exists in the proposal, so a duplicate cannot be inserted;
//   - the relations that make the evidence/hold history traversable exist.
//
// It does NOT claim the proposal has been applied anywhere. Nothing here
// touches a live database.
// ============================================================================

/** The lifecycle of one intake record. Mirrors AdverseEventStatus. */
export const ADVERSE_EVENT_STATUSES = [
  'RECEIVED',
  'LEASED',
  'APPLIED',
  'QUARANTINED',
  'IGNORED',
] as const;

export type AdverseEventStatus = (typeof ADVERSE_EVENT_STATUSES)[number];

export function isAdverseEventStatus(value: unknown): value is AdverseEventStatus {
  return typeof value === 'string' && (ADVERSE_EVENT_STATUSES as readonly string[]).includes(value);
}

/** Whether a hold currently blocks access. Mirrors AdverseHoldState. */
export const ADVERSE_HOLD_STATES = ['ACTIVE', 'RELEASED'] as const;

export type AdverseHoldState = (typeof ADVERSE_HOLD_STATES)[number];

/** The models the durable adverse-intake contract is made of. */
export const ADVERSE_INTAKE_MODEL_NAMES = [
  'AdverseEvent',
  'AdverseEventAttempt',
  'AdverseHold',
  'AdverseEventEvidence',
] as const;

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export const ADVERSE_INTAKE_CONTRACT: readonly ModelContract[] = [
  {
    name: 'AdverseEvent',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'provider', type: 'String', optional: false },
      { name: 'providerEventId', type: 'String', optional: false },
      { name: 'eventType', type: 'String', optional: false },
      { name: 'schemaVersion', type: 'Int', optional: false },
      { name: 'payloadDigest', type: 'String', optional: false },
      { name: 'correlationId', type: 'String', optional: false },
      { name: 'orderId', type: 'String', optional: true },
      { name: 'buyerId', type: 'String', optional: true },
      { name: 'amountMinor', type: 'Int', optional: true },
      { name: 'currency', type: 'String', optional: true },
      { name: 'occurredAt', type: 'DateTime', optional: false },
      { name: 'receivedAt', type: 'DateTime', optional: false },
      { name: 'status', type: 'AdverseEventStatus', optional: false },
      { name: 'attemptCount', type: 'Int', optional: false },
      { name: 'leaseOwner', type: 'String', optional: true },
      { name: 'leaseEpoch', type: 'Int', optional: false },
      { name: 'leaseExpiresAt', type: 'DateTime', optional: true },
      { name: 'lastError', type: 'String', optional: true },
      { name: 'quarantinedAt', type: 'DateTime', optional: true },
      { name: 'appliedAt', type: 'DateTime', optional: true },
    ],
    relations: [
      { name: 'attempts', model: 'AdverseEventAttempt', isList: true, optional: false },
      { name: 'holds', model: 'AdverseHold', isList: true, optional: false },
      { name: 'evidence', model: 'AdverseEventEvidence', isList: true, optional: false },
    ],
    uniques: [['provider', 'providerEventId']],
  },
  {
    name: 'AdverseEventAttempt',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'eventId', type: 'String', optional: false },
      { name: 'attempt', type: 'Int', optional: false },
      { name: 'workerId', type: 'String', optional: false },
      { name: 'outcome', type: 'String', optional: false },
      { name: 'detail', type: 'String', optional: false },
      { name: 'createdAt', type: 'DateTime', optional: false },
    ],
    relations: [{ name: 'event', model: 'AdverseEvent', isList: false, optional: false }],
    uniques: [['eventId', 'attempt']],
  },
  {
    name: 'AdverseHold',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'eventId', type: 'String', optional: false },
      { name: 'orderId', type: 'String', optional: false },
      { name: 'buyerId', type: 'String', optional: true },
      { name: 'reason', type: 'String', optional: false },
      { name: 'state', type: 'AdverseHoldState', optional: false },
      { name: 'sourceEventId', type: 'String', optional: false },
      { name: 'createdAt', type: 'DateTime', optional: false },
      { name: 'releasedAt', type: 'DateTime', optional: true },
    ],
    relations: [{ name: 'event', model: 'AdverseEvent', isList: false, optional: false }],
    uniques: [['sourceEventId', 'orderId']],
  },
  {
    name: 'AdverseEventEvidence',
    fields: [
      { name: 'id', type: 'String', optional: false },
      { name: 'eventId', type: 'String', optional: false },
      { name: 'kind', type: 'String', optional: false },
      { name: 'reference', type: 'String', optional: false },
      { name: 'detail', type: 'String', optional: false },
      { name: 'createdAt', type: 'DateTime', optional: false },
    ],
    relations: [{ name: 'event', model: 'AdverseEvent', isList: false, optional: false }],
    uniques: [['eventId', 'kind', 'reference']],
  },
];

// ---------------------------------------------------------------------------
// The proposal parser (offline, no Prisma engine)
// ---------------------------------------------------------------------------

import { hasUnique, parsePrismaModels } from './prisma-schema-parser';
import type { ModelContract } from './prisma-schema-parser';

export type { FieldContract, ModelContract, ParsedField, ParsedModel, RelationContract } from './prisma-schema-parser';
export { parsePrismaModels } from './prisma-schema-parser';

export interface ContractCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Check the isolated proposal against the contract above.
 *
 * Reports every difference it finds (it does not stop at the first), so a
 * reviewer sees the whole gap. A missing field, a changed type, a field that
 * became NOT NULL, a dropped compound unique or a dropped relation are all
 * problems.
 */
export function checkAdverseIntakeContract(schemaText: string): ContractCheck {
  const problems: string[] = [];
  const models = parsePrismaModels(schemaText);

  for (const contract of ADVERSE_INTAKE_CONTRACT) {
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
    if (!(ADVERSE_INTAKE_MODEL_NAMES as readonly string[]).includes(name)) {
      problems.push(`the proposal defines model ${name}, which the contract does not describe`);
    }
  }

  return { ok: problems.length === 0, problems };
}
