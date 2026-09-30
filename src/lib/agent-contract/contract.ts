// ============================================================================
// AGENT INTEGRATION CONTRACT v1 (Phase 1) — wire schema
// ============================================================================
// The versioned boundary between AI Income Lab (system of record and
// authority) and a FUTURE external AI Agent runtime. This module is PURE:
// no DB, no network, no secret reads. Processing lives in processor.ts,
// credentials in credentials.ts, the capability catalog in capabilities.ts.
//
// Trust model (unchanged from the rest of this repository):
// - An external agent is a DIFFERENT process on a DIFFERENT machine and is
//   fully UNTRUSTED. Everything it sends is DATA.
// - The server derives identity and authorization from the presented
//   CREDENTIAL only. Client-asserted `role`, `permissions`, `admin`, or
//   `userId` fields can never influence authorization — the request schema
//   has no such fields at all (unknown fields are rejected).
// - Payloads are bounded, structural data. There is no instruction field;
//   the ACTION the server executes is chosen by the server from the
//   capability catalog, never by the caller.
// ============================================================================

import { z } from 'zod';

/** The only contract version this codebase speaks. Others are rejected. */
export const AGENT_CONTRACT_VERSION = 'v1' as const;

// ---------------------------------------------------------------------------
// Bounded scalar primitives
// ---------------------------------------------------------------------------

export const MAX_AGENT_ID_LENGTH = 64;
export const MAX_AGENT_VERSION_LENGTH = 40;
export const MAX_REQUEST_ID_LENGTH = 200;
export const MAX_CORRELATION_ID_LENGTH = 200;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_PAYLOAD_DEPTH = 6;
export const MAX_PAYLOAD_KEYS = 50;
export const MAX_FIELD_LENGTH = 2000;

const boundedId = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // Printable, no control characters — ids are audit labels, never directives.
    .regex(/^[\x21-\x7E]{1,}$/, 'must contain only printable ASCII characters');

// ---------------------------------------------------------------------------
// Agent actions — the complete v1 action vocabulary (capability catalog ids)
// ---------------------------------------------------------------------------

export const AGENT_ACTIONS = [
  'READ_OPPORTUNITY',
  'WRITE_RESEARCH_EVIDENCE',
  'RUN_VALIDATION',
  'CREATE_PRODUCT_PLAN',
  'CREATE_EXPERIMENT',
  'READ_ANALYTICS',
  'READ_REVENUE',
  'REQUEST_PUBLISH',
  'REQUEST_CONFIG_CHANGE',
] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];

export function isAgentAction(value: unknown): value is AgentAction {
  return typeof value === 'string' && (AGENT_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// AgentIdentity — what the SERVER derives from an authenticated credential
// ---------------------------------------------------------------------------

export const agentIdentitySchema = z.object({
  agentId: z.string().min(1).max(MAX_AGENT_ID_LENGTH),
  /** Which configured credential binding authenticated this request. */
  credentialLabel: z.string().min(1).max(64),
  /** Keyed HMAC fingerprint of the presented credential (never the credential). */
  fingerprint: z.string().length(16),
  /** Server-derived capability allow-list from the credential's grant env. */
  grantedCapabilities: z.array(z.enum(AGENT_ACTIONS)),
});
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

// ---------------------------------------------------------------------------
// AgentRequest — the ONLY accepted wire shape for POST /api/agent/v1/actions
// ---------------------------------------------------------------------------

/**
 * Payload keys that would indicate an attempt to smuggle instructions through
 * the data channel. Their presence is a REJECTION, never a sanitisation — a
 * legitimate agent never needs them. Mirrors the handoff envelope policy so
 * both external boundaries stay consistent.
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
  // Identity/authorization smuggling: the server derives these itself.
  'role',
  'admin',
  'permissions',
  'userid',
  'session',
  'cookie',
] as const;

export const agentRequestSchema = z
  .object({
    contractVersion: z.literal(AGENT_CONTRACT_VERSION),
    agentId: boundedId(MAX_AGENT_ID_LENGTH),
    agentVersion: z.string().min(1).max(MAX_AGENT_VERSION_LENGTH),
    requestId: boundedId(MAX_REQUEST_ID_LENGTH),
    correlationId: boundedId(MAX_CORRELATION_ID_LENGTH),
    /** ISO-8601 instant when the caller created the request. Audit-only. */
    timestamp: z.string().datetime({ offset: true }).max(40),
    action: z.enum(AGENT_ACTIONS),
    /** Untrusted structured data. Depth/size bounded; never executed. */
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type AgentRequest = z.infer<typeof agentRequestSchema>;

// ---------------------------------------------------------------------------
// AgentResponse — the success envelope
// ---------------------------------------------------------------------------

export const agentResponseSchema = z.object({
  contractVersion: z.literal(AGENT_CONTRACT_VERSION),
  requestId: z.string(),
  correlationId: z.string(),
  accepted: z.boolean(),
  /** ACCEPTED | DUPLICATE | HUMAN_APPROVAL_REQUIRED | REJECTED (error envelope instead). */
  status: z.enum(['ACCEPTED', 'DUPLICATE', 'HUMAN_APPROVAL_REQUIRED']),
  jobId: z.string().nullable(),
  reviewId: z.string().nullable(),
  /** Bounded, secret-free result snapshot (echo of the durable record). */
  result: z.record(z.string(), z.unknown()).nullable(),
  timestamp: z.string(),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

// ---------------------------------------------------------------------------
// AgentError — the failure envelope. Codes are STABLE across minor releases.
// ---------------------------------------------------------------------------

export const AGENT_ERROR_CODES = [
  'UNAUTHORIZED',
  'NOT_CONFIGURED',
  'FORBIDDEN_CAPABILITY',
  'FORBIDDEN_RESOURCE',
  'SAFETY_BLOCKED',
  'HUMAN_APPROVAL_REQUIRED',
  'DUPLICATE_REQUEST',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'BUDGET_EXCEEDED',
  'INTERNAL_ERROR',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export const agentErrorSchema = z.object({
  contractVersion: z.literal(AGENT_CONTRACT_VERSION),
  requestId: z.string().nullable(),
  correlationId: z.string().nullable(),
  code: z.enum(AGENT_ERROR_CODES),
  /** Short, human-safe message. NEVER carries internals, secrets, or stacks. */
  message: z.string().max(300),
  details: z.array(z.string().max(200)).max(10).default([]),
  timestamp: z.string(),
});
export type AgentError = z.infer<typeof agentErrorSchema>;

// ---------------------------------------------------------------------------
// Structural payload validation (mirrors the handoff envelope rules)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Recursively bound an untrusted payload: depth, key count, value length. */
function checkPayloadBounds(value: unknown, depth = 0, keyBudget = { count: 0 }): string | null {
  if (depth > MAX_PAYLOAD_DEPTH) return `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`;
  if (keyBudget.count > MAX_PAYLOAD_KEYS) return `payload has more than ${MAX_PAYLOAD_KEYS} keys`;

  if (typeof value === 'string') {
    keyBudget.count += 1;
    return value.length > MAX_FIELD_LENGTH ? `payload string exceeds ${MAX_FIELD_LENGTH} characters` : null;
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

/** Serialize a payload and report its byte size (bounded by the caller). */
export function payloadByteSize(payload: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER; // unserializable → oversized by definition
  }
}

export type RequestValidation =
  | { ok: true; request: AgentRequest }
  | { ok: false; code: AgentErrorCode; httpStatus: 400 | 413; errors: string[] };

/**
 * Validate a raw parsed body against the v1 contract. Zod handles shape and
 * unknown-field rejection (`.strict()`); the recursive bounds check handles
 * depth/keys/lengths and forbidden keys that Zod cannot express per-key.
 */
export function validateAgentRequest(raw: unknown): RequestValidation {
  const parsed = agentRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || 'request'}: ${i.message}`)
      .map((m) => m.slice(0, 200));
    // Oversized primitives surface as 413 so callers can back off correctly.
    const oversized = issues.some((m) => /exceed|too long|max/i.test(m));
    return { ok: false, code: oversized ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', httpStatus: oversized ? 413 : 400, errors: issues };
  }

  const request = parsed.data;
  const boundsError = checkPayloadBounds(request.payload);
  if (boundsError) {
    const oversized = /exceed|deeper|more than/.test(boundsError);
    return {
      ok: false,
      code: oversized ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      httpStatus: oversized ? 413 : 400,
      errors: [boundsError],
    };
  }
  if (payloadByteSize(request.payload) > MAX_PAYLOAD_BYTES) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', httpStatus: 413, errors: [`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`] };
  }

  return { ok: true, request };
}
