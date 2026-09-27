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
  jobTypeForEvent,
  resolveEligibility,
  validateHandoffEnvelope,
  type HandoffEnvelope,
} from './handoff-envelope';

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
}

export type CreatedHandoff = ExistingHandoff;

export type HandoffRunJob = (
  jobType: JobType,
  payload: Record<string, unknown>,
  correlationId: string,
) => Promise<JobOutcome>;

export interface ReceiveOptions {
  db: HandoffDb;
  /** Fingerprint of the authenticated sender (never the credential itself). */
  senderIdentity: string;
  runJob: HandoffRunJob;
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
      status: 400 | 409 | 502;
      error: string;
      errors?: string[];
      handoff?: HandoffStatus;
    };

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
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

  // ---- IDEMPOTENCY (read path: replay detection) ------------------------
  const existing = await db.opportunityHandoff.findUnique({
    where: { idempotencyKey: envelope.idempotencyKey },
  });
  if (existing) {
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
      },
    });
  } catch {
    // A unique violation means a concurrent delivery won the race.
    const raced = await db.opportunityHandoff.findUnique({
      where: { idempotencyKey: envelope.idempotencyKey },
    });
    if (raced) {
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

  // ---- DISPATCH (Job Runner remains authoritative) ----------------------
  let outcome: JobOutcome;
  try {
    outcome = await runJob(
      jobType as JobType,
      {
        title: envelope.title,
        description: envelope.description,
        category: envelope.category,
        businessModel: envelope.businessModel,
        monetizationMethod: envelope.monetizationMethod,
        source: 'EXTERNAL_HANDOFF',
        contractId: envelope.contractId,
      },
      envelope.correlationId,
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
  const opportunityId =
    (outcome.result as { opportunityId?: string | null } | null)?.opportunityId ?? null;

  await db.opportunityHandoff
    .update({
      where: { idempotencyKey: envelope.idempotencyKey },
      data: { jobRunId, opportunityId },
    })
    .catch(() => undefined);

  await audit(db, 'HANDOFF_ACCEPTED', 'ok', fingerprint(reservation.id));

  return {
    ok: true,
    status: 201,
    handoff: 'ACCEPTED',
    idempotencyKey: envelope.idempotencyKey,
    correlationId: envelope.correlationId,
    jobRunId,
    duplicate: false,
    detail: 'Delivery accepted and dispatched to the Job Runner.',
  };
}

/** A correlation id the receiver generates when it must supply one itself. */
export function newCorrelationId(): string {
  return `handoff-${randomUUID()}`;
}
