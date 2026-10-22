// ============================================================================
// DURABLE ADVERSE-INTAKE — EVENT MAPPING (pure)
// ============================================================================
// Turns an untrusted provider payload into a canonical, validated adverse
// event — and decides whether a second delivery of the same event is a
// harmless replay or a conflict.
//
// Nothing here touches a database or a network: it is the decision layer, so
// it can be exhaustively tested offline.
//
// THE RULES
// ---------
//   1. IDENTITY is the provider's own event id, scoped by the provider name.
//      The pair is the dedupe key, enforced by a unique constraint in the
//      durable schema — this module never dedupes on its own.
//   2. CONTENT is summarised by a sha256 digest of the CANONICAL payload.
//      Two deliveries with the same key and the same digest are the same
//      event (idempotent replay). Two deliveries with the same key and
//      DIFFERENT digests are a conflict: the payload was changed in flight,
//      and the event is quarantined for a human instead of being applied.
//   3. ANCHORING is optional at intake. An event that arrives before its
//      order is stored with orderId = null and waits; it is never discarded
//      and never anchored to a guessed order.
//   4. BOUNDS are enforced here so a hostile payload cannot reach the
//      database: identifiers are length- and charset-bounded, the payload is
//      size/depth/key-bounded, and money amounts are non-negative Int32.
//
// HONEST LIMITS
// -------------
// A digest detects a changed payload; it does not prove the ORIGINAL delivery
// was authentic. That is the provider signature's job, and it is not
// implemented here — this layer assumes the caller has already verified the
// provider signature (see the webhook verification module). Nothing in this
// file should ever be read as "the event is genuine".
// ============================================================================

import { sha256Hex, toCanonicalJson } from './canonical';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The adverse event types this intake understands. */
export const ADVERSE_EVENT_TYPES = [
  'CHARGEBACK_CREATED',
  'REFUND_ISSUED',
  'DISPUTE_OPENED',
  'PAYMENT_CANCELED',
  'SUBSCRIPTION_CANCELED',
] as const;

export type AdverseEventType = (typeof ADVERSE_EVENT_TYPES)[number];

export function isAdverseEventType(value: unknown): value is AdverseEventType {
  return typeof value === 'string' && (ADVERSE_EVENT_TYPES as readonly string[]).includes(value);
}

/** What an event does to access to the delivered assets. */
export type HoldDisposition = 'HOLD' | 'RELEASE' | 'NONE';

const EVENT_HOLD_DISPOSITION: Record<AdverseEventType, HoldDisposition> = {
  CHARGEBACK_CREATED: 'HOLD',
  REFUND_ISSUED: 'HOLD',
  DISPUTE_OPENED: 'HOLD',
  PAYMENT_CANCELED: 'HOLD',
  SUBSCRIPTION_CANCELED: 'HOLD',
};

/** PostgreSQL `integer` range. Counters must never wrap. */
export const MAX_INT32 = 2_147_483_647;
export const MIN_INT32 = -2_147_483_648;

export function isInt32Safe(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_INT32 && value <= MAX_INT32;
}

const MAX_PROVIDER_LENGTH = 64;
const MAX_PROVIDER_EVENT_ID_LENGTH = 200;
const MAX_CORRELATION_ID_LENGTH = 200;
const MAX_ID_LENGTH = 128;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_PAYLOAD_DEPTH = 6;
const MAX_PAYLOAD_KEYS = 50;
const MAX_PAYLOAD_STRING_LENGTH = 2_000;

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROVIDER_EVENT_ID_PATTERN = /^[A-Za-z0-9._:@#-]+$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// The canonical event
// ---------------------------------------------------------------------------

export interface NormalizedAdverseEvent {
  provider: string;
  providerEventId: string;
  eventType: AdverseEventType;
  schemaVersion: number;
  payloadDigest: string;
  correlationId: string;
  orderId: string | null;
  buyerId: string | null;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: string;
  receivedAt: string;
  /** The provider key + event id. The durable unique constraint is on these. */
  dedupeKey: string;
  /** Whether the event refers to a known order yet. */
  anchored: boolean;
}

export type AdverseIntakeRefusalCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PROVIDER'
  | 'INVALID_PROVIDER_EVENT_ID'
  | 'INVALID_EVENT_TYPE'
  | 'INVALID_CORRELATION_ID'
  | 'INVALID_ORDER_ID'
  | 'INVALID_BUYER_ID'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_OCCURRED_AT'
  | 'INVALID_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE'
  | 'PAYLOAD_TOO_DEEP'
  | 'PAYLOAD_TOO_MANY_KEYS';

export type NormalizeResult =
  | { ok: true; event: NormalizedAdverseEvent }
  | { ok: false; code: AdverseIntakeRefusalCode; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function boundedString(
  value: unknown,
  max: number,
  pattern: RegExp,
): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  if (!pattern.test(value)) return null;
  return value;
}

/** Recursively bound an untrusted payload: depth, key count, string length. */
export function checkPayloadBounds(
  value: unknown,
  depth = 0,
  budget = { count: 0 },
): AdverseIntakeRefusalCode | null {
  if (depth > MAX_PAYLOAD_DEPTH) return 'PAYLOAD_TOO_DEEP';
  if (budget.count > MAX_PAYLOAD_KEYS) return 'PAYLOAD_TOO_MANY_KEYS';

  if (typeof value === 'string') {
    budget.count += 1;
    return value.length > MAX_PAYLOAD_STRING_LENGTH ? 'INVALID_PAYLOAD' : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = checkPayloadBounds(item, depth + 1, budget);
      if (problem) return problem;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) {
      budget.count += 1;
      const problem = checkPayloadBounds(nested, depth + 1, budget);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'INVALID_PAYLOAD';
  if (typeof value === 'boolean' || value === null) return null;
  return 'INVALID_PAYLOAD';
}

/**
 * The canonical digest of a payload.
 *
 * Canonical JSON (sorted keys, no incidental whitespace) so that two
 * deliveries that differ only in key order or formatting produce the SAME
 * digest — a re-serialised webhook is not a tampered webhook.
 */
export function payloadDigest(payload: unknown): string {
  return sha256Hex(toCanonicalJson(payload));
}

/** The durable dedupe key: provider scope + the provider's event id. */
export function dedupeKey(provider: string, providerEventId: string): string {
  return `${provider}:${providerEventId}`;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Validate and canonicalize one raw provider event.
 *
 * The raw shape mirrors the provider webhook body: identifiers at the top
 * level, the provider-specific details under `payload`.
 */
export function normalizeAdverseEvent(raw: unknown, now: Date): NormalizeResult {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'INVALID_REQUEST', reason: 'The event must be a JSON object.' };
  }

  const provider = boundedString(raw.provider, MAX_PROVIDER_LENGTH, PROVIDER_PATTERN);
  if (!provider) {
    return {
      ok: false,
      code: 'INVALID_PROVIDER',
      reason: 'provider must be a short alphanumeric identifier.',
    };
  }

  const providerEventId = boundedString(
    raw.providerEventId,
    MAX_PROVIDER_EVENT_ID_LENGTH,
    PROVIDER_EVENT_ID_PATTERN,
  );
  if (!providerEventId) {
    return {
      ok: false,
      code: 'INVALID_PROVIDER_EVENT_ID',
      reason: 'providerEventId must be a bounded identifier.',
    };
  }

  if (!isAdverseEventType(raw.eventType)) {
    return {
      ok: false,
      code: 'INVALID_EVENT_TYPE',
      reason: `eventType must be one of: ${ADVERSE_EVENT_TYPES.join(', ')}.`,
    };
  }

  const correlationId = boundedString(
    raw.correlationId,
    MAX_CORRELATION_ID_LENGTH,
    ID_PATTERN,
  );
  if (!correlationId) {
    return {
      ok: false,
      code: 'INVALID_CORRELATION_ID',
      reason: 'correlationId must be a bounded identifier.',
    };
  }

  let orderId: string | null = null;
  if (raw.orderId !== undefined && raw.orderId !== null) {
    orderId = boundedString(raw.orderId, MAX_ID_LENGTH, ID_PATTERN);
    if (!orderId) {
      return { ok: false, code: 'INVALID_ORDER_ID', reason: 'orderId must be a bounded identifier.' };
    }
  }

  let buyerId: string | null = null;
  if (raw.buyerId !== undefined && raw.buyerId !== null) {
    buyerId = boundedString(raw.buyerId, MAX_ID_LENGTH, ID_PATTERN);
    if (!buyerId) {
      return { ok: false, code: 'INVALID_BUYER_ID', reason: 'buyerId must be a bounded identifier.' };
    }
  }

  let amountMinor: number | null = null;
  if (raw.amountMinor !== undefined && raw.amountMinor !== null) {
    const value = raw.amountMinor;
    if (typeof value !== 'number' || !isInt32Safe(value) || value < 0) {
      return {
        ok: false,
        code: 'INVALID_AMOUNT',
        reason: 'amountMinor must be a non-negative 32-bit integer.',
      };
    }
    amountMinor = value;
  }

  let currency: string | null = null;
  if (raw.currency !== undefined && raw.currency !== null) {
    if (typeof raw.currency !== 'string' || !CURRENCY_PATTERN.test(raw.currency)) {
      return { ok: false, code: 'INVALID_CURRENCY', reason: 'currency must be an ISO 4217 code.' };
    }
    currency = raw.currency;
  }

  let occurredAt: string;
  if (typeof raw.occurredAt === 'string') {
    const parsed = Date.parse(raw.occurredAt);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        code: 'INVALID_OCCURRED_AT',
        reason: 'occurredAt must be an ISO-8601 timestamp.',
      };
    }
    occurredAt = new Date(parsed).toISOString();
  } else if (raw.occurredAt instanceof Date && Number.isFinite(raw.occurredAt.getTime())) {
    occurredAt = raw.occurredAt.toISOString();
  } else {
    return {
      ok: false,
      code: 'INVALID_OCCURRED_AT',
      reason: 'occurredAt must be an ISO-8601 timestamp.',
    };
  }

  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) {
    return { ok: false, code: 'INVALID_PAYLOAD', reason: 'payload must be a JSON object.' };
  }
  let serialized: string;
  try {
    serialized = toCanonicalJson(payload);
  } catch {
    return { ok: false, code: 'INVALID_PAYLOAD', reason: 'payload could not be canonicalized.' };
  }
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', reason: 'payload is too large to store.' };
  }
  const boundsProblem = checkPayloadBounds(payload);
  if (boundsProblem) {
    return { ok: false, code: boundsProblem, reason: 'payload exceeds the intake bounds.' };
  }

  const schemaVersion =
    typeof raw.schemaVersion === 'number' && Number.isInteger(raw.schemaVersion) && raw.schemaVersion > 0
      ? raw.schemaVersion
      : 1;

  return {
    ok: true,
    event: {
      provider,
      providerEventId,
      eventType: raw.eventType,
      schemaVersion,
      payloadDigest: payloadDigest(payload),
      correlationId,
      orderId,
      buyerId,
      amountMinor,
      currency,
      occurredAt,
      receivedAt: now.toISOString(),
      dedupeKey: dedupeKey(provider, providerEventId),
      anchored: orderId !== null,
    },
  };
}

// ---------------------------------------------------------------------------
// Replay classification
// ---------------------------------------------------------------------------

export type ReplayClassification = 'NEW' | 'DUPLICATE' | 'CONFLICT';

/**
 * Classify an incoming event against the one already stored.
 *
 * - NEW        — no event with this (provider, providerEventId) exists.
 * - DUPLICATE  — the stored digest matches: the same event, delivered twice.
 * - CONFLICT   — the stored digest differs: the same event id with different
 *                content. This is never applied automatically; it is
 *                quarantined for a human.
 */
export function classifyIncoming(
  existing: { payloadDigest: string } | null,
  incoming: NormalizedAdverseEvent,
): ReplayClassification {
  if (!existing) return 'NEW';
  return existing.payloadDigest === incoming.payloadDigest ? 'DUPLICATE' : 'CONFLICT';
}

/** What the event does to access. */
export function holdDispositionFor(eventType: AdverseEventType): HoldDisposition {
  return EVENT_HOLD_DISPOSITION[eventType] ?? 'NONE';
}

// ---------------------------------------------------------------------------
// Attempt numbering (Int32-safe)
// ---------------------------------------------------------------------------

export type AttemptNumberResult =
  | { ok: true; attempt: number }
  | { ok: false; reason: string };

/**
 * The next attempt number for an event.
 *
 * The counter is a 32-bit integer in the durable schema. It is refused at
 * the boundary rather than allowed to wrap: a wrapped counter would let a
 * poisoned worker reuse attempt number 1 and overwrite the history of an
 * earlier attempt.
 */
export function nextAttemptNumber(attemptCount: number): AttemptNumberResult {
  if (!isInt32Safe(attemptCount) || attemptCount < 0) {
    return { ok: false, reason: 'The attempt counter is out of range.' };
  }
  if (attemptCount >= MAX_INT32) {
    return { ok: false, reason: 'The attempt counter reached its 32-bit limit.' };
  }
  return { ok: true, attempt: attemptCount + 1 };
}
