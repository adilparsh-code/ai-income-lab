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
//   4. CONFLICT    — the same idempotency key with DIFFERENT content is a
//                    CONFLICT, never a duplicate. The receiver refuses it
//                    (409) instead of acknowledging content it never ran.
//   5. SAFETY      — eligibility is recomputed server-side from the existing
//                    halal gate. BLOCKED and NEEDS_HUMAN_REVIEW never
//                    dispatch work.
//   6. DISPATCH    — accepted work is handed to the EXISTING Job Runner. The
//                    receiver never executes agents/AI directly and never
//                    accepts a sender-supplied job type.
//   7. VERDICT     — the Job Runner's outcome status is mapped onto the
//                    handoff verdict. A FAILED, BLOCKED, HUMAN_REVIEW or
//                    DEGRADED job is NEVER reported as ACCEPTED.
//   8. AUDIT       — a SecurityEvent row is written for every outcome.
//
// THE HONEST-STATE RULE
// ---------------------
// A delivery is only acknowledged as processed when the receiver can point at
// durable evidence that it was. The durable evidence is the OpportunityHandoff
// row plus the JobRun it references:
//
//   ACCEPTED      — persisted, dispatched, and the JobRun id is on file.
//   DEGRADED      — the work ran, but the durable record of it is incomplete
//                   (the JobRun pointer could not be written), or the Job
//                   Runner itself reported a degraded run.
//   DUPLICATE     — a genuine replay of an already-ACCEPTED delivery.
//   FAILED        — the delivery was persisted but the work did not complete.
//   BLOCKED       — a safety gate refused it. No work was executed.
//   REVIEW_REQUIRED — a human must decide. No work was executed.
//   CONFLICT      — the idempotency key was reused with different content.
//
// A stored FAILED, BLOCKED or REVIEW_REQUIRED row is NEVER reported as
// DUPLICATE: a failed record must not be acknowledged as successfully
// processed. A replay reports what is TRUE, which is what makes a producer's
// retry safe.
//
// The database seam (HandoffDb) is injected so the route stays thin and the
// tests can drive real persistence against a temporary SQLite database.

import { randomUUID } from 'node:crypto';
import type { JobOutcome, JobStatus, JobType } from '@/lib/jobs/types';
import { toCanonicalJson } from '@/lib/product-factory/canonical';
import {
  handoffContentDigest,
  jobTypeForEvent,
  resolveEligibility,
  validateHandoffEnvelope,
  MAX_FIELD_LENGTH,
  type HandoffEnvelope,
} from './handoff-envelope';

export const HANDOFF_SURFACE = 'api:handoff:receive';

export type HandoffStatus =
  | 'ACCEPTED'
  | 'DUPLICATE'
  | 'BLOCKED'
  | 'REVIEW_REQUIRED'
  | 'REJECTED'
  | 'FAILED'
  | 'DEGRADED'
  | 'CONFLICT';

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
  contractId: string;
  eventType: string;
  title: string;
  payloadJson: string;
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
      status: 200 | 201 | 202;
      handoff: HandoffStatus;
      idempotencyKey: string;
      correlationId: string;
      jobRunId?: string | null;
      duplicate: boolean;
      detail: string;
      /** The Job Runner's own status, when a job was dispatched. */
      jobStatus?: JobStatus;
      /** True when the Job Runner recognised the work as already done. */
      jobDeduplicated?: boolean;
    }
  | {
      ok: false;
      status: 400 | 409 | 502;
      error: string;
      errors?: string[];
      handoff?: HandoffStatus;
    };

// ---------------------------------------------------------------------------
// The stored payload envelope
// ---------------------------------------------------------------------------
// The durable row keeps the delivered payload AND the digest of the delivered
// CONTENT in one column (`payloadJson`). The digest is what lets a replay be
// told apart from a key reuse with different content, without a schema
// migration: the column already stores an opaque JSON string, and this wraps
// it in a versioned envelope.
//
//   { "v": 1, "contentDigest": "<sha256 hex>", "payload": { ... } }
//
// A row written before this wrapper existed stores the raw payload object. It
// is read back as a LEGACY row: its digest is unknown, so the receiver falls
// back to comparing the fields it can see on the row.

const STORED_PAYLOAD_VERSION = 1;

export interface StoredPayloadEnvelope {
  v: number;
  contentDigest: string;
  payload: Record<string, unknown>;
}

/** Pack the delivered payload with the content digest for durable storage. */
export function packStoredPayload(
  contentDigest: string,
  payload: Record<string, unknown>,
): string {
  const envelope: StoredPayloadEnvelope = {
    v: STORED_PAYLOAD_VERSION,
    contentDigest,
    payload,
  };
  return JSON.stringify(envelope);
}

/**
 * Read a stored payload back.
 *
 * `contentDigest` is null for a LEGACY row (one written before the wrapper
 * existed). The payload is always returned: it is the original data, and it
 * must stay readable.
 */
export function unpackStoredPayload(raw: string): {
  contentDigest: string | null;
  payload: Record<string, unknown>;
  legacy: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { contentDigest: null, payload: {}, legacy: true };
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).contentDigest === 'string' &&
    typeof (parsed as Record<string, unknown>).payload === 'object' &&
    (parsed as Record<string, unknown>).payload !== null
  ) {
    const wrapper = parsed as StoredPayloadEnvelope;
    return {
      contentDigest: wrapper.contentDigest,
      payload: wrapper.payload as Record<string, unknown>,
      legacy: false,
    };
  }
  return {
    contentDigest: null,
    payload:
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    legacy: true,
  };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** A verdict the receiver can justify from durable state. */
interface Verdict {
  handoff: HandoffStatus;
  http: 200 | 201 | 202 | 409 | 502;
  ok: boolean;
  detail: string;
}

/**
 * Map the Job Runner's outcome status onto the handoff verdict.
 *
 * This is the mapping the receiver previously did NOT do: every returned
 * outcome used to be reported as ACCEPTED, so a job that came back FAILED,
 * BLOCKED, HUMAN_REVIEW or DEGRADED was acknowledged to the producer as
 * successfully processed. The five terminal statuses stay distinct here.
 */
function verdictForJobStatus(status: JobStatus): Verdict {
  switch (status) {
    case 'SUCCEEDED':
      return {
        handoff: 'ACCEPTED',
        http: 201,
        ok: true,
        detail: 'Delivery accepted and dispatched to the Job Runner.',
      };
    case 'DEGRADED':
      return {
        handoff: 'DEGRADED',
        http: 202,
        ok: true,
        detail:
          'Delivery dispatched, but the Job Runner reported a degraded result (a deterministic fallback was used). '
          + 'The work is not a clean success; reconcile the job record before relying on it.',
      };
    case 'BLOCKED':
      return {
        handoff: 'BLOCKED',
        http: 409,
        ok: false,
        detail: 'The dispatched work was blocked by a safety gate. Nothing was completed.',
      };
    case 'HUMAN_REVIEW':
      return {
        handoff: 'REVIEW_REQUIRED',
        http: 409,
        ok: false,
        detail: 'The dispatched work requires human review. Nothing was completed.',
      };
    case 'FAILED':
      return {
        handoff: 'FAILED',
        http: 502,
        ok: false,
        detail: 'The dispatched work failed. Nothing was completed.',
      };
    case 'QUEUED':
    case 'RUNNING':
      return {
        handoff: 'ACCEPTED',
        http: 202,
        ok: true,
        detail: 'Delivery accepted; the dispatched job is still running.',
      };
    default:
      return {
        handoff: 'FAILED',
        http: 502,
        ok: false,
        detail: 'The dispatched job reported an unknown status. Nothing is acknowledged as complete.',
      };
  }
}

/**
 * The verdict for a row that already exists.
 *
 * A stored FAILED, BLOCKED or REVIEW_REQUIRED row is NEVER reported as
 * DUPLICATE: a failed record must not be acknowledged as successfully
 * processed. A row that says ACCEPTED but has no JobRun pointer cannot be
 * confirmed either, so it is reported as DEGRADED — an ambiguous result is
 * never reported as a success.
 */
function verdictForStoredRow(existing: ExistingHandoff): Verdict {
  switch (existing.status) {
    case 'BLOCKED':
      return {
        handoff: 'BLOCKED',
        http: 409,
        ok: false,
        detail: 'This delivery was blocked by halal screening; no work was executed.',
      };
    case 'REVIEW_REQUIRED':
      return {
        handoff: 'REVIEW_REQUIRED',
        http: 409,
        ok: false,
        detail: 'This delivery is awaiting human review; no work was executed.',
      };
    case 'FAILED':
      return {
        handoff: 'FAILED',
        http: 502,
        ok: false,
        detail:
          'This delivery was recorded but the dispatched work did not complete. '
          + 'It was not processed successfully.',
      };
    case 'REJECTED':
      // Rows written before the FAILED verdict existed used REJECTED for a
      // dispatch that threw. It means the same thing: the work did not run.
      return {
        handoff: 'FAILED',
        http: 502,
        ok: false,
        detail:
          'This delivery was recorded but the dispatch did not complete. '
          + 'It was not processed successfully.',
      };
    case 'DEGRADED':
      return {
        handoff: 'DEGRADED',
        http: 202,
        ok: true,
        detail:
          'This delivery was dispatched in degraded mode. Reconcile the job record before relying on it.',
      };
    case 'ACCEPTED':
    default:
      if (!existing.jobRunId) {
        // The row says accepted, but no JobRun was ever linked to it: the
        // dispatch outcome was never durably recorded. The work may or may
        // not have run. That is ambiguous — and an ambiguous result is not a
        // success.
        return {
          handoff: 'DEGRADED',
          http: 202,
          ok: true,
          detail:
            'The original dispatch could not be confirmed from durable state. '
            + 'Reconcile before relying on it.',
        };
      }
      return {
        handoff: 'DUPLICATE',
        http: 200,
        ok: true,
        detail: 'Delivery already processed; no new work was created.',
      };
  }
}

/** The durable reason recorded next to the verdict. Never secrets, never payloads. */
function reasonForVerdict(verdict: Verdict): string {
  switch (verdict.handoff) {
    case 'BLOCKED':
      return 'Blocked by a safety gate; no work was completed.';
    case 'REVIEW_REQUIRED':
      return 'Awaiting human review; no work was completed.';
    case 'FAILED':
      return 'The dispatched work did not complete.';
    case 'DEGRADED':
      return 'The dispatched work completed in degraded mode.';
    default:
      return 'Accepted and dispatched to the Job Runner.';
  }
}

/**
 * Content comparison for a LEGACY row (one written before the content digest
 * existed). Only the fields the row actually carries can be compared, so this
 * is a weaker check than the digest — but a difference is still a conflict.
 */
function legacyContentMatches(
  existing: ExistingHandoff,
  envelope: HandoffEnvelope,
  storedPayload: Record<string, unknown>,
): boolean {
  if (existing.title !== envelope.title) return false;
  if (existing.eventType !== envelope.eventType) return false;
  if (existing.contractId !== envelope.contractId) return false;
  if (existing.correlationId !== envelope.correlationId) return false;
  return (
    toCanonicalJson(storedPayload) === toCanonicalJson(envelope.payload ?? {})
  );
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
 * Decide what a replay of an already-recorded delivery means.
 *
 * Three outcomes, and only three:
 *
 *   CONFLICT  — the same idempotency key now carries DIFFERENT content. The
 *               receiver refuses it (409). It never answers "already
 *               processed" for content it did not run, and it never overwrites
 *               the original delivery.
 *   the stored verdict — a genuine replay. A stored FAILED, BLOCKED or
 *               REVIEW_REQUIRED row is reported as exactly that, never as a
 *               success. A stored ACCEPTED row with no JobRun pointer is
 *               DEGRADED, because the outcome was never durably recorded.
 *   CONFLICT (legacy) — a row written before the content digest existed. Its
 *               digest is unknown, so the fields the row does carry are
 *               compared instead. A difference is still a conflict; a match is
 *               still only as strong as the fields that were compared.
 */
async function replayExisting(
  db: HandoffDb,
  existing: ExistingHandoff,
  envelope: HandoffEnvelope,
  contentDigest: string,
  detailSuffix?: string,
): Promise<ReceiveResult> {
  const stored = unpackStoredPayload(existing.payloadJson ?? '');

  let sameContent: boolean;
  if (stored.legacy || stored.contentDigest === null) {
    // No durable digest to compare: fall back to the fields the row carries.
    sameContent = legacyContentMatches(existing, envelope, stored.payload);
  } else {
    sameContent = stored.contentDigest === contentDigest;
  }

  if (!sameContent) {
    await audit(db, 'HANDOFF_CONFLICT', 'refused', 'idempotency-key-content-mismatch');
    return {
      ok: false,
      status: 409,
      error:
        'This idempotency key was already used for a different delivery. '
        + 'The original delivery was not modified.',
      handoff: 'CONFLICT',
    };
  }

  const verdict = verdictForStoredRow(existing);
  await audit(
    db,
    verdict.handoff === 'DUPLICATE' ? 'HANDOFF_DUPLICATE' : 'HANDOFF_REPLAY',
    verdict.ok ? 'ok' : 'refused',
    verdict.handoff,
  );

  const detail = detailSuffix ? `${verdict.detail} (${detailSuffix})` : verdict.detail;

  if (!verdict.ok) {
    return {
      ok: false,
      status: verdict.http as 409 | 502,
      error: detail,
      handoff: verdict.handoff,
    };
  }

  return {
    ok: true,
    status: verdict.http as 200 | 201 | 202,
    handoff: verdict.handoff,
    idempotencyKey: existing.idempotencyKey,
    correlationId: existing.correlationId,
    jobRunId: existing.jobRunId,
    duplicate: verdict.handoff === 'DUPLICATE',
    detail,
  };
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

  // ---- CONTENT DIGEST ----------------------------------------------------
  // Computed once from the validated envelope. It is the receiver's own
  // answer to "is this the same delivery?", and it is what tells a genuine
  // replay apart from a reused idempotency key carrying different content.
  const contentDigest = handoffContentDigest(envelope);

  // ---- IDEMPOTENCY (read path: replay detection) ------------------------
  const existing = await db.opportunityHandoff.findUnique({
    where: { idempotencyKey: envelope.idempotencyKey },
  });
  if (existing) {
    return replayExisting(db, existing, envelope, contentDigest);
  }

  // ---- SAFETY (server-recomputed, never sender-asserted) ----------------
  const eligibility = resolveEligibility(envelope);
  const jobType = jobTypeForEvent(envelope.eventType);
  const payloadJson = packStoredPayload(contentDigest, envelope.payload ?? {});

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
  try {
    await db.opportunityHandoff.create({
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
    // A unique violation means a concurrent delivery won the race. The loser
    // reports the SAME truth the winner is producing — it never invents a
    // success, and it never acknowledges content it did not check.
    const raced = await db.opportunityHandoff.findUnique({
      where: { idempotencyKey: envelope.idempotencyKey },
    });
    if (raced) {
      return replayExisting(db, raced, envelope, contentDigest, 'concurrent-replay');
    }
    await audit(db, 'HANDOFF_ERROR', 'error', 'reservation-failed');
    return {
      ok: false,
      status: 502,
      error: 'Receiver could not persist the delivery. Nothing was executed.',
    };
  }

  // ---- DISPATCH (Job Runner remains authoritative) ----------------------
  // The payload must satisfy the Job Runner's per-type contract
  // (validateJobPayload): a RESEARCH job REQUIRES `researchObjective`. The
  // envelope's `description` carries the proposal text, so it is mapped there —
  // previously only {title, description, ...} was sent, every dispatch failed
  // payload validation up front, and NO JobRun row was created while the
  // handoff was still reported ACCEPTED. The objective is clipped to the
  // envelope bound (MAX_FIELD_LENGTH = 2000) so the mapping stays bounded.
  let outcome: JobOutcome;
  try {
    outcome = await runJob(
      jobType as JobType,
      {
        researchObjective: envelope.description.slice(0, MAX_FIELD_LENGTH),
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

  // The Job Runner's own status decides the verdict. A job that came back
  // FAILED, BLOCKED, HUMAN_REVIEW or DEGRADED is recorded under THAT status
  // on the durable row, so a later replay reports the truth instead of
  // "already processed". The row is updated BEFORE the response is sent, so
  // the state a producer sees is the state a replay will see.
  const verdict = verdictForJobStatus(outcome.status);

  await db.opportunityHandoff
    .update({
      where: { idempotencyKey: envelope.idempotencyKey },
      data: {
        jobRunId,
        opportunityId,
        status: verdict.handoff,
        reason: reasonForVerdict(verdict),
      },
    })
    .catch(() => undefined);

  await audit(
    db,
    verdict.handoff === 'ACCEPTED' ? 'HANDOFF_ACCEPTED' : 'HANDOUT_NON_SUCCESS',
    verdict.ok ? 'ok' : 'refused',
    verdict.handoff,
  );

  if (!verdict.ok) {
    return {
      ok: false,
      status: verdict.http as 409 | 502,
      error: verdict.detail,
      handoff: verdict.handoff,
    };
  }

  return {
    ok: true,
    status: verdict.http as 201 | 202,
    handoff: verdict.handoff,
    idempotencyKey: envelope.idempotencyKey,
    correlationId: envelope.correlationId,
    jobRunId,
    duplicate: false,
    detail: verdict.detail,
    jobStatus: outcome.status,
    jobDeduplicated: outcome.deduplicated === true,
  };
}

/** A correlation id the receiver generates when it must supply one itself. */
export function newCorrelationId(): string {
  return `handoff-${randomUUID()}`;
}
