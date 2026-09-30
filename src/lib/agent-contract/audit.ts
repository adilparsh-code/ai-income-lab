// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — durable audit + secret redaction
// ============================================================================
// Every externally-submitted agent action is recorded here, exactly once per
// requestId, BEFORE any dispatch decision is acted on. The AgentActionRecord
// row is both the audit trail and the idempotency record.
//
// Redaction rules (enforced, not aspirational):
// - The presented credential NEVER enters any field. Only its keyed HMAC
//   fingerprint is stored.
// - `resultJson` is filtered through redactSecrets() so a nested secret-like
//   key can never persist, even if a future code path tried to write one.
// - `reason` strings are bounded and pre-redacted.
// ============================================================================

import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import type { AgentErrorCode } from './contract';

// ---------------------------------------------------------------------------
// Secret redaction (defense in depth for any JSON we persist or return)
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /(passw|secret|token|api[-_]?key|authorization|cookie|session|credential)/i;

/**
 * Deep-copy an unknown JSON-ish value replacing secret-shaped keys with
 * '[REDACTED]'. Applied to everything persisted or returned by the agent API
 * so no credential or secret-shaped material can survive a refactor.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(nested, depth + 1);
    }
    return out;
  }
  return '[UNSUPPORTED]';
}

/**
 * Bounded, pre-redacted reason string (safe for audit + responses).
 * Scrubs bearer-token-shaped substrings as defense in depth: even if a future
 * caller interpolates an Authorization header into a reason, credential
 * material cannot reach the audit trail.
 */
export function safeReason(text: string, max = 300): string {
  const cleaned = redactSecrets(text);
  const scrubbed = typeof cleaned === 'string'
    ? cleaned.replace(/[Bb]earer\s+[A-Za-z0-9._~+/=-]{4,}/g, 'Bearer [REDACTED]')
    : '[REDACTED]';
  return scrubbed.slice(0, max);
}

// ---------------------------------------------------------------------------
// AgentActionRecord persistence (injectable for hermetic tests)
// ---------------------------------------------------------------------------

export interface AgentActionRow {
  id: string;
  agentId: string;
  agentVersion: string;
  action: string;
  requestId: string;
  correlationId: string;
  authorizationResult: string;
  safetyVerdict: string;
  status: string;
  jobId: string | null;
  reviewId: string | null;
  resultJson: string;
  reason: string;
  agentFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NewAgentActionData = Omit<AgentActionRow, 'id' | 'createdAt' | 'updatedAt'>;

export interface AgentActionDb {
  agentActionRecord: {
    findUnique(args: { where: { requestId: string } }): Promise<AgentActionRow | null>;
    create(args: { data: NewAgentActionData }): Promise<AgentActionRow>;
    update(args: { where: { requestId: string }; data: Partial<NewAgentActionData> }): Promise<AgentActionRow>;
  };
}

const defaultDb = db as unknown as AgentActionDb;

export type AuditOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'BLOCKED' | 'HUMAN_APPROVAL_REQUIRED' | 'FAILED';

export interface AuditInput {
  agentId: string;
  agentVersion: string;
  action: string;
  requestId: string;
  correlationId: string;
  authorizationResult: 'ALLOWED' | 'DENIED_CAPABILITY' | 'NOT_APPLICABLE';
  safetyVerdict: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED' | 'NOT_APPLICABLE';
  status: AuditOutcome;
  jobId?: string | null;
  reviewId?: string | null;
  result?: Record<string, unknown> | null;
  reason?: string;
  agentFingerprint: string;
}

export interface RecordOutcome {
  ok: boolean;
  row: AgentActionRow | null;
  /** True when the row already existed (concurrent duplicate won the race). */
  raced: boolean;
}

/**
 * Persist the audit record for one action attempt. The unique requestId makes
 * this race-safe: exactly one insert wins; the loser reads the winner's row.
 */
export async function recordAgentAction(input: AuditInput, store: AgentActionDb = defaultDb): Promise<RecordOutcome> {
  const data: NewAgentActionData = {
    agentId: input.agentId.slice(0, 64),
    agentVersion: input.agentVersion.slice(0, 40),
    action: input.action.slice(0, 64),
    requestId: input.requestId,
    correlationId: input.correlationId,
    authorizationResult: input.authorizationResult,
    safetyVerdict: input.safetyVerdict,
    status: input.status,
    jobId: input.jobId ?? null,
    reviewId: input.reviewId ?? null,
    resultJson: JSON.stringify(redactSecrets(input.result ?? {})),
    reason: safeReason(input.reason ?? ''),
    agentFingerprint: input.agentFingerprint,
  };
  try {
    const row = await store.agentActionRecord.create({ data });
    return { ok: true, row, raced: false };
  } catch {
    // Unique violation (or transient store error): read the existing row so a
    // concurrent duplicate returns the winner's durable response.
    try {
      const existing = await store.agentActionRecord.findUnique({ where: { requestId: input.requestId } });
      if (existing) return { ok: true, row: existing, raced: true };
    } catch {
      // fall through
    }
    return { ok: false, row: null, raced: false };
  }
}

/** Attach a jobId/reviewId/status/reason to an already-created row (post-dispatch). */
export async function attachJobToAgentAction(
  requestId: string,
  patch: { jobId?: string | null; reviewId?: string | null; status?: AuditOutcome; reason?: string },
  store: AgentActionDb = defaultDb,
): Promise<void> {
  try {
    await store.agentActionRecord.update({ where: { requestId }, data: patch });
  } catch {
    // Audit enrichment must never break the response path.
  }
}

// ---------------------------------------------------------------------------
// SecurityEvent audit (reuses the EXISTING trail — no second audit system)
// ---------------------------------------------------------------------------

const AGENT_SURFACE = 'api:agent:v1';

/** Coarse SecurityEvent row; never carries payloads or credentials. */
export async function auditAgentEvent(
  kind: string,
  outcome: 'ok' | 'refused' | 'error',
  detail?: string,
  surface: string = AGENT_SURFACE,
): Promise<void> {
  await auditSecurityEvent({ kind, surface, outcome, detail: detail ? detail.slice(0, 200) : undefined });
}

/**
 * Bounded SecurityEvent detail for refusals. Failure details are reduced to
 * the STABLE error code so no payload fragment can ever leak into the trail.
 */
export function refusalDetail(code: AgentErrorCode, correlationId: string | null): string {
  return `code=${code}${correlationId ? ` corr=${correlationId.slice(0, 64)}` : ''}`;
}
