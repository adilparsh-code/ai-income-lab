// HIGH-1 — Opportunity handoff receiver: delivery envelope contract.
//
// This module is the ONLY place that decides whether an externally delivered
// opportunity proposal is structurally acceptable. It is deliberately pure and
// synchronous so it can be exhaustively unit-tested without a database.
//
// THREAT MODEL (why this is shaped the way it is)
// ------------------------------------------------
// The sender is a DIFFERENT repository/service and therefore fully untrusted.
// Everything it sends is DATA. The envelope is a *typed data record*, never a
// container for instructions:
//
//   - There is no `instructions`, `command`, `jobType`, `sql`, or `shell`
//     field, and unknown top-level fields are REJECTED rather than ignored.
//     A sender can never name the work that will be executed; the receiver
//     maps a narrow event type to a fixed job type itself.
//   - The sender may assert an eligibility, but `assertedEligibility` is
//     recorded for audit ONLY. The effective verdict is always recomputed by
//   the server from the existing halal gate (see resolveEligibility).
//   - All text is length-bounded and never interpolated into SQL, prompts,
//     shell commands, or file paths.
//   - Depth/size bounds prevent a hostile payload from exhausting memory.
//
// The receiver reuses the repository's existing security layer for
// authentication (requireOperator), rate limiting (enforceRateLimit), body
// bounds (readJsonBody) and audit (auditSecurityEvent). This module adds only
// the domain-shaped envelope rules on top.

import { screenForHalalCompliance } from '@/lib/halal-filter';

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Envelope contract versions this receiver understands. Others are rejected. */
export const SUPPORTED_CONTRACT_VERSIONS = ['1.0'] as const;

/** Narrow set of events a sender may deliver. The receiver maps these itself. */
export const HANDOFF_EVENT_TYPES = ['OPPORTUNITY_PROPOSED'] as const;

export type HandoffEventType = (typeof HANDOFF_EVENT_TYPES)[number];

/**
 * The job type the receiver dispatches per event type. The sender has no
 * influence over this mapping — it is the reason the receiver cannot be used
 * as an arbitrary job-submission endpoint.
 */
export const EVENT_TYPE_TO_JOB_TYPE: Record<HandoffEventType, string> = {
  OPPORTUNITY_PROPOSED: 'RESEARCH',
};

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_CORRELATION_ID_LENGTH = 200;
export const MAX_CONTRACT_ID_LENGTH = 200;
export const MAX_TITLE_LENGTH = 300;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_PAYLOAD_DEPTH = 6;
export const MAX_PAYLOAD_KEYS = 50;
export const MAX_FIELD_LENGTH = 2000;

/** Only these envelope fields are accepted. Anything else is a rejection. */
export const ALLOWED_ENVELOPE_FIELDS = [
  'contractVersion',
  'contractId',
  'idempotencyKey',
  'correlationId',
  'eventType',
  'title',
  'description',
  'category',
  'businessModel',
  'monetizationMethod',
  'assertedEligibility',
  'payload',
] as const;

export const ALLOWED_ASSERTED_ELIGIBILITY = ['ALLOWED', 'REVIEW_REQUIRED', 'NOT_ALLOWED'] as const;

export type AssertedEligibility = (typeof ALLOWED_ASSERTED_ELIGIBILITY)[number];

/**
 * Payload keys that would indicate an attempt to smuggle instructions through
 * the data channel. Their presence is a rejection, not a sanitisation: a
 * legitimate sender never needs them.
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'instructions',
  'instruction',
  'command',
  'cmd',
  'shell',
  'exec',
  'execute',
  'jobtype',
  'sql',
  'query',
  'script',
  'prompt',
  'systemprompt',
  'system',
  'apikey',
  'token',
  'password',
  'secret',
  'authorization',
] as const;

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

export interface HandoffEnvelope {
  contractVersion: string;
  contractId: string;
  idempotencyKey: string;
  correlationId: string;
  eventType: HandoffEventType;
  title: string;
  description: string;
  category: string;
  businessModel: string;
  monetizationMethod: string;
  assertedEligibility: AssertedEligibility;
  /** Untrusted structured data, depth/size bounded. Never executed. */
  payload: Record<string, unknown>;
}

export type EnvelopeValidation =
  | { ok: true; envelope: HandoffEnvelope }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Bounded string field: must be a string, non-empty after trim, length-capped. */
function readString(
  raw: Record<string, unknown>,
  field: string,
  maxLength: number,
  errors: string[],
): string {
  const value = raw[field];
  if (typeof value !== 'string') {
    errors.push(`${field} is required and must be a string`);
    return '';
  }
  if (value.trim().length === 0) {
    errors.push(`${field} must not be empty`);
    return '';
  }
  if (value.length > maxLength) {
    errors.push(`${field} must be at most ${maxLength} characters`);
    // Truncate defensively so downstream code still sees a bounded string.
    return value.slice(0, maxLength);
  }
  return value;
}

/**
 * Recursively bound an untrusted payload: cap depth, key count and per-value
 * length. Returns an error string, or null when acceptable.
 */
function checkPayloadBounds(value: unknown, depth = 0, keyBudget = { count: 0 }): string | null {
  if (depth > MAX_PAYLOAD_DEPTH) return `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`;
  if (keyBudget.count > MAX_PAYLOAD_KEYS) return `payload has more than ${MAX_PAYLOAD_KEYS} keys`;

  if (typeof value === 'string') {
    keyBudget.count += 1;
    return value.length > MAX_FIELD_LENGTH
      ? `payload string exceeds ${MAX_FIELD_LENGTH} characters`
      : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = checkPayloadBounds(item, depth + 1, keyBudget);
      if (nested) return nested;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      const lower = key.toLowerCase().replace(/[^a-z]/g, '');
      if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(lower)) {
        return `payload contains forbidden key "${key}" (instructions are never accepted via the data channel)`;
      }
      keyBudget.count += 1;
      const nested = checkPayloadBounds(nestedValue, depth + 1, keyBudget);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'payload has a non-finite number';
  if (typeof value === 'boolean' || value === null) return null;
  return 'payload has an unsupported value type';
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw parsed request body as a delivery envelope. Rejects unknown
 * top-level fields (so a sender cannot smuggle execution directives), missing
 * or malformed required fields, unsupported contract versions, and payloads
 * that exceed size/depth bounds or carry forbidden keys.
 */
export function validateHandoffEnvelope(raw: unknown): EnvelopeValidation {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['Request body must be a JSON object'] };
  }

  // Unknown top-level fields are a rejection: an accepted envelope must match
  // the published contract exactly.
  const unknown = Object.keys(raw).filter(
    (key) => !(ALLOWED_ENVELOPE_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    errors.push(`Unknown envelope field(s): ${unknown.slice(0, 5).join(', ')}`);
  }

  const contractVersion = readString(raw, 'contractVersion', 20, errors);
  if (
    contractVersion.length > 0 &&
    !(SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(contractVersion)
  ) {
    errors.push(
      `Unsupported contractVersion "${contractVersion}". Supported: ${SUPPORTED_CONTRACT_VERSIONS.join(', ')}`,
    );
  }

  const contractId = readString(raw, 'contractId', MAX_CONTRACT_ID_LENGTH, errors);
  const idempotencyKey = readString(raw, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH, errors);
  const correlationId = readString(raw, 'correlationId', MAX_CORRELATION_ID_LENGTH, errors);

  const eventTypeRaw = readString(raw, 'eventType', 60, errors);
  if (eventTypeRaw.length > 0 && !(HANDOFF_EVENT_TYPES as readonly string[]).includes(eventTypeRaw)) {
    errors.push(
      `Unsupported eventType "${eventTypeRaw}". Supported: ${HANDOFF_EVENT_TYPES.join(', ')}`,
    );
  }
  const eventType = (HANDOFF_EVENT_TYPES as readonly string[]).includes(eventTypeRaw)
    ? (eventTypeRaw as HandoffEventType)
    : (HANDOFF_EVENT_TYPES[0] as HandoffEventType);

  const title = readString(raw, 'title', MAX_TITLE_LENGTH, errors);
  const description = readString(raw, 'description', MAX_FIELD_LENGTH, errors);
  const category = readString(raw, 'category', 200, errors);
  const businessModel = readString(raw, 'businessModel', 200, errors);
  const monetizationMethod = readString(raw, 'monetizationMethod', 200, errors);

  const assertedRaw = readString(raw, 'assertedEligibility', 40, errors);
  if (
    assertedRaw.length > 0 &&
    !(ALLOWED_ASSERTED_ELIGIBILITY as readonly string[]).includes(assertedRaw)
  ) {
    errors.push(
      `assertedEligibility must be one of: ${ALLOWED_ASSERTED_ELIGIBILITY.join(', ')}`,
    );
  }
  const assertedEligibility = (ALLOWED_ASSERTED_ELIGIBILITY as readonly string[]).includes(assertedRaw)
    ? (assertedRaw as AssertedEligibility)
    : ('REVIEW_REQUIRED' as AssertedEligibility);

  // payload is optional; when present it must be a bounded, safe object.
  let payload: Record<string, unknown> = {};
  if (raw.payload !== undefined) {
    if (!isPlainObject(raw.payload)) {
      errors.push('payload must be a JSON object when present');
    } else {
      const serialized = JSON.stringify(raw.payload);
      if (serialized.length > MAX_PAYLOAD_BYTES) {
        errors.push(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      }
      const boundsError = checkPayloadBounds(raw.payload);
      if (boundsError) errors.push(boundsError);
      payload = raw.payload;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    envelope: {
      contractVersion,
      contractId,
      idempotencyKey,
      correlationId,
      eventType,
      title,
      description,
      category,
      businessModel,
      monetizationMethod,
      assertedEligibility,
      payload,
    },
  };
}

// ---------------------------------------------------------------------------
// Eligibility — server-side, never sender-asserted
// ---------------------------------------------------------------------------

export type EffectiveEligibility = 'ALLOWED' | 'NEEDS_HUMAN_REVIEW' | 'BLOCKED';

export interface EligibilityResolution {
  eligibility: EffectiveEligibility;
  halalStatus: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
  reasons: string[];
}

/**
 * Recompute eligibility from the EXISTING halal gate.
 *
 * The sender's `assertedEligibility` is deliberately NOT an input here. This
 * is the property that stops a compromised or buggy sender from steering the
 * system past a safety gate: locally screened NOT_ALLOWED always yields
 * BLOCKED, and borderline content always yields NEEDS_HUMAN_REVIEW.
 */
export function resolveEligibility(envelope: HandoffEnvelope): EligibilityResolution {
  const screening = screenForHalalCompliance(
    envelope.title,
    envelope.description,
    envelope.category,
    envelope.businessModel,
    envelope.monetizationMethod,
  );

  if (screening.status === 'NOT_ALLOWED') {
    return {
      eligibility: 'BLOCKED',
      halalStatus: 'NOT_ALLOWED',
      reasons: screening.reasons,
    };
  }
  if (screening.status === 'REVIEW_REQUIRED') {
    return {
      eligibility: 'NEEDS_HUMAN_REVIEW',
      halalStatus: 'REVIEW_REQUIRED',
      reasons: screening.reasons,
    };
  }
  return {
    eligibility: 'ALLOWED',
    halalStatus: 'HALAL',
    reasons: screening.reasons,
  };
}

/** The job type the receiver dispatches for a validated envelope. */
export function jobTypeForEvent(eventType: HandoffEventType): string {
  return EVENT_TYPE_TO_JOB_TYPE[eventType] ?? 'RESEARCH';
}
