// HIGH-1 — Authenticated opportunity handoff receiver (processing layer).
//
// Responsibilities, in the order the platform must enforce them:
//
//   1. AUTH        — the repository's existing operator credential gate
//                    (requireOperator). No second auth system is created.
//   2. VALIDATE    — the delivery envelope contract (handoff-envelope.ts).
//   3. IDEMPOTENCY — the OpportunityHandoff row IS the idempotency record.
//                    A replayed delivery collides on the unique
//                    idempotencyKey and returns DUPLICATE without creating a
//                    second job, opportunity, or revenue effect.
//   4. SAFETY      — eligibility is recomputed server-side from the existing
//                    halal gate. BLOCKED and NEEDS_HUMAN_REVIEW never
//                    dispatch work.
//   5. DISPATCH    — accepted work is handed to the EXISTING Job Runner. The
//                    receiver never executes agents/AI directly and never
//                    accepts a sender-supplied job type.
//   6. AUDIT       — a SecurityEvent row is written for every outcome.
//
// The database seam (HandoffDb) is injected so the route stays thin and the
// tests can drive real persistence against a temporary SQLite database.

import { createHash, randomUUID } from 'node:crypto';
import type { JobOutcome, JobType } from '@/lib/jobs/types';
import {
  HANDOFF_PIPELINE_STAGES,
  jobTypeForEvent,
  resolveEligibility,
  validateHandoffEnvelope,
  MAX_FIELD_LENGTH,
  type HandoffEnvelope,
} from './handoff-envelope';
import { authorizeHandoffTenant } from './tenant-authorization';
import type { TenantAuthorizationDb, TenantAuthorizationResult } from './tenant-authorization';

export const HANDOFF_SURFACE = 'api:handoff:receive';

export type HandoffStatus = 'ACCEPTED' | 'DUPLICATE' | 'BLOCKED' | 'REVIEW_REQUIRED' | 'REJECTED';

export interface HandoffDb {
  opportunityHandoff: {
    findUnique(args: { where: { idempotencyKey: string } }): Promise<ExistingHandoff | null>;
    create(args: { data: NewHandoffData }): Promise<CreatedHandoff>;
    update(args: { where: { idempotencyKey: string }; data: Partial<NewHandoffData> }): Promise<CreatedHandoff>;
  };
  securityEvent: {
    create(args: { data: { kind: string; surface: string; outcome: string; detail?: string | null } }): Promise<unknown>;
  };
  /**
   * Optional opportunity persistence. Present on the real Prisma client; a
   * handoff that is authorized and halal-clean creates exactly one tenant-bound
   * Opportunity so downstream stages and audits have a stable subject.
   */
  opportunity?: {
    create(args: {
      data: {
        title: string;
        category: string;
        businessModel: string;
        targetAudience: string;
        problemSolved: string;
        monetizationMethod: string;
        halalStatus: string;
        status: string;
        tenantId?: string | null;
      };
    }): Promise<{ id: string }>;
  };
  /**
   * Present on the real Prisma client. When it exists, tenant authorization is
   * ALWAYS enforced: a caller cannot skip it by omitting `authorizeTenant`.
   */
  tenantMembership?: TenantAuthorizationDb['tenantMembership'];
  /** Optional review-boundary record; created only when the pipeline asks for it. */
  humanReview?: {
    create(args: {
      data: {
        category: string;
        title: string;
        detail: string;
        status: string;
        requestedBy: string;
        opportunityId?: string | null;
        evidenceRefs?: string;
        correlationId?: string | null;
        tenantId?: string | null;
      };
    }): Promise<unknown>;
  };
}

export interface ExistingHandoff {
  id: string;
  idempotencyKey: string;
  status: string;
  correlationId: string;
  jobRunId: string | null;
  opportunityId: string | null;
  halalStatus: string;
  eligibility: string;
  reason: string;
  /** Present on rows written since Phase 4.2C; used to detect a body change. */
  payloadHash?: string | null;
  tenantId?: string | null;
}

export interface NewHandoffData {
  contractVersion: string;
  contractId: string;
  idempotencyKey: string;
  correlationId: string;
  eventType: string;
  senderIdentity: string;
  title: string;
  payloadJson: string;
  assertedEligibility: string;
  eligibility: string;
  halalStatus: string;
  jobType: string;
  status: string;
  jobRunId?: string | null;
  opportunityId?: string | null;
  reason: string;
  tenantId?: string | null;
  payloadHash?: string | null;
}

export type CreatedHandoff = ExistingHandoff;

export type HandoffRunJob = (
  jobType: JobType,
  payload: Record<string, unknown>,
  correlationId: string,
  options?: { tenantId?: string | null },
) => Promise<JobOutcome>;

export interface ReceiveOptions {
  db: HandoffDb;
  /** Fingerprint of the authenticated sender (never the credential itself). */
  senderIdentity: string;
  runJob: HandoffRunJob;
  /**
   * Tenant target requested by the caller. An ADDRESS, never a grant: it is
   * validated against server-side membership before anything is persisted.
   */
  requestedTenantSlug?: string | null;
  /**
   * Tenant authorization seam. When provided, a delivery is refused unless the
   * authenticated principal holds an active membership for the resolved tenant.
   * The HTTP route ALWAYS provides it; direct callers that omit it get today's
   * single-tenant behaviour with `tenantId: null` recorded.
   */
  authorizeTenant?: (input: {
    principalFingerprint: string;
    requestedTenantSlug?: string | null;
  }) => Promise<TenantAuthorizationResult>;
}

export type ReceiveResult =
  | {
      ok: true;
      status: 201 | 200;
      handoff: HandoffStatus;
      idempotencyKey: string;
      correlationId: string;
      jobRunId?: string | null;
      duplicate: boolean;
      detail: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 409 | 502 | 503;
      error: string;
      errors?: string[];
      handoff?: HandoffStatus;
    };

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/** Deterministic JSON: object keys sorted so equal bodies hash equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Fingerprint of the delivered body with the idempotency key excluded.
 * A replay with the same key but a different body is a CONFLICT, not a
 * duplicate: otherwise a sender could silently rewrite an accepted delivery.
 */
export function canonicalPayloadHash(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return createHash('sha256').update(canonicalJson(raw), 'utf8').digest('hex');
  }
  const body = { ...(raw as Record<string, unknown>) };
  delete body.idempotencyKey;
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

async function audit(
  db: HandoffDb,
  kind: string,
  outcome: 'ok' | 'refused' | 'error',
  detail?: string,
): Promise<void> {
  try {
    await db.securityEvent.create({
      data: {
        kind,
        surface: HANDOFF_SURFACE,
        outcome,
        detail: detail ? detail.slice(0, 300) : null,
      },
    });
  } catch {
    // Auditing must never break the request path.
  }
}

async function persistSafe(
  db: HandoffDb,
  args: {
    envelope: HandoffEnvelope;
    senderIdentity: string;
    jobType: string;
    status: HandoffStatus;
    eligibility: string;
    halalStatus: string;
    payloadJson: string;
    reason: string;
    tenantId?: string | null;
    payloadHash?: string | null;
  },
): Promise<void> {
  try {
    await db.opportunityHandoff.create({
      data: {
        contractVersion: args.envelope.contractVersion,
        contractId: args.envelope.contractId,
        idempotencyKey: args.envelope.idempotencyKey,
        correlationId: args.envelope.correlationId,
        eventType: args.envelope.eventType,
        senderIdentity: args.senderIdentity,
        title: args.envelope.title,
        payloadJson: args.payloadJson,
        assertedEligibility: args.envelope.assertedEligibility,
        eligibility: args.eligibility,
        halalStatus: args.halalStatus,
        jobType: args.jobType,
        status: args.status,
        reason: args.reason,
        ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
        ...(args.payloadHash !== undefined ? { payloadHash: args.payloadHash } : {}),
      },
    });
  } catch {
    // A duplicate key here means a prior delivery was already recorded. Any
    // other failure must not change the verdict we already decided on.
  }
}

/**
 * Process one delivery envelope end to end.
 *
 * Returns a typed verdict the route maps to an HTTP response. Caller errors
 * never throw; infrastructure failures surface as 502 without leaking details.
 */
export async function receiveHandoff(raw: unknown, options: ReceiveOptions): Promise<ReceiveResult> {
  const { db, senderIdentity, runJob } = options;

  // ---- VALIDATE ---------------------------------------------------------
  const validation = validateHandoffEnvelope(raw);
  if (!validation.ok) {
    await audit(db, 'HANDOFF_REJECTED', 'refused', 'envelope-validation');
    return {
      ok: false,
      status: 400,
      error: 'Invalid delivery envelope.',
      errors: validation.errors,
      handoff: 'REJECTED',
    };
  }
  const envelope: HandoffEnvelope = validation.envelope;
  const payloadHash = canonicalPayloadHash(raw);

  // ---- TENANT AUTHORIZATION (fail-closed, server-side) ------------------
  // Runs BEFORE idempotency so a cross-tenant caller cannot even learn that a
  // given idempotency key exists. The principal is the authenticated credential
  // fingerprint; the request may only name a tenant it already belongs to.
  // Fail closed: when the database can resolve memberships, authorization is
  // mandatory. A caller may inject its own seam, but it cannot opt out.
  const authorizeTenant =
    options.authorizeTenant ??
    (db.tenantMembership
      ? ({ principalFingerprint, requestedTenantSlug }: { principalFingerprint: string; requestedTenantSlug?: string | null }) =>
          authorizeHandoffTenant({
            db: db as unknown as TenantAuthorizationDb,
            principalFingerprint,
            requestedTenantSlug,
          })
      : null);

  let tenantId: string | null = null;
  if (authorizeTenant) {
    const decision = await authorizeTenant({
      principalFingerprint: senderIdentity,
      requestedTenantSlug: options.requestedTenantSlug ?? null,
    });
    if (!decision.ok) {
      await audit(db, 'HANDOFF_TENANT_REFUSED', 'refused', decision.reason);
      return {
        ok: false,
        status: decision.status,
        error: decision.error,
        handoff: 'REJECTED',
      };
    }
    tenantId = decision.tenantId;
  }

  // ---- IDEMPOTENCY (read path: replay detection) ------------------------
  const existing = await db.opportunityHandoff.findUnique({
    where: { idempotencyKey: envelope.idempotencyKey },
  });
  if (existing) {
    // Same key, different body: refuse. Returning DUPLICATE here would let a
    // sender quietly replace the content of an already-accepted delivery.
    if (existing.payloadHash && payloadHash && existing.payloadHash !== payloadHash) {
      await audit(db, 'HANDOFF_CONFLICT', 'refused', 'idempotency-key-reused');
      return {
        ok: false,
        status: 409,
        error: 'Delivery rejected: this idempotency key was already used with a different payload.',
        handoff: 'REJECTED',
      };
    }
    // A key belonging to another tenant is never a duplicate for this one.
    if (tenantId && existing.tenantId && existing.tenantId !== tenantId) {
      await audit(db, 'HANDOFF_TENANT_REFUSED', 'refused', 'cross-tenant-replay');
      return {
        ok: false,
        status: 403,
        error: 'Forbidden: that delivery does not belong to this tenant.',
        handoff: 'REJECTED',
      };
    }
    await audit(db, 'HANDOFF_DUPLICATE', 'ok', 'replay-detected');
    return {
      ok: true,
      status: 200,
      handoff: 'DUPLICATE',
      idempotencyKey: existing.idempotencyKey,
      correlationId: existing.correlationId,
      jobRunId: existing.jobRunId,
      duplicate: true,
      detail: 'Delivery already processed; no new work was created.',
    };
  }

  // ---- SAFETY (server-recomputed, never sender-asserted) ----------------
  const eligibility = resolveEligibility(envelope);
  const jobType = jobTypeForEvent(envelope.eventType);
  const payloadJson = JSON.stringify(envelope.payload ?? {});

  if (eligibility.eligibility === 'BLOCKED') {
    await persistSafe(db, {
      envelope,
      senderIdentity,
      jobType,
      status: 'BLOCKED',
      eligibility: eligibility.eligibility,
      halalStatus: eligibility.halalStatus,
      payloadJson,
      reason: 'Halal screening: NOT_ALLOWED. No work dispatched.',
      tenantId,
      payloadHash,
    });
    await audit(db, 'HANDOFF_BLOCKED', 'refused', 'halal-not-allowed');
    return {
      ok: false,
      status: 409,
      error: 'Delivery rejected: the opportunity did not pass halal screening.',
      handoff: 'BLOCKED',
    };
  }

  if (eligibility.eligibility === 'NEEDS_HUMAN_REVIEW') {
    await persistSafe(db, {
      envelope,
      senderIdentity,
      jobType,
      status: 'REVIEW_REQUIRED',
      eligibility: eligibility.eligibility,
      halalStatus: eligibility.halalStatus,
      payloadJson,
      reason: 'Halal screening: REVIEW_REQUIRED. Awaiting human review; no work dispatched.',
      tenantId,
      payloadHash,
    });
    await audit(db, 'HANDOFF_REVIEW_REQUIRED', 'refused', 'halal-review-required');
    return {
      ok: false,
      status: 409,
      error: 'Delivery requires human review before any work is executed.',
      handoff: 'REVIEW_REQUIRED',
    };
  }

  // ---- RESERVE (write path: claim the idempotency key) ------------------
  // The unique index on idempotencyKey is the real concurrency control: if two
  // identical deliveries race, exactly one insert succeeds.
  let reservation: CreatedHandoff;
  try {
    reservation = await db.opportunityHandoff.create({
      data: {
        contractVersion: envelope.contractVersion,
        contractId: envelope.contractId,
        idempotencyKey: envelope.idempotencyKey,
        correlationId: envelope.correlationId,
        eventType: envelope.eventType,
        senderIdentity,
        title: envelope.title,
        payloadJson,
        assertedEligibility: envelope.assertedEligibility,
        eligibility: eligibility.eligibility,
        halalStatus: eligibility.halalStatus,
        jobType,
        status: 'ACCEPTED',
        reason: 'Accepted and dispatched to the Job Runner.',
        ...(tenantId !== null ? { tenantId } : {}),
        payloadHash,
      },
    });
  } catch {
    // A unique violation means a concurrent delivery won the race.
    const raced = await db.opportunityHandoff.findUnique({
      where: { idempotencyKey: envelope.idempotencyKey },
    });
    if (raced) {
      // The concurrent winner may hold a DIFFERENT body under the same key. That
      // is a conflict, not a duplicate — otherwise losing the race would let a
      // sender rewrite the accepted delivery.
      if (raced.payloadHash && raced.payloadHash !== payloadHash) {
        await audit(db, 'HANDOFF_CONFLICT', 'refused', 'concurrent-key-reuse');
        return {
          ok: false,
          status: 409,
          error: 'Delivery rejected: this idempotency key was already used with a different payload.',
          handoff: 'REJECTED',
        };
      }
      if (tenantId && raced.tenantId && raced.tenantId !== tenantId) {
        await audit(db, 'HANDOFF_TENANT_REFUSED', 'refused', 'cross-tenant-replay');
        return {
          ok: false,
          status: 403,
          error: 'Forbidden: that delivery does not belong to this tenant.',
          handoff: 'REJECTED',
        };
      }
      await audit(db, 'HANDOFF_DUPLICATE', 'ok', 'concurrent-replay');
      return {
        ok: true,
        status: 200,
        handoff: 'DUPLICATE',
        idempotencyKey: raced.idempotencyKey,
        correlationId: raced.correlationId,
        jobRunId: raced.jobRunId,
        duplicate: true,
        detail: 'Delivery already processed; no new work was created.',
      };
    }
    await audit(db, 'HANDOFF_ERROR', 'error', 'reservation-failed');
    return {
      ok: false,
      status: 502,
      error: 'Receiver could not persist the delivery. Nothing was executed.',
    };
  }

  // ---- OPPORTUNITY (tenant-bound intake record) -------------------------
  // The handoff is the intake stage, so the opportunity it proposes becomes a
  // real, tenant-bound Opportunity row BEFORE any research runs. This is what
  // makes downstream stages, audit and review traceable to one subject.
  // Optional seam: a caller without opportunity persistence keeps the legacy
  // job-only behaviour instead of failing.
  let opportunityId: string | null = null;
  if (db.opportunity) {
    try {
      const created = await db.opportunity.create({
        data: {
          title: envelope.title,
          category: envelope.category,
          businessModel: envelope.businessModel,
          targetAudience:
            typeof envelope.payload.targetAudience === 'string'
              ? envelope.payload.targetAudience.slice(0, MAX_FIELD_LENGTH)
              : envelope.description.slice(0, MAX_FIELD_LENGTH),
          problemSolved: envelope.description.slice(0, MAX_FIELD_LENGTH),
          monetizationMethod: envelope.monetizationMethod,
          halalStatus: eligibility.halalStatus,
          status: 'IDEA',
          tenantId,
        },
      });
      opportunityId = created.id;
    } catch {
      await db.opportunityHandoff
        .update({
          where: { idempotencyKey: envelope.idempotencyKey },
          data: { status: 'REJECTED', reason: 'Opportunity persistence failed.' },
        })
        .catch(() => undefined);
      await audit(db, 'HANDOFF_ERROR', 'error', 'opportunity-persist-failed');
      return {
        ok: false,
        status: 502,
        error: 'Receiver could not record the opportunity. Nothing was executed.',
      };
    }
  }

  // ---- DISPATCH (Job Runner remains authoritative) ----------------------
  // The payload must satisfy the Job Runner's per-type contract
  // (validateJobPayload). An accepted handoff now runs the EXISTING bounded
  // opportunity pipeline — research, validation, product CONCEPT — and stops at
  // the human-review boundary. The objective is clipped to the envelope bound
  // so the mapping stays bounded, and the stage list is a server constant.
  let outcome: JobOutcome;
  try {
    outcome = await runJob(
      jobType as JobType,
      {
        objective: envelope.description.slice(0, MAX_FIELD_LENGTH),
        researchObjective: envelope.description.slice(0, MAX_FIELD_LENGTH),
        ...(opportunityId ? { opportunityId } : {}),
        stages: [...HANDOFF_PIPELINE_STAGES],
        title: envelope.title,
        description: envelope.description,
        category: envelope.category,
        businessModel: envelope.businessModel,
        monetizationMethod: envelope.monetizationMethod,
        source: 'EXTERNAL_HANDOFF',
        contractId: envelope.contractId,
      },
      envelope.correlationId,
      // Phase 4.2D — the AUTHORIZED tenant, never the raw header value.
      { tenantId },
    );
  } catch {
    // The reservation stays, marked failed, so a replay cannot silently
    // re-trigger the work. Operators can inspect the row.
    await db.opportunityHandoff
      .update({
        where: { idempotencyKey: envelope.idempotencyKey },
        data: { status: 'REJECTED', reason: 'Job Runner dispatch failed.' },
      })
      .catch(() => undefined);
    await audit(db, 'HANDOFF_ERROR', 'error', 'job-runner-threw');
    return {
      ok: false,
      status: 502,
      error: 'Dispatch to the Job Runner failed. No work was completed.',
    };
  }

  const jobRunId = outcome.jobId ?? null;
  const result = (outcome.result ?? {}) as {
    opportunityId?: string | null;
    runId?: string | null;
    status?: string;
    humanReviewRequired?: boolean;
  };
  const linkedOpportunityId = opportunityId ?? result.opportunityId ?? null;
  const pipelineRunId = result.runId ?? null;

  await db.opportunityHandoff
    .update({
      where: { idempotencyKey: envelope.idempotencyKey },
      data: { jobRunId, opportunityId: linkedOpportunityId },
    })
    .catch(() => undefined);

  // ---- HUMAN REVIEW BOUNDARY -------------------------------------------
  // When the pipeline reports that the concept needs a human decision, record a
  // PENDING review record that points at the pipeline run. Nothing is approved,
  // published, priced or charged here; the record only asks for the decision.
  const humanReviewRequired =
    result.humanReviewRequired === true || outcome.status === 'HUMAN_REVIEW';
  if (humanReviewRequired && db.humanReview) {
    try {
      await db.humanReview.create({
        data: {
          category: 'SAFETY_REVIEW',
          title: `Review ${envelope.title}`.slice(0, 300),
          detail: 'Handoff pipeline produced a research/validation/product-concept bundle that requires a human decision before any commercial step.',
          status: 'PENDING',
          requestedBy: 'handoff-receiver',
          opportunityId: linkedOpportunityId,
          evidenceRefs: JSON.stringify({
            pipelineRunId,
            jobRunId,
            correlationId: envelope.correlationId,
            stages: [...HANDOFF_PIPELINE_STAGES],
          }),
          correlationId: envelope.correlationId,
          tenantId,
        },
      });
    } catch {
      // A review record failing to persist must not turn an accepted delivery
      // into a silent success: it is audited, and the run already asked for review.
      await audit(db, 'HANDOFF_ERROR', 'error', 'human-review-persist-failed');
    }
  }

  await audit(db, 'HANDOFF_ACCEPTED', 'ok', fingerprint(reservation.id));

  return {
    ok: true,
    status: 201,
    handoff: 'ACCEPTED',
    idempotencyKey: envelope.idempotencyKey,
    correlationId: envelope.correlationId,
    jobRunId,
    duplicate: false,
    detail: humanReviewRequired
      ? 'Delivery accepted and executed to the human-review boundary; nothing was approved or published.'
      : 'Delivery accepted and dispatched to the Job Runner.',
  };
}

/** A correlation id the receiver generates when it must supply one itself. */
export function newCorrelationId(): string {
  return `handoff-${randomUUID()}`;
}
