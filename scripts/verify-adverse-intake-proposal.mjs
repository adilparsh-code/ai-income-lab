// Offline verification of the ISOLATED adverse-intake Prisma proposal.
//
// Nothing here touches a database, a credential or the active application
// schema. It proves three things:
//
//   1. The proposal is valid for the ACTUALLY INSTALLED Prisma CLI.
//   2. The client it generates exposes the delegate surface the durable
//      contract depends on (models, fields, nullability, uniqueness inputs).
//   3. Generating it does NOT touch the active schema or the active generated
//      client — the client is generated into a temporary directory that is
//      removed afterwards.
//
// Usage:  node scripts/verify-adverse-intake-proposal.mjs
// Exit:   0 = verified, 1 = a check failed.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProposal } from './lib/verify-proposal.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { notes, problems } = verifyProposal({
  root,
  proposalDir: join('prisma', 'proposals', 'adverse-intake'),
  activeSchema: join('prisma', 'schema.prisma'),
  activeClientDir: 'generated',
  label: 'adverse-intake',
  delegates: [
    'adverseEvent',
    'adverseEventAttempt',
    'adverseHold',
    'adverseEventEvidence',
  ],
  fields: {
    AdverseEvent: [
      'id',
      'provider',
      'providerEventId',
      'eventType',
      'payloadDigest',
      'correlationId',
      'orderId',
      'buyerId',
      'amountMinor',
      'currency',
      'occurredAt',
      'receivedAt',
      'status',
      'attemptCount',
      'leaseOwner',
      'leaseEpoch',
      'leaseExpiresAt',
      'lastError',
      'quarantinedAt',
      'appliedAt',
    ],
    AdverseEventAttempt: ['id', 'eventId', 'attempt', 'workerId', 'outcome', 'detail', 'createdAt'],
    AdverseHold: [
      'id',
      'eventId',
      'orderId',
      'buyerId',
      'reason',
      'state',
      'sourceEventId',
      'createdAt',
      'releasedAt',
    ],
    AdverseEventEvidence: ['id', 'eventId', 'kind', 'reference', 'detail', 'createdAt'],
  },
  nullable: {
    AdverseEvent: [
      'orderId',
      'buyerId',
      'amountMinor',
      'currency',
      'leaseOwner',
      'leaseExpiresAt',
      'lastError',
      'quarantinedAt',
      'appliedAt',
    ],
  },
  uniques: {
    AdverseEvent: ['provider_providerEventId'],
    AdverseEventAttempt: ['eventId_attempt'],
    AdverseHold: ['sourceEventId_orderId'],
    AdverseEventEvidence: ['eventId_kind_reference'],
  },
  enumValues: [
    'RECEIVED',
    'LEASED',
    'APPLIED',
    'QUARANTINED',
    'IGNORED',
    'ACTIVE',
    'RELEASED',
  ],
  isolationModels: ['AdverseEvent', 'AdverseEventAttempt', 'AdverseHold', 'AdverseEventEvidence'],
});

console.log('Adverse-intake proposal verification');
console.log('  proposal: prisma/proposals/adverse-intake/schema.prisma');
for (const note of notes) console.log(`  - ${note}`);
if (problems.length === 0) {
  console.log('ADVERSE-INTAKE PROPOSAL VERIFICATION: PASS');
} else {
  console.error(`ADVERSE-INTAKE PROPOSAL VERIFICATION: FAIL (${problems.length} problem(s))`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}
