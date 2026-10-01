// ============================================================================
// PHASE 11.1 — CLIENT FOUNDATION SERVICE (Prospect/Conversation/Message)
// ============================================================================
// The single write/read path for the Phase 11.1 foundation tables. Every
// mutation:
//   - goes through validated state constants (prospect-states.ts),
//   - is bounded (sizes capped, never truncated silently),
//   - is audited via the EXISTING SecurityEvent utility (guard.ts),
//   - enforces object-level authorization (prospectId/conversationId scoped).
//
// Messages are DATA, never authority (Phase 11.0 §15/§18): ingestion
// classifies content deterministically, stores it immutably, increments
// counters, raises SecurityEvents — and never touches permissions, budgets,
// halal state, governance, or payment state.
//
// No email, no outreach, no proposals, no service execution (Phase 11.2+).
// ============================================================================

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import {
  isProspectLifecycleState,
  isProspectRiskState,
  isProspectSource,
  isExplicitRiskState,
  canTransitionLifecycle,
  evaluateRisk,
  riskSignalsFromProspect,
  boundedBusinessInfo,
  boundedJsonArrayRef,
  type ProspectLifecycleState,
  type ProspectRiskState,
} from './prospect-states';
import {
  classifyMessageBody,
  hasSecurityFlags,
  serializeTrustFlags,
  parseTrustFlags,
  type TrustFlag,
} from './message-classifier';

// ---------------------------------------------------------------------------
// Bounded input limits (Phase 11.1 spec §16)
// ---------------------------------------------------------------------------

export const MAX_MESSAGE_BODY_CHARS = 10_000;
export const MAX_DISPLAY_NAME_CHARS = 200;
export const MAX_EMAIL_CHARS = 320;
export const MAX_WEBSITE_CHARS = 300;
export const MAX_BUSINESS_INFO_CHARS = 4000;
export const MAX_PROSPECTS_PER_PAGE = 100;
export const MAX_MESSAGES_PER_PAGE = 200;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function deriveEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type CreateProspectResult =
  | { ok: true; prospectId: string }
  | { ok: false; status: 400 | 409; error: string };

export type CreateConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; status: 400 | 404; error: string };

export type RecordClientMessageResult =
  | {
      ok: true;
      messageId: string;
      duplicate: boolean;
      flags: TrustFlag[];
      securityFlagged: boolean;
    }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type LifecycleTransitionOutcome =
  | { ok: true; lifecycleState: ProspectLifecycleState }
  | { ok: false; status: 400 | 404; error: string };

export type RiskStateOutcome =
  | { ok: true; riskState: ProspectRiskState }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type OptOutOutcome =
  | { ok: true; optedOut: boolean }
  | { ok: false; status: 400 | 404; error: string };

// ---------------------------------------------------------------------------
// Prospect creation (admin path in 11.1 — sources: MANUAL/REFERRAL/INBOUND;
// DISCOVERY_PROVIDER accepted as a value but no discovery provider exists).
// ---------------------------------------------------------------------------

export interface CreateProspectInput {
  displayName: unknown;
  email?: unknown;
  website?: unknown;
  businessInfo?: unknown;
  source: unknown;
  sourceProvider?: unknown;
  sourceRef?: unknown;
  evidenceRefs?: unknown;
  actor: string;
  surface: string;
}

export async function createProspect(input: CreateProspectInput): Promise<CreateProspectResult> {
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.length > MAX_DISPLAY_NAME_CHARS) {
    return { ok: false, status: 400, error: `displayName is required (at most ${MAX_DISPLAY_NAME_CHARS} characters).` };
  }
  if (!isProspectSource(input.source)) {
    return { ok: false, status: 400, error: 'source must be one of DISCOVERY_PROVIDER, INBOUND, REFERRAL, MANUAL.' };
  }
  let email: string | null = null;
  if (input.email !== undefined && input.email !== null) {
    if (typeof input.email !== 'string' || input.email.length > MAX_EMAIL_CHARS || !EMAIL_SHAPE.test(input.email)) {
      return { ok: false, status: 400, error: 'email must be a valid address of at most 320 characters.' };
    }
    email = input.email.trim().toLowerCase();
  }
  let website: string | null = null;
  if (input.website !== undefined && input.website !== null) {
    if (typeof input.website !== 'string' || input.website.length > MAX_WEBSITE_CHARS) {
      return { ok: false, status: 400, error: `website must be a string of at most ${MAX_WEBSITE_CHARS} characters.` };
    }
    website = input.website.trim();
  }
  if (input.sourceProvider !== undefined && input.sourceProvider !== null && (typeof input.sourceProvider !== 'string' || input.sourceProvider.length > 120)) {
    return { ok: false, status: 400, error: 'sourceProvider must be a string of at most 120 characters.' };
  }
  if (input.sourceRef !== undefined && input.sourceRef !== null && (typeof input.sourceRef !== 'string' || input.sourceRef.length > 300)) {
    return { ok: false, status: 400, error: 'sourceRef must be a string of at most 300 characters.' };
  }
  // evidenceRefs must be a bounded array of {type, id} — never fabricated.
  let evidenceRefsJson = '[]';
  if (input.evidenceRefs !== undefined && input.evidenceRefs !== null) {
    if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 50) {
      return { ok: false, status: 400, error: 'evidenceRefs must be an array of at most 50 {type, id} items.' };
    }
    for (const ref of input.evidenceRefs) {
      if (typeof ref !== 'object' || ref === null || typeof (ref as Record<string, unknown>).type !== 'string' || typeof (ref as Record<string, unknown>).id !== 'string') {
        return { ok: false, status: 400, error: 'evidenceRefs items must be objects with string type and id.' };
      }
    }
    evidenceRefsJson = boundedJsonArrayRef(input.evidenceRefs as { type: string; id: string }[]);
  }
  let businessInfoJson = '{}';
  if (input.businessInfo !== undefined && input.businessInfo !== null) {
    if (typeof input.businessInfo !== 'object' || input.businessInfo === null || Array.isArray(input.businessInfo)) {
      return { ok: false, status: 400, error: 'businessInfo must be a JSON object.' };
    }
    businessInfoJson = boundedBusinessInfo(input.businessInfo as Prisma.InputJsonValue);
  }

  try {
    const created = await db.prospect.create({
      data: {
        displayName: input.displayName.trim(),
        email,
        emailDomain: deriveEmailDomain(email),
        website,
        businessInfo: businessInfoJson,
        source: input.source,
        sourceProvider: typeof input.sourceProvider === 'string' ? input.sourceProvider : null,
        sourceRef: typeof input.sourceRef === 'string' ? input.sourceRef : null,
        evidenceRefs: evidenceRefsJson,
        // lifecycleState/riskState: schema defaults NEW — no client-chosen
        // initial privileged state.
      },
    });
    await auditSecurityEvent({
      kind: 'CLIENT_PROSPECT_CREATED',
      surface: input.surface,
      outcome: 'ok',
      detail: `prospect=${created.id.slice(0, 12)} source=${input.source}`,
    });
    return { ok: true, prospectId: created.id };
  } catch (error) {
    // Duplicate-outreach prevention: one prospect per business email.
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
      return { ok: false, status: 409, error: 'A prospect with this email already exists.' };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Prospect listing/reading (admin-only surface; object-level scoping)
// ---------------------------------------------------------------------------

export async function listProspects(options: { lifecycleState?: unknown; riskState?: unknown; limit?: unknown }) {
  const where: Prisma.ProspectWhereInput = {};
  if (options.lifecycleState !== undefined && options.lifecycleState !== null) {
    if (!isProspectLifecycleState(options.lifecycleState)) {
      return { ok: false as const, status: 400 as const, error: 'Invalid lifecycleState filter.' };
    }
    where.lifecycleState = options.lifecycleState;
  }
  if (options.riskState !== undefined && options.riskState !== null) {
    if (!isProspectRiskState(options.riskState)) {
      return { ok: false as const, status: 400 as const, error: 'Invalid riskState filter.' };
    }
    where.riskState = options.riskState;
  }
  const limitRaw = typeof options.limit === 'number' ? Math.floor(options.limit) : 50;
  const limit = Math.max(1, Math.min(limitRaw, MAX_PROSPECTS_PER_PAGE));
  const prospects = await db.prospect.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      lifecycleState: true,
      riskState: true,
      displayName: true,
      email: true,
      website: true,
      source: true,
      acceptedCount: true,
      paidCount: true,
      failedPaymentCount: true,
      disputeCount: true,
      chargebackCount: true,
      abuseFlags: true,
      injectionFlags: true,
      lifetimePaidUsd: true,
      optedOut: true,
      contactAttempts: true,
      lastContactedAt: true,
      updatedAt: true,
    },
  });
  return { ok: true as const, prospects };
}

/** Object-level load: returns the prospect or null (caller maps to 404). */
export async function getProspectById(prospectId: unknown) {
  if (typeof prospectId !== 'string' || prospectId.length === 0 || prospectId.length > 128) return null;
  return db.prospect.findUnique({ where: { id: prospectId } });
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (admin-only; CONTACTED reachable ONLY via the gate)
// ---------------------------------------------------------------------------

export async function transitionLifecycle(options: {
  prospectId: unknown;
  to: unknown;
  actor: string;
  surface: string;
  /** Present ONLY for the gated approved-contact path (future outreach approval). */
  contactApprovalRef?: unknown;
}): Promise<LifecycleTransitionOutcome> {
  const prospect = await getProspectById(options.prospectId);
  if (!prospect) return { ok: false, status: 404, error: 'Prospect not found.' };
  if (!isProspectLifecycleState(options.to)) {
    return { ok: false, status: 400, error: 'to must be a valid lifecycle state.' };
  }
  const from = isProspectLifecycleState(prospect.lifecycleState) ? prospect.lifecycleState : 'NEW';

  // Gated CONTACTED entry — requires an approval reference (human gate).
  if (options.to === 'CONTACTED') {
    if (typeof options.contactApprovalRef !== 'string' || options.contactApprovalRef.trim().length === 0) {
      await auditSecurityEvent({
        kind: 'CLIENT_CONTACT_GATE_REFUSED',
        surface: options.surface,
        outcome: 'refused',
        detail: `prospect=${prospect.id.slice(0, 12)} reason=missing-approval-ref`,
      });
      return { ok: false, status: 400, error: 'CONTACTED requires a contactApprovalRef (approved-contact gate).' };
    }
    const gated = approvedContactTransitionGuarded(from);
    if (!gated.ok) {
      await auditSecurityEvent({
        kind: 'CLIENT_CONTACT_GATE_REFUSED',
        surface: options.surface,
        outcome: 'refused',
        detail: `prospect=${prospect.id.slice(0, 12)} reason=${gated.reason.slice(0, 80)}`,
      });
      return { ok: false, status: 400, error: gated.reason };
    }
  } else {
    const verdict = canTransitionLifecycle(from, options.to);
    if (!verdict.ok) {
      return { ok: false, status: 400, error: verdict.reason };
    }
  }

  const updated = await db.prospect.update({
    where: { id: prospect.id },
    data: { lifecycleState: options.to },
  });
  await auditSecurityEvent({
    kind: 'CLIENT_PROSPECT_LIFECYCLE',
    surface: options.surface,
    outcome: 'ok',
    detail: `prospect=${prospect.id.slice(0, 12)} ${from}->${options.to}`,
  });
  return { ok: true, lifecycleState: isProspectLifecycleState(updated.lifecycleState) ? updated.lifecycleState : options.to };
}

/** Re-export the pure gate for direct use/tests. */
function approvedContactTransitionGuarded(from: ProspectLifecycleState) {
  // The service-level gate checks the STATE precondition; the approval ref was
  // already verified non-empty above. This mirrors approvedContactTransition
  // from prospect-states without re-checking the ref.
  if (from !== 'QUALIFIED') {
    return { ok: false as const, reason: 'CONTACTED is only reachable from QUALIFIED via approved contact.' };
  }
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Risk state transitions (admin-only; PAYMENT_VERIFIED has a hard gate)
// ---------------------------------------------------------------------------

export async function setRiskState(options: {
  prospectId: unknown;
  to: unknown;
  actor: string;
  surface: string;
  /** REQUIRED (and validated) only when to === PAYMENT_VERIFIED. */
  paymentVerificationSource?: unknown;
  paymentVerificationRef?: unknown;
}): Promise<RiskStateOutcome> {
  const prospect = await getProspectById(options.prospectId);
  if (!prospect) return { ok: false, status: 404, error: 'Prospect not found.' };
  if (!isProspectRiskState(options.to)) {
    return { ok: false, status: 400, error: 'to must be a valid risk state.' };
  }

  if (options.to === 'PAYMENT_VERIFIED') {
    // HARD INVARIANT (Phase 11.0 §5): verified payment only via an explicit
    // verification source + reference. A client message can never reach this
    // path — messages do not call setRiskState.
    const source = options.paymentVerificationSource;
    const ref = options.paymentVerificationRef;
    if (
      (typeof source !== 'string' || !['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED'].includes(source))
      || typeof ref !== 'string' || ref.trim().length === 0 || ref.length > 300
    ) {
      await auditSecurityEvent({
        kind: 'CLIENT_PAYMENT_VERIFY_REFUSED',
        surface: options.surface,
        outcome: 'refused',
        detail: `prospect=${prospect.id.slice(0, 12)} reason=missing-verification-source`,
      });
      return { ok: false, status: 400, error: 'PAYMENT_VERIFIED requires paymentVerificationSource (PROVIDER_WEBHOOK | PROVIDER_API | MANUAL_ADMIN_APPROVED) and a paymentVerificationRef.' };
    }
  } else if (!isExplicitRiskState(options.to)) {
    return { ok: false, status: 400, error: 'Invalid risk state.' };
  }

  const signals = riskSignalsFromProspect(prospect);
  const decision = evaluateRisk(signals);

  const updated = await db.prospect.update({
    where: { id: prospect.id },
    data: {
      riskState: options.to,
      lastRiskEvaluatedAt: new Date(),
    },
  });
  await auditSecurityEvent({
    kind: 'CLIENT_PROSPECT_RISK_STATE',
    surface: options.surface,
    outcome: 'ok',
    detail: `prospect=${prospect.id.slice(0, 12)} ->${options.to} (engine=${decision.riskState})`,
  });
  return {
    ok: true,
    riskState: isProspectRiskState(updated.riskState) ? updated.riskState : options.to,
  };
}

// ---------------------------------------------------------------------------
// Opt-out / suppression (foundation for future outreach protection)
// ---------------------------------------------------------------------------

export async function setProspectOptOut(options: {
  prospectId: unknown;
  optedOut: unknown;
  reason?: unknown;
  surface: string;
}): Promise<OptOutOutcome> {
  const prospect = await getProspectById(options.prospectId);
  if (!prospect) return { ok: false, status: 404, error: 'Prospect not found.' };
  if (typeof options.optedOut !== 'boolean') {
    return { ok: false, status: 400, error: 'optedOut must be a boolean.' };
  }
  const reason = typeof options.reason === 'string' && options.reason.trim().length > 0
    ? options.reason.trim().slice(0, 200)
    : null;
  await db.prospect.update({
    where: { id: prospect.id },
    data: {
      optedOut: options.optedOut,
      optedOutAt: options.optedOut ? new Date() : null,
      suppressionReason: options.optedOut ? reason : null,
    },
  });
  await auditSecurityEvent({
    kind: 'CLIENT_PROSPECT_OPT_OUT',
    surface: options.surface,
    outcome: 'ok',
    detail: `prospect=${prospect.id.slice(0, 12)} optedOut=${options.optedOut}`,
  });
  return { ok: true, optedOut: options.optedOut };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface CreateConversationInput {
  prospectId: unknown;
  channel: unknown;
  actor: string;
  surface: string;
}

export async function createConversation(input: CreateConversationInput): Promise<CreateConversationResult> {
  const prospect = await getProspectById(input.prospectId);
  if (!prospect) return { ok: false, status: 404, error: 'Prospect not found.' };
  if (typeof input.channel !== 'string' || !['EMAIL', 'PORTAL', 'API'].includes(input.channel)) {
    return { ok: false, status: 400, error: 'channel must be EMAIL, PORTAL, or API.' };
  }
  const created = await db.conversation.create({
    data: { prospectId: prospect.id, channel: input.channel },
  });
  await auditSecurityEvent({
    kind: 'CLIENT_CONVERSATION_CREATED',
    surface: input.surface,
    outcome: 'ok',
    detail: `conversation=${created.id.slice(0, 12)} prospect=${prospect.id.slice(0, 12)} channel=${input.channel}`,
  });
  return { ok: true, conversationId: created.id };
}

/** Object-level load with owner check: conversation must belong to prospect. */
export async function getConversationScoped(conversationId: unknown, prospectId?: string) {
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 128) return null;
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { prospect: { select: { id: true, lifecycleState: true, riskState: true, displayName: true, optedOut: true } } },
  });
  if (!conversation) return null;
  if (prospectId && conversation.prospectId !== prospectId) return null;
  return conversation;
}

export async function listConversationsForProspect(prospectId: string, limitRaw: unknown) {
  const limit = Math.max(1, Math.min(typeof limitRaw === 'number' ? Math.floor(limitRaw) : 50, 100));
  return db.conversation.findMany({
    where: { prospectId },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      prospectId: true,
      channel: true,
      state: true,
      injectionFlagCount: true,
      prospectMessageCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function transitionConversationState(options: {
  conversationId: unknown;
  to: unknown;
  actor: string;
  surface: string;
}): Promise<{ ok: true; state: string } | { ok: false; status: 400 | 404; error: string }> {
  const conversation = await getConversationScoped(options.conversationId);
  if (!conversation) return { ok: false, status: 404, error: 'Conversation not found.' };
  const allowed = ['OPEN', 'REQUIREMENTS_READY', 'PROPOSAL_PENDING', 'CLOSED_BLOCKED', 'CLOSED_LOST', 'CLOSED_COMPLETED'];
  if (typeof options.to !== 'string' || !allowed.includes(options.to)) {
    return { ok: false, status: 400, error: 'to must be a valid conversation state.' };
  }
  // Immutable closed conversations: no reopening (Phase 11.0 §3.2).
  if (conversation.state.startsWith('CLOSED_')) {
    return { ok: false, status: 400, error: 'Closed conversations cannot be reopened; open a new conversation instead.' };
  }
  await db.conversation.update({ where: { id: conversation.id }, data: { state: options.to } });
  await auditSecurityEvent({
    kind: 'CLIENT_CONVERSATION_STATE',
    surface: options.surface,
    outcome: 'ok',
    detail: `conversation=${conversation.id.slice(0, 12)} ->${options.to}`,
  });
  return { ok: true, state: options.to };
}

// ---------------------------------------------------------------------------
// Message ingestion — THE security boundary
// ---------------------------------------------------------------------------

export interface RecordClientMessageInput {
  conversationId: unknown;
  direction: unknown;
  role: unknown;
  body: unknown;
  providerMessageId?: unknown;
  actor: string;
  surface: string;
}

/**
 * Persist one message through the security boundary:
 *  1. object-level authorization (conversation must exist; scoped by id),
 *  2. bounded body (oversize → 413-style refusal, never truncation),
 *  3. deterministic classification → trust flags,
 *  4. immutable persistence (no update/delete paths exist here),
 *  5. counter updates (conversation + prospect),
 *  6. SecurityEvents for every deterministic security flag,
 *  7. NO privileged action of any kind (permissions/budgets/halal/payment/
 *     governance are untouched — messages are DATA).
 */
export async function recordClientMessage(input: RecordClientMessageInput): Promise<RecordClientMessageResult> {
  const conversation = await getConversationScoped(input.conversationId);
  if (!conversation) return { ok: false, status: 404, error: 'Conversation not found.' };
  if (conversation.state.startsWith('CLOSED_')) {
    return { ok: false, status: 409, error: 'Conversation is closed; open a new conversation instead.' };
  }
  if (input.direction !== 'INBOUND' && input.direction !== 'OUTBOUND_INTERNAL' && input.direction !== 'OUTBOUND_CLIENT') {
    return { ok: false, status: 400, error: 'direction must be INBOUND, OUTBOUND_INTERNAL, or OUTBOUND_CLIENT.' };
  }
  if (input.role !== 'CLIENT' && input.role !== 'SYSTEM_DRAFT' && input.role !== 'AGENT' && input.role !== 'ADMIN') {
    return { ok: false, status: 400, error: 'role must be CLIENT, SYSTEM_DRAFT, AGENT, or ADMIN.' };
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    return { ok: false, status: 400, error: 'body is required.' };
  }
  if (input.body.length > MAX_MESSAGE_BODY_CHARS) {
    await auditSecurityEvent({
      kind: 'CLIENT_MESSAGE_TOO_LARGE',
      surface: input.surface,
      outcome: 'refused',
      detail: `conversation=${conversation.id.slice(0, 12)} chars=${input.body.length}`,
    });
    return { ok: false, status: 400, error: `Message body exceeds ${MAX_MESSAGE_BODY_CHARS} characters. Oversized content is rejected, never truncated.` };
  }
  let providerMessageId: string | null = null;
  if (input.providerMessageId !== undefined && input.providerMessageId !== null) {
    if (typeof input.providerMessageId !== 'string' || input.providerMessageId.length === 0 || input.providerMessageId.length > 300) {
      return { ok: false, status: 400, error: 'providerMessageId must be a string of at most 300 characters.' };
    }
    providerMessageId = input.providerMessageId;
  }

  // Deterministic classification (bounded, offline).
  const classification = classifyMessageBody(input.body);
  const securityFlagged = hasSecurityFlags(classification.flags);

  try {
    const created = await db.message.create({
      data: {
        conversationId: conversation.id,
        direction: input.direction,
        role: input.role,
        body: input.body,
        providerMessageId,
        trustFlags: serializeTrustFlags(classification.flags),
        // treatedAs and immutable: schema defaults (DATA / true). No input
        // can change them — that is the DATA-not-AUTHORITY invariant.
      },
    });

    // Counter updates (bounded increments; never governance/payment state).
    const isClientInbound = input.direction === 'INBOUND' && input.role === 'CLIENT';
    await db.conversation.update({
      where: { id: conversation.id },
      data: {
        prospectMessageCount: isClientInbound ? { increment: 1 } : undefined,
        injectionFlagCount: classification.flags.includes('PROMPT_INJECTION_SUSPECTED') ? { increment: 1 } : undefined,
      },
    });
    if (isClientInbound && classification.flags.length > 0) {
      const counterPatch: Record<string, unknown> = {};
      if (classification.flags.includes('PROMPT_INJECTION_SUSPECTED')) counterPatch.injectionFlags = { increment: 1 };
      if (classification.flags.includes('ABUSE_SUSPECTED')) counterPatch.abuseFlags = { increment: 1 };
      if (classification.flags.includes('SCOPE_CHANGE_REQUEST')) counterPatch.scopeChanges = { increment: 1 };
      if (Object.keys(counterPatch).length > 0) {
        await db.prospect.update({ where: { id: conversation.prospectId }, data: counterPatch });
      }
    }

    // SecurityEvent per deterministic security flag (audit-only; no secrets,
    // no message content in the detail).
    for (const flag of classification.flags) {
      if (!hasSecurityFlags([flag]) && flag !== 'PAYMENT_CLAIM' && flag !== 'FREE_WORK_REQUEST' && flag !== 'URGENCY_PRESSURE') continue;
      await auditSecurityEvent({
        kind: `CLIENT_MSG_${flag}`,
        surface: input.surface,
        outcome: 'refused',
        detail: `conversation=${conversation.id.slice(0, 12)} message=${created.id.slice(0, 12)} rules=${classification.matchedRules.filter((r) => r.startsWith(flag.split('_')[0].toLowerCase())).slice(0, 3).join(',') || 'pattern'}`,
      });
    }
    if (securityFlagged) {
      // Human review for suspected prompt injection (Phase 11.1 spec §23.6):
      // reuse the EXISTING HumanReview queue — no new review system.
      if (classification.flags.includes('PROMPT_INJECTION_SUSPECTED')) {
        await db.humanReview.create({
          data: {
            category: 'SAFETY_REVIEW',
            title: 'Suspected prompt injection in client message',
            detail: `conversation=${conversation.id} message=${created.id} rules=${classification.matchedRules.slice(0, 6).join(', ')}`.slice(0, 300),
            requestedBy: 'system',
            status: 'PENDING',
          },
        });
      }
    }

    return {
      ok: true,
      messageId: created.id,
      duplicate: false,
      flags: classification.flags,
      securityFlagged,
    };
  } catch (error) {
    // Provider replay protection: (conversationId, providerMessageId) unique —
    // a replayed provider message collapses to the stored row (SQLite AND
    // PostgreSQL treat NULLs as distinct, so non-provider rows are unaffected).
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
      const existing = await db.message.findFirst({
        where: { conversationId: conversation.id, providerMessageId },
        select: { id: true },
      });
      await auditSecurityEvent({
        kind: 'CLIENT_MSG_DUPLICATE',
        surface: input.surface,
        outcome: 'ok',
        detail: `conversation=${conversation.id.slice(0, 12)} providerMessageId-replay`,
      });
      if (existing) {
        return {
          ok: true,
          messageId: existing.id,
          duplicate: true,
          flags: [],
          securityFlagged: false,
        };
      }
      return { ok: false, status: 409, error: 'Duplicate provider message id.' };
    }
    throw error;
  }
}

export async function listMessagesForConversation(conversationId: string, limitRaw: unknown) {
  const limit = Math.max(1, Math.min(typeof limitRaw === 'number' ? Math.floor(limitRaw) : 100, MAX_MESSAGES_PER_PAGE));
  return db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      conversationId: true,
      direction: true,
      role: true,
      body: true,
      providerMessageId: true,
      providerStatus: true,
      trustFlags: true,
      treatedAs: true,
      immutable: true,
      createdAt: true,
    },
  });
}

/** Re-export for route/API use. */
export { parseTrustFlags };
