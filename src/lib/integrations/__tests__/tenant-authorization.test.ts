// Phase 4.2C — tenant authorization at the handoff boundary.
//
// These tests exercise the REAL authorization module against the REAL SQLite
// test database (Tenant / TenantMembership / OpportunityHandoff / Opportunity
// rows). The dispatch seam is fake only in the sense that it does not run the
// pipeline; it still enforces the real Job Runner payload contract. No
// authorization decision is stubbed to `true`: every case goes through
// authorizeHandoffTenant and asserts the resulting row state and audit trail.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobOutcome, JobType } from '@/lib/jobs/types';
import { validateJobPayload } from '@/lib/jobs/job-definitions';
import { installTestDatabase } from '@/test-utils/install-test-database';
import {
  authorizeHandoffTenant,
  type TenantAuthorizationDb,
} from '../tenant-authorization';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-tenantauth-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  OPERATOR_CONTROL_TOKEN: 'test-operator-token-value',
});

before(() => {
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

type Db = (typeof import('@/lib/db'))['db'];
type Receiver = typeof import('../handoff-receiver');

let db: Db;
let receiver: Receiver;

before(async () => {
  ({ db } = await import('@/lib/db'));
  receiver = await import('../handoff-receiver');
});

/** Real Job Runner contract enforced; the pipeline itself is not executed. */
function dispatchRecorder() {
  const calls: { jobType: string; payload: Record<string, unknown> }[] = [];
  const runJob = async (jobType: JobType, payload: Record<string, unknown>): Promise<JobOutcome> => {
    const validation = validateJobPayload(jobType, payload);
    assert.ok(validation.valid, validation.errors.join('; '));
    calls.push({ jobType, payload });
    return {
      jobId: `job-${calls.length}`,
      jobType,
      status: 'SUCCEEDED',
      deduplicated: false,
      result: { status: 'COMPLETED', runId: `run-${calls.length}`, humanReviewRequired: false },
      error: null,
      executionMode: 'MOCKED',
      retryCount: 0,
    };
  };
  return { calls, runJob };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '1.0',
    contractId: 'aiagent.income-lab.opportunity-handoff',
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    correlationId: `corr-${Math.random().toString(36).slice(2)}`,
    eventType: 'OPPORTUNITY_PROPOSED',
    title: 'Practical Notion workspace setup guide for small solo operators',
    description:
      'A short practical guide that helps solo operators set up one clean workspace for notes, tasks and clients.',
    category: 'DIGITAL_PRODUCT',
    businessModel: 'DIRECT_SALES',
    monetizationMethod: 'ONE_TIME_PURCHASE',
    assertedEligibility: 'ALLOWED',
    payload: { suggestedPriceUsd: 29 },
    ...overrides,
  };
}

function authorizeFor(principal: string, requested: string | null) {
  return authorizeHandoffTenant({
    db: db as unknown as TenantAuthorizationDb,
    principalFingerprint: principal,
    requestedTenantSlug: requested,
  });
}

/** Create a tenant + membership pair. */
async function seedTenant(
  slug: string,
  principal: string,
  opts: { tenantStatus?: string; membershipStatus?: string; role?: string } = {},
) {
  const tenant = await db.tenant.create({
    data: { slug, name: slug, status: opts.tenantStatus ?? 'ACTIVE' },
  });
  await db.tenantMembership.create({
    data: {
      tenantId: tenant.id,
      principalFingerprint: principal,
      role: opts.role ?? 'SENDER',
      status: opts.membershipStatus ?? 'ACTIVE',
    },
  });
  return tenant;
}

describe('Phase 4.2C — tenant authorization', () => {
  it('authorizes a member and binds the handoff + opportunity to that tenant', async () => {
    const principal = 'principal-alpha';
    const tenant = await seedTenant('alpha', principal);
    const dispatch = dispatchRecorder();

    const body = envelope();
    const result = await receiver.receiveHandoff(body, {
      db: db as never,
      senderIdentity: principal,
      runJob: dispatch.runJob,
      requestedTenantSlug: 'alpha',
      authorizeTenant: ({ principalFingerprint, requestedTenantSlug }) =>
        authorizeFor(principalFingerprint, requestedTenantSlug ?? null),
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.handoff, 'ACCEPTED');

    const row = await db.opportunityHandoff.findUnique({
      where: { idempotencyKey: String(body.idempotencyKey) },
    });
    assert.ok(row);
    assert.equal(row?.tenantId, tenant.id, 'the handoff must be bound to the authorized tenant');
    assert.ok(row?.payloadHash, 'the delivery body fingerprint must be recorded');
    assert.ok(row?.opportunityId, 'the intake must create a linked opportunity');

    const opp = await db.opportunity.findUnique({ where: { id: row!.opportunityId! } });
    assert.equal(opp?.tenantId, tenant.id, 'the opportunity must carry the same tenant');
    assert.equal(opp?.halalStatus, 'HALAL');

    const audit = await db.securityEvent.findFirst({
      where: { kind: 'TENANT_AUTHORIZED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(audit, 'an authorization decision must be audited');
    assert.ok(!String(audit?.detail ?? '').includes(principal), 'audit must not echo the principal');
  });

  it('resolves the only membership when the caller names no tenant', async () => {
    const principal = 'principal-solo';
    const tenant = await seedTenant('solo', principal);
    const dispatch = dispatchRecorder();

    const result = await receiver.receiveHandoff(envelope(), {
      db: db as never,
      senderIdentity: principal,
      runJob: dispatch.runJob,
      authorizeTenant: ({ principalFingerprint, requestedTenantSlug }) =>
        authorizeFor(principalFingerprint, requestedTenantSlug ?? null),
    });

    assert.equal(result.ok, true);
    const row = await db.opportunityHandoff.findFirst({ where: { senderIdentity: principal } });
    assert.equal(row?.tenantId, tenant.id);
  });

  it('allows an ADMIN membership to submit', async () => {
    const principal = 'principal-admin';
    await seedTenant('admin-tenant', principal, { role: 'ADMIN' });
    const decision = await authorizeFor(principal, 'admin-tenant');
    assert.equal(decision.ok, true);
  });

  it('refuses a missing principal', async () => {
    const decision = await authorizeFor('', 'alpha');
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.status, 403);
    assert.equal(decision.ok === false && decision.reason, 'MISSING_PRINCIPAL');
  });

  it('refuses a principal with no membership and binds nothing', async () => {
    const dispatch = dispatchRecorder();
    const body = envelope();
    const result = await receiver.receiveHandoff(body, {
      db: db as never,
      senderIdentity: 'principal-unknown',
      runJob: dispatch.runJob,
      requestedTenantSlug: 'alpha',
      authorizeTenant: ({ principalFingerprint, requestedTenantSlug }) =>
        authorizeFor(principalFingerprint, requestedTenantSlug ?? null),
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 403);
    assert.equal(dispatch.calls.length, 0, 'an unauthorized delivery must never dispatch work');
    const row = await db.opportunityHandoff.findUnique({
      where: { idempotencyKey: String(body.idempotencyKey) },
    });
    assert.equal(row, null, 'an unauthorized delivery must not be persisted');
    const audit = await db.securityEvent.findFirst({
      where: { kind: 'HANDOFF_TENANT_REFUSED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(audit, 'the refusal must be audited');
  });

  it('refuses a suspended membership', async () => {
    const principal = 'principal-suspended';
    await seedTenant('suspended', principal, { membershipStatus: 'SUSPENDED' });
    const decision = await authorizeFor(principal, 'suspended');
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, 'NO_MEMBERSHIP');
  });

  it('refuses an inactive tenant', async () => {
    const principal = 'principal-inactive-tenant';
    await seedTenant('inactive', principal, { tenantStatus: 'INACTIVE' });
    const decision = await authorizeFor(principal, 'inactive');
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.status, 403);
    assert.equal(decision.ok === false && decision.reason, 'TENANT_INACTIVE');
  });

  it('refuses a role that may not submit handoffs', async () => {
    const principal = 'principal-viewer';
    await seedTenant('viewer-tenant', principal, { role: 'VIEWER' });
    const decision = await authorizeFor(principal, 'viewer-tenant');
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, 'ROLE_NOT_PERMITTED');
  });

  it('refuses a spoofed tenant target (cross-tenant access)', async () => {
    const principal = 'principal-spoofer';
    await seedTenant('own-tenant', principal);
    const foreign = await seedTenant('foreign-tenant', 'someone-else');
    assert.ok(foreign.id);

    const decision = await authorizeFor(principal, 'foreign-tenant');
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.status, 403);
    assert.equal(decision.ok === false && decision.reason, 'TENANT_NOT_AUTHORIZED');
  });

  it('refuses an ambiguous caller instead of picking a tenant', async () => {
    const principal = 'principal-multi';
    await seedTenant('multi-a', principal);
    await seedTenant('multi-b', principal);
    const decision = await authorizeFor(principal, null);
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.status, 409);
    assert.equal(decision.ok === false && decision.reason, 'TENANT_NOT_REQUESTED');
  });

  it('fails closed when the authorization backend throws', async () => {
    const events: string[] = [];
    const brokenDb = {
      tenantMembership: {
        async findMany() {
          throw new Error('authorization backend down');
        },
      },
      securityEvent: {
        async create({ data }: { data: { kind: string } }) {
          events.push(data.kind);
          return {};
        },
      },
    } as unknown as TenantAuthorizationDb;

    const decision = await authorizeHandoffTenant({
      db: brokenDb,
      principalFingerprint: 'principal-x',
      requestedTenantSlug: 'alpha',
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.status, 503);
    assert.equal(decision.ok === false && decision.reason, 'AUTHORIZATION_UNAVAILABLE');
    assert.deepEqual(events, ['TENANT_ERROR']);
  });

  it('refuses a cross-tenant replay of an existing idempotency key', async () => {
    const principalA = 'principal-replay-a';
    const principalB = 'principal-replay-b';
    await seedTenant('replay-a', principalA);
    await seedTenant('replay-b', principalB);
    const dispatch = dispatchRecorder();
    const body = envelope({ idempotencyKey: 'shared-key-cross-tenant' });

    const first = await receiver.receiveHandoff(body, {
      db: db as never,
      senderIdentity: principalA,
      runJob: dispatch.runJob,
      requestedTenantSlug: 'replay-a',
      authorizeTenant: ({ principalFingerprint, requestedTenantSlug }) =>
        authorizeFor(principalFingerprint, requestedTenantSlug ?? null),
    });
    assert.equal(first.ok, true);

    const replay = await receiver.receiveHandoff(body, {
      db: db as never,
      senderIdentity: principalB,
      runJob: dispatch.runJob,
      requestedTenantSlug: 'replay-b',
      authorizeTenant: ({ principalFingerprint, requestedTenantSlug }) =>
        authorizeFor(principalFingerprint, requestedTenantSlug ?? null),
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.ok === false && replay.status, 403, 'a foreign key is not a duplicate for another tenant');
    assert.equal(dispatch.calls.length, 1, 'no second dispatch may occur');
  });

  it('treats an identical replay as DUPLICATE but a changed body as CONFLICT', async () => {
    const principal = 'principal-idem';
    await seedTenant('idem-tenant', principal);
    const dispatch = dispatchRecorder();
    const body = envelope({ idempotencyKey: 'idem-same-key' });

    const options = {
      db: db as never,
      senderIdentity: principal,
      runJob: dispatch.runJob,
      requestedTenantSlug: 'idem-tenant',
      authorizeTenant: ({
        principalFingerprint,
        requestedTenantSlug,
      }: {
        principalFingerprint: string;
        requestedTenantSlug?: string | null;
      }) => authorizeFor(principalFingerprint, requestedTenantSlug ?? null),
    };

    const first = await receiver.receiveHandoff(body, options);
    assert.equal(first.ok, true);

    const same = await receiver.receiveHandoff(body, options);
    assert.equal(same.ok, true);
    assert.equal(same.ok && same.handoff, 'DUPLICATE');
    assert.equal(dispatch.calls.length, 1);

    const changed = await receiver.receiveHandoff({ ...body, title: 'A different title entirely' }, options);
    assert.equal(changed.ok, false);
    assert.equal(changed.ok === false && changed.status, 409, 'a changed body under one key must be a conflict');
    assert.ok(changed.ok === false && changed.error.includes('different payload'));
    assert.equal(dispatch.calls.length, 1, 'a conflict must never dispatch');
  });

  it('treats a concurrent same-key different-body reservation as CONFLICT', async () => {
    // Simulate losing the create race: the first lookup sees nothing, the create
    // hits the unique index, and the re-read reveals a DIFFERENT body.
    let finds = 0;
    const events: string[] = [];
    const racingDb = {
      opportunityHandoff: {
        async findUnique() {
          finds += 1;
          if (finds === 1) return null;
          return {
            id: 'handoff-race',
            idempotencyKey: 'race-key',
            status: 'ACCEPTED',
            correlationId: 'corr-race',
            jobRunId: 'job-race',
            opportunityId: null,
            halalStatus: 'HALAL',
            eligibility: 'ALLOWED',
            reason: '',
            payloadHash: 'a-different-body-hash',
            tenantId: 'tenant-race',
          };
        },
        async create() {
          throw new Error('Unique constraint failed on idempotencyKey');
        },
        async update() {
          return {};
        },
      },
      securityEvent: {
        async create({ data }: { data: { kind: string } }) {
          events.push(data.kind);
          return {};
        },
      },
    };

    const result = await receiver.receiveHandoff(envelope({ idempotencyKey: 'race-key' }), {
      db: racingDb as never,
      senderIdentity: 'principal-race',
      runJob: async () => {
        throw new Error('a conflict must never dispatch');
      },
      authorizeTenant: async () => ({
        ok: true as const,
        tenantId: 'tenant-race',
        tenantSlug: 'race',
        role: 'SENDER',
        membershipCount: 1,
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 409);
    assert.ok(events.includes('HANDOFF_CONFLICT'), 'the concurrent conflict must be audited');
  });

  it('rejects a body that tries to assert its own sender identity', async () => {
    const dispatch = dispatchRecorder();
    const result = await receiver.receiveHandoff(
      { ...envelope(), senderIdentity: 'spoofed-sender' },
      {
        db: db as never,
        senderIdentity: 'principal-body-spoof',
        runJob: dispatch.runJob,
        requestedTenantSlug: 'alpha',
        authorizeTenant: ({ principalFingerprint, requestedTenantSlug }) =>
          authorizeFor(principalFingerprint, requestedTenantSlug ?? null),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 400);
    assert.ok(result.ok === false && result.errors?.some((e) => /Unknown envelope field/.test(e)));
    assert.equal(dispatch.calls.length, 0);
  });
});
