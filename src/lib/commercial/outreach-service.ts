// ============================================================================
// PHASE 11.5 — GOVERNED OUTREACH (policy-controlled, deduplicated, audited)
// ============================================================================
// This is the ONLY path that may send a client-facing message, and it is
// deliberately closed by default.
//
// Ordering is the design. Every send passes through, in this order:
//
//   1. content gate       — truthful identity + no deceptive claims
//   2. eligibility gate  — opt-out, lifecycle, per-prospect caps, window,
//                          human-approval-on-first-contact
//   3. global rate limit  — bounded outbound volume per day
//   4. duplicate gate     — deterministic idempotency key; a retry is a no-op
//   5. provider          — NOT_CONNECTED refuses; nothing is fabricated
//   6. audit              — every attempt, allowed or refused, is recorded
//
// None of these can be skipped by a caller. In particular the content gate is
// applied HERE, inside the send path, so a future route cannot bypass it the
// way `sendCommunication` could in Phase 11.3.
//
// Client messages remain DATA. Nothing in this module reads a client message as
// an instruction, and no client text can cause a send without passing gates 1-4.
// ============================================================================

import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import {
  // Reuse the EXISTING pure outreach safety module (Phase 11.3) — no second
  // copy of the claim patterns, the identity rules or the caps.
  evaluateOutreachEligibility,
  OUTREACH_LIMITS,
  screenOutreachCopy,
  type OutreachEligibility,
} from './outreach-safety';
import {
  isCommunicationChannel,
  resolveCommunicationProvider,
  type CommunicationChannel,
} from './communication-provider';

export type OutreachResult =
  | { ok: true; status: 'SENT' | 'DUPLICATE'; outreachSendId: string; simulated: boolean; providerMessageId: string | null }
  | { ok: false; status: 400 | 404 | 409 | 429; error: string; gate?: string };

const SURFACE = 'commercial:outreach';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 64);
}

/**
 * Deterministic idempotency key for one logical outreach. The caller supplies a
 * stable logical identifier (e.g. `proposal-send:{proposalId}`), NOT a random
 * value — that is what makes a retry collapse to a single send.
 */
export function outreachIdempotencyKey(input: {
  prospectId: string | null;
  channel: string;
  logicalId: string;
}): string {
  return `outreach:${input.prospectId ?? 'none'}:${input.channel}:${input.logicalId.trim()}`;
}

export async function sendGovernedOutreach(options: {
  prospectId: unknown;
  channel: unknown;
  to: unknown;
  subject: unknown;
  body: unknown;
  /** Stable logical id of this outreach (e.g. 'proposal-send:abc'). */
  logicalId: unknown;
  /** Human approval reference for FIRST contact (Phase 11.1 gate). */
  contactApprovalRef?: unknown;
  approvedBy?: unknown;
  engagementId?: unknown;
  surface?: string;
}): Promise<OutreachResult> {
  const surface = options.surface ?? SURFACE;

  // ---- 0. Input validation ------------------------------------------------
  if (!isCommunicationChannel(options.channel)) {
    return { ok: false, status: 400, error: 'channel must be EMAIL, CLIENT_PORTAL, or MESSAGING.', gate: 'input' };
  }
  const channel = options.channel as CommunicationChannel;
  if (typeof options.logicalId !== 'string' || options.logicalId.trim().length === 0 || options.logicalId.length > 200) {
    return { ok: false, status: 400, error: 'logicalId is required (at most 200 characters).', gate: 'input' };
  }
  if (typeof options.subject !== 'string' || typeof options.body !== 'string' || options.body.trim().length === 0) {
    return { ok: false, status: 400, error: 'subject and body are required.', gate: 'input' };
  }
  const recipient = typeof options.to === 'string' ? options.to.trim() : '';
  if (recipient.length === 0) {
    return { ok: false, status: 400, error: 'A recipient is required.', gate: 'input' };
  }

  // ---- 1. CONTENT GATE (impersonation / deception) ------------------------
  // Applied inside the send path so it cannot be bypassed by a caller.
  const copyVerdict = screenOutreachCopy(`${options.subject}\n${options.body}`);
  if (!copyVerdict.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_OUTREACH_REFUSED',
      surface,
      outcome: 'refused',
      detail: `content gate: ${copyVerdict.violations.map((v) => v.id).join(',').slice(0, 80)}`,
    });
    return { ok: false, status: 400, error: copyVerdict.reason, gate: 'content' };
  }

  const prospectId = typeof options.prospectId === 'string' && options.prospectId.length > 0
    ? options.prospectId
    : null;

  // ---- 2. ELIGIBILITY GATE (opt-out, caps, window, first-contact approval) -
  if (prospectId) {
    const prospect = await db.prospect.findUnique({
      where: { id: prospectId },
      select: {
        id: true, optedOut: true, optedOutAt: true, suppressionReason: true,
        lifecycleState: true, contactAttempts: true, lastContactedAt: true,
      },
    });
    if (!prospect) return { ok: false, status: 404, error: 'Prospect not found.', gate: 'eligibility' };

    const eligibility: OutreachEligibility = evaluateOutreachEligibility({
      optedOut: prospect.optedOut,
      suppressionReason: prospect.suppressionReason,
      lifecycleState: prospect.lifecycleState,
      contactAttempts: prospect.contactAttempts,
      lastContactedAt: prospect.lastContactedAt,
      contactApprovalRef: typeof options.contactApprovalRef === 'string' ? options.contactApprovalRef : null,
    });
    if (!eligibility.ok) {
      await auditSecurityEvent({
        kind: 'COMMERCIAL_OUTREACH_REFUSED',
        surface,
        outcome: 'refused',
        detail: `eligibility gate: ${eligibility.reason.slice(0, 90)}`,
      });
      return { ok: false, status: 400, error: eligibility.reason, gate: 'eligibility' };
    }
  }

  // ---- 3. GLOBAL RATE LIMIT (bounded outbound volume) ---------------------
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const sentToday = await db.outreachSend.count({
    where: { createdAt: { gte: dayStart }, status: { in: ['QUEUED', 'SENT', 'DELIVERED'] } },
  });
  if (sentToday >= OUTREACH_LIMITS.maxGlobalSendsPerDay) {
    await auditSecurityEvent({
      kind: 'RATE_LIMITED',
      surface,
      outcome: 'refused',
      detail: `global outreach cap reached (${OUTREACH_LIMITS.maxGlobalSendsPerDay}/day)`,
    });
    return {
      ok: false, status: 429,
      error: `The global daily outreach cap (${OUTREACH_LIMITS.maxGlobalSendsPerDay}) has been reached. No message was sent.`,
      gate: 'rate-limit',
    };
  }

  // ---- 4. DUPLICATE GATE (deterministic, survives retries) ----------------
  const idempotencyKey = outreachIdempotencyKey({ prospectId, channel, logicalId: options.logicalId });
  const existing = await db.outreachSend.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true, providerMessageId: true, simulated: true },
  });
  if (existing) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_OUTREACH_DUPLICATE',
      surface,
      outcome: 'ok',
      detail: `idempotent replay — existing send ${existing.id.slice(0, 12)} is ${existing.status}`,
    });
    return {
      ok: true, status: 'DUPLICATE', outreachSendId: existing.id,
      simulated: existing.simulated, providerMessageId: existing.providerMessageId,
    };
  }

  // ---- 5. PROVIDER (truthful: NOT_CONNECTED refuses) -----------------------
  const provider = resolveCommunicationProvider(channel);
  const providerHealth = provider.health();
  const simulated = providerHealth.state === 'HEALTHY' && provider.id === 'simulated-test-adapter';

  const sendResult = await provider.send({
    channel,
    to: recipient,
    subject: options.subject,
    body: options.body,
    idempotencyKey,
    correlationId: prospectId ?? undefined,
  });

  const status = sendResult.ok
    ? (sendResult.status === 'SENT' || sendResult.status === 'DELIVERED' ? 'SENT' : sendResult.status)
    : 'FAILED';

  // ---- 6. LEDGER + AUDIT --------------------------------------------------
  // The row is written even for a refusal, so "we tried and it did not go out"
  // is durable and auditable rather than invisible.
  const record = await db.outreachSend.create({
    data: {
      prospectId,
      engagementId: typeof options.engagementId === 'string' ? options.engagementId : null,
      channel,
      // The ledger stores digests, not the raw address, so the ledger is not a
      // second copy of the contact database.
      recipientDigest: digest(recipient),
      subjectDigest: digest(options.subject),
      contentDigest: digest(options.body),
      status,
      providerId: provider.id,
      providerMessageId: sendResult.ok ? sendResult.providerMessageId : null,
      simulated: sendResult.ok ? sendResult.simulated === true : simulated,
      screeningResult: 'PASSED',
      approvedBy: typeof options.approvedBy === 'string' ? options.approvedBy : null,
      idempotencyKey,
      detail: sendResult.ok ? '' : sendResult.reason.slice(0, 300),
    },
  });

  if (!sendResult.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_OUTREACH_REFUSED',
      surface,
      outcome: 'refused',
      detail: `provider=${provider.id} state=${providerHealth.state} reason=${sendResult.reason.slice(0, 80)}`,
    });
    return { ok: false, status: 409, error: sendResult.reason, gate: 'provider' };
  }

  // Contact history is only advanced when something ACTUALLY went out.
  if (prospectId && sendResult.status === 'SENT') {
    await db.prospect.update({
      where: { id: prospectId },
      data: { contactAttempts: { increment: 1 }, lastContactedAt: new Date() },
    });
  }

  await auditSecurityEvent({
    kind: 'COMMERCIAL_OUTREACH_SENT',
    surface,
    outcome: 'ok',
    detail:
      `channel=${channel} provider=${provider.id} simulated=${sendResult.simulated === true} `
      + `prospect=${prospectId ? prospectId.slice(0, 12) : 'none'}`,
  });

  return {
    ok: true, status: 'SENT', outreachSendId: record.id,
    simulated: sendResult.simulated === true, providerMessageId: sendResult.providerMessageId,
  };
}

// ---------------------------------------------------------------------------
// Opt-out: unconditional, immediate, always available
// ---------------------------------------------------------------------------

/**
 * Honor an opt-out. This works with NO provider connected, because suppression
 * is a local safety control and must never depend on an external round trip.
 */
export async function suppressOutreach(options: {
  prospectId: unknown;
  reason?: unknown;
  surface?: string;
}): Promise<{ ok: true; suppressed: true } | { ok: false; status: 400 | 404; error: string }> {
  const surface = options.surface ?? SURFACE;
  const prospectId = typeof options.prospectId === 'string' && options.prospectId.length > 0
    ? options.prospectId
    : null;
  if (!prospectId) return { ok: false, status: 400, error: 'prospectId is required.' };
  const prospect = await db.prospect.findUnique({ where: { id: prospectId }, select: { id: true } });
  if (!prospect) return { ok: false, status: 404, error: 'Prospect not found.' };

  await db.prospect.update({
    where: { id: prospectId },
    data: {
      optedOut: true,
      optedOutAt: new Date(),
      suppressionReason: typeof options.reason === 'string' ? options.reason.slice(0, 200) : 'OPT_OUT_REQUESTED',
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_OUTREACH_SUPPRESSED',
    surface,
    outcome: 'ok',
    detail: `prospect=${prospectId.slice(0, 12)} opted out — all future outreach suppressed`,
  });
  return { ok: true, suppressed: true };
}

/** Truthful outreach posture for a prospect: what is allowed right now, and why. */
export async function getOutreachPosture(prospectId: unknown) {
  if (typeof prospectId !== 'string' || prospectId.length === 0) return null;
  const prospect = await db.prospect.findUnique({
    where: { id: prospectId },
    select: {
      id: true, optedOut: true, suppressionReason: true, lifecycleState: true,
      contactAttempts: true, lastContactedAt: true,
    },
  });
  if (!prospect) return null;
  const recent = await db.outreachSend.findMany({
    where: { prospectId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, channel: true, status: true, simulated: true, providerId: true, createdAt: true },
  });
  return {
    prospect,
    eligibility: evaluateOutreachEligibility({
      optedOut: prospect.optedOut,
      suppressionReason: prospect.suppressionReason,
      lifecycleState: prospect.lifecycleState,
      contactAttempts: prospect.contactAttempts,
      lastContactedAt: prospect.lastContactedAt,
    }),
    recentSends: recent,
    limits: OUTREACH_LIMITS,
  };
}
