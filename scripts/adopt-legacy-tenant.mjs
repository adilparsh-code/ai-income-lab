// Phase 4.2D — EXPLICIT adoption of pre-tenancy rows into a tenant (admin tool).
//
// Why this exists: migration 0015 deliberately does NOT backfill. Rows created
// before tenancy have tenantId = NULL and are visible only in the "legacy"
// partition (the global operator). A tenant can never see them, and we must not
// guess an owner. When an operator has PROVEN which tenant owns those rows, this
// script performs the adoption clearly and prints only counts.
//
// Safety:
//   * CONFIRM=yes is mandatory.
//   * It only ever touches rows where tenantId IS NULL (never re-owns rows).
//   * It refuses an INACTIVE/nonexistent tenant.
//   * It does not invent relationships: a legacy job with a NULL opportunity
//     stays NULL; only the tenant attribution is set.
//
// Usage:
//   TENANT_SLUG=acme CONFIRM=yes \
//     node scripts/adopt-legacy-tenant.mjs
//
// Optional: DRY_RUN=yes to print counts without writing.

import { PrismaClient } from '@prisma/client';

const fail = (message) => {
  console.error(`[adopt-legacy-tenant] ${message}`);
  process.exit(1);
};

const slug = (process.env.TENANT_SLUG ?? '').trim().toLowerCase();
const dryRun = process.env.DRY_RUN === 'yes';

if (process.env.CONFIRM !== 'yes') fail('Refusing to write without CONFIRM=yes.');
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) fail('TENANT_SLUG must be a lowercase slug (2-63 chars).');

const prisma = new PrismaClient();
try {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) fail(`No tenant with slug "${slug}". Create it first with grant-tenant-membership.mjs.`);
  if (String(tenant.status).toUpperCase() !== 'ACTIVE') fail('The tenant is not ACTIVE; refusing to adopt rows into it.');

  const targets = [
    ['opportunity', prisma.opportunity],
    ['opportunityHandoff', prisma.opportunityHandoff],
    ['jobRun', prisma.jobRun],
    ['pipelineRun', prisma.pipelineRun],
    ['researchResult', prisma.researchResult],
    ['humanReview', prisma.humanReview],
    ['productSpecification', prisma.productSpecification],
    ['approvalGrant', prisma.approvalGrant],
  ];

  for (const [label, model] of targets) {
    const where = { tenantId: null };
    const count = await model.count({ where });
    if (dryRun || count === 0) {
      console.log(`${label}: ${count} unattributed row(s)${dryRun ? ' (dry run)' : ''}`);
      continue;
    }
    const result = await model.updateMany({ where, data: { tenantId: tenant.id } });
    console.log(`${label}: adopted ${result.count} row(s)`);
  }

  console.log(`[adopt-legacy-tenant] ${dryRun ? 'DRY RUN complete' : 'adoption complete'} for tenant=${tenant.slug}`);
  console.log('[adopt-legacy-tenant] Product rows inherit tenancy through Opportunity; no separate adoption is needed.');
} catch (error) {
  fail(`adoption failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await prisma.$disconnect();
}
