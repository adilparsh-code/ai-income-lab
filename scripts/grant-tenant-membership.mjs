// Phase 4.2C — provision ONE tenant membership (admin tool).
//
// The handoff receiver fails closed: after the tenancy migration, a principal
// with no TenantMembership cannot submit anything. This script is the explicit,
// auditable way to grant that membership. It never runs automatically and never
// prints the credential.
//
// Usage (both forms are explicit; there is no default tenant):
//
//   TENANT_SLUG=acme TENANT_NAME="Acme Ltd" \
//   OPERATOR_TOKEN="<the operator control token>" \
//   node scripts/grant-tenant-membership.mjs
//
//   # or grant by an already-computed fingerprint (no token needed):
//   TENANT_SLUG=acme TENANT_NAME="Acme Ltd" \
//   PRINCIPAL_FINGERPRINT="<16-char fingerprint>" \
//   node scripts/grant-tenant-membership.mjs
//
//   # grant the signed-in ADMIN (console reads/approvals) its membership:
//   TENANT_SLUG=acme TENANT_NAME="Acme Ltd" ADMIN_EMAIL="owner@example.com" \
//   ROLE=ADMIN CONFIRM=yes node scripts/grant-tenant-membership.mjs
//
// The admin principal is `admin:<fingerprint(lowercased email)>`, which matches
// src/lib/tenancy/scope.ts. It is stable across logins (derived from the email,
// never from a session token).
//
// Optional: ROLE=VIEWER|SENDER|ADMIN (default SENDER), TENANT_STATUS=ACTIVE|INACTIVE,
//           MEMBERSHIP_STATUS=ACTIVE|SUSPENDED, CONFIRM=yes (required).
//
// The fingerprint algorithm MUST match src/lib/security/guard.ts
// (credentialFingerprint): HMAC-SHA256(salt, token).hex[0..16].

import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const fail = (message) => {
  console.error(`[grant-tenant-membership] ${message}`);
  process.exit(1);
};

const slug = (process.env.TENANT_SLUG ?? '').trim().toLowerCase();
const name = (process.env.TENANT_NAME ?? '').trim();
const role = (process.env.ROLE ?? 'SENDER').trim().toUpperCase();
const tenantStatus = (process.env.TENANT_STATUS ?? 'ACTIVE').trim().toUpperCase();
const membershipStatus = (process.env.MEMBERSHIP_STATUS ?? 'ACTIVE').trim().toUpperCase();
const token = (process.env.OPERATOR_TOKEN ?? '').trim();
const explicitFingerprint = (process.env.PRINCIPAL_FINGERPRINT ?? '').trim();

if (process.env.CONFIRM !== 'yes') {
  fail('Refusing to write without CONFIRM=yes (this grants a principal authority over a tenant).');
}
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) fail('TENANT_SLUG must be a lowercase slug (2-63 chars).');
if (name.length === 0 || name.length > 120) fail('TENANT_NAME is required (max 120 chars).');
if (!['VIEWER', 'SENDER', 'ADMIN'].includes(role)) fail('ROLE must be VIEWER, SENDER or ADMIN.');
if (!['ACTIVE', 'INACTIVE'].includes(tenantStatus)) fail('TENANT_STATUS must be ACTIVE or INACTIVE.');
if (!['ACTIVE', 'SUSPENDED'].includes(membershipStatus)) fail('MEMBERSHIP_STATUS must be ACTIVE or SUSPENDED.');

const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const salt = (process.env.SECURITY_FINGERPRINT_SALT ?? '').trim() || 'ai-income-lab:fingerprint:v1';
const fingerprintOf = (value) => createHmac('sha256', salt).update(value, 'utf8').digest('hex').slice(0, 16);

let fingerprint = explicitFingerprint;
if (!fingerprint && adminEmail) {
  // Console principal: stable per admin email, matching scope.ts.
  fingerprint = `admin:${fingerprintOf(adminEmail)}`;
} else if (!fingerprint) {
  if (token.length === 0) fail('Provide OPERATOR_TOKEN, ADMIN_EMAIL or PRINCIPAL_FINGERPRINT.');
  fingerprint = fingerprintOf(token);
}
if (!/^(admin:)?[0-9a-f]{16}$/.test(fingerprint)) fail('The fingerprint must be 16 lowercase hex characters (optionally prefixed with admin:).');

const prisma = new PrismaClient();
try {
  const tenant = await prisma.tenant.upsert({
    where: { slug },
    update: { name, status: tenantStatus },
    create: { slug, name, status: tenantStatus },
  });

  const existing = await prisma.tenantMembership.findUnique({
    where: { tenantId_principalFingerprint: { tenantId: tenant.id, principalFingerprint: fingerprint } },
  });
  if (existing) {
    await prisma.tenantMembership.update({
      where: { id: existing.id },
      data: { role, status: membershipStatus },
    });
  } else {
    await prisma.tenantMembership.create({
      data: { tenantId: tenant.id, principalFingerprint: fingerprint, role, status: membershipStatus },
    });
  }

  // Never print the fingerprint or token: only the tenant identity and outcome.
  console.log(
    `[grant-tenant-membership] ${existing ? 'updated' : 'created'} membership: tenant=${tenant.slug} role=${role} membership=${membershipStatus} tenantStatus=${tenantStatus}`,
  );
} catch (error) {
  fail(`write failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await prisma.$disconnect();
}
