// Offline verification of the ISOLATED private-delivery Prisma proposal.
//
// Nothing here touches a database, a credential or the active application
// schema. It proves three things:
//
//   1. The proposal is valid for the ACTUALLY INSTALLED Prisma CLI.
//   2. The client it generates exposes the delegate surface the durable
//      delivery contract depends on (models, fields, nullability, uniqueness
//      inputs, enum values).
//   3. Generating it does NOT touch the active schema or the active generated
//      client — the client is generated into a temporary directory that is
//      removed afterwards.
//
// Usage:  node scripts/verify-private-delivery-proposal.mjs
// Exit:   0 = verified, 1 = a check failed.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProposal } from './lib/verify-proposal.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { notes, problems } = verifyProposal({
  root,
  proposalDir: join('prisma', 'proposals', 'private-delivery'),
  activeSchema: join('prisma', 'schema.prisma'),
  activeClientDir: 'generated',
  label: 'private-delivery',
  delegates: [
    'deliveryEntitlement',
    'deliveryEntitlementAsset',
    'deliveryTicket',
    'deliveryTicketAsset',
    'deliveryRecord',
    'deliveryTicketEvent',
  ],
  fields: {
    DeliveryEntitlement: [
      'id',
      'orderId',
      'buyerId',
      'productVersionId',
      'packageId',
      'assetReviewState',
      'state',
      'issuedAt',
      'expiresAt',
      'revokedAt',
      'revocationReason',
      'createdAt',
      'updatedAt',
    ],
    DeliveryEntitlementAsset: [
      'id',
      'entitlementId',
      'assetId',
      'kind',
      'contentHash',
      'sizeBytes',
      'label',
      'createdAt',
    ],
    DeliveryTicket: [
      'id',
      'tokenFingerprint',
      'entitlementId',
      'orderId',
      'buyerId',
      'productVersionId',
      'packageId',
      'state',
      'issuedAt',
      'expiresAt',
      'consumedAt',
      'consumedByDeliveryId',
      'revokedAt',
      'revocationReason',
      'createdAt',
      'updatedAt',
    ],
    DeliveryTicketAsset: [
      'id',
      'ticketId',
      'assetId',
      'kind',
      'contentHash',
      'sizeBytes',
      'label',
      'createdAt',
    ],
    DeliveryRecord: [
      'deliveryId',
      'ticketId',
      'entitlementId',
      'orderId',
      'buyerId',
      'outcome',
      'assetIds',
      'reason',
      'createdAt',
      'updatedAt',
    ],
    DeliveryTicketEvent: ['id', 'ticketId', 'kind', 'reference', 'detail', 'createdAt'],
  },
  nullable: {
    DeliveryEntitlement: ['packageId', 'expiresAt', 'revokedAt', 'revocationReason'],
    DeliveryTicket: [
      'packageId',
      'consumedAt',
      'consumedByDeliveryId',
      'revokedAt',
      'revocationReason',
    ],
  },
  uniques: {
    DeliveryEntitlement: ['orderId_buyerId_productVersionId'],
    DeliveryEntitlementAsset: ['entitlementId_assetId'],
    DeliveryTicket: ['entitlementId_tokenFingerprint'],
    DeliveryTicketAsset: ['ticketId_assetId'],
    DeliveryTicketEvent: ['ticketId_kind_reference'],
  },
  enumValues: [
    'PENDING',
    'GRANTED',
    'REVOKED',
    'EXPIRED',
    'DRAFT',
    'REVIEW_READY',
    'ISSUED',
    'CONSUMED',
    'DELIVERED',
    'FAILED',
    'PRODUCT_PACKAGE',
    'DELIVERABLE_FILE',
    'DOCUMENT',
    'ARCHIVE',
  ],
  isolationModels: [
    'DeliveryEntitlement',
    'DeliveryEntitlementAsset',
    'DeliveryTicket',
    'DeliveryTicketAsset',
    'DeliveryRecord',
    'DeliveryTicketEvent',
  ],
});

console.log('Private-delivery proposal verification');
console.log('  proposal: prisma/proposals/private-delivery/schema.prisma');
for (const note of notes) console.log(`  - ${note}`);
if (problems.length === 0) {
  console.log('PRIVATE-DELIVERY PROPOSAL VERIFICATION: PASS');
} else {
  console.error(`PRIVATE-DELIVERY PROPOSAL VERIFICATION: FAIL (${problems.length} problem(s))`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}
