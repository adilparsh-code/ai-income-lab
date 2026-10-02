// ============================================================================
// PHASE 11.2 — PROPOSAL STATE MACHINE + SCOPE/REVISION PROTECTION (pure)
// ============================================================================
// Proposal lifecycle, immutable ProposalVersion rules, finite scope, finite
// revisions, and the acceptance-evidence gate. Pure module: no DB, no network,
// no AI, no secrets.
//
// Hard invariants (docs/phase-11-design.md §3.3, §3.9, §8, §9):
// - Versions are APPEND-ONLY. A locked version can never be edited; a change
//   means a NEW version number.
// - ACCEPTED is unreachable without ACCEPTANCE EVIDENCE. Silence never accepts.
// - Scope is finite: a requested item is IN_SCOPE only if it matches an
//   IN_SCOPE row of the currently approved version. Anything else is a change
//   request → REVIEW_REQUIRED.
// - Revisions are finite: exceeding revisionAllowance is impossible; round
//   N+1 beyond the allowance lands in REVISION_LIMIT_REACHED.
// - Client messages are DATA. Nothing in this module may be driven by an
//   untrusted body to approve, send, or set payment state.
// ============================================================================

import {
  isPaymentVerificationSource,
  type PaymentVerificationSource,
} from '@/lib/clients/prospect-states';

// ---------------------------------------------------------------------------
// Proposal states
// ---------------------------------------------------------------------------

export const PROPOSAL_STATES = [
  'DRAFT',
  'INTERNAL_REVIEW',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'SUPERSEDED',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export function isProposalState(value: unknown): value is ProposalState {
  return typeof value === 'string' && (PROPOSAL_STATES as readonly string[]).includes(value);
}

/**
 * Internal send approval. This is an ADMIN-only state and is never reachable
 * from client content — the service requires a verified admin session.
 */
export const PROPOSAL_APPROVAL_STATES = ['NOT_APPROVED', 'APPROVED_FOR_SEND', 'SEND_REFUSED'] as const;
export type ProposalApprovalState = (typeof PROPOSAL_APPROVAL_STATES)[number];

export function isProposalApprovalState(value: unknown): value is ProposalApprovalState {
  return typeof value === 'string' && (PROPOSAL_APPROVAL_STATES as readonly string[]).includes(value);
}

/**
 * Proposal transitions are deny-by-default AND evidence-gated.
 *
 * Forbidden by construction:
 *  - SENT → ACCEPTED without acceptance evidence (§3.3, §12).
 *  - DRAFT → SENT (must pass through INTERNAL_REVIEW with admin approval).
 *  - Any transition out of a terminal state (ACCEPTED / DECLINED / EXPIRED /
 *    SUPERSEDED) except the admin-only SUPERSEDED-from-ACCEPTED rollback-free
 *    path, which does not exist: a superseded proposal is closed for good.
 */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalState, readonly ProposalState[]>> = {
  DRAFT: ['INTERNAL_REVIEW', 'EXPIRED'],
  INTERNAL_REVIEW: ['DRAFT', 'SENT', 'DECLINED', 'EXPIRED'],
  SENT: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'],
  ACCEPTED: [],
  DECLINED: [],
  EXPIRED: [],
  SUPERSEDED: [],
};

export type ProposalActor = 'ADMIN' | 'SYSTEM' | 'CLIENT_EVIDENCE' | 'PROVIDER';

export interface ProposalTransitionInput {
  from: ProposalState;
  to: ProposalState;
  actor: ProposalActor;
  /** Required when to === 'SENT'. Admin approval of the send action. */
  approvalState?: unknown;
  /** Required when to === 'ACCEPTED'. Never synthesized from silence. */
  acceptanceEvidence?: unknown;
}

export type ProposalTransitionResult =
  | { ok: true; from: ProposalState; to: ProposalState }
  | { ok: false; from: ProposalState; to: ProposalState; reason: string };

/** Acceptance evidence kinds. Silence is deliberately NOT among them (§12). */
export const ACCEPTANCE_EVIDENCE_TYPES = [
  'PROVIDER_PAYMENT',
  'EXPLICIT_CLIENT_MESSAGE',
  'SIGNED_DOCUMENT',
  'MILESTONE_ACCEPTANCE',
  'ADMIN_VERIFIED',
] as const;
export type AcceptanceEvidenceType = (typeof ACCEPTANCE_EVIDENCE_TYPES)[number];

export function isAcceptanceEvidenceType(value: unknown): value is AcceptanceEvidenceType {
  return typeof value === 'string' && (ACCEPTANCE_EVIDENCE_TYPES as readonly string[]).includes(value);
}

export interface AcceptanceEvidence {
  type: AcceptanceEvidenceType;
  /** Opaque reference to the real record (message id, provider ref, file). */
  ref: string;
  acceptedAt: string;
  reviewedBy?: string;
}

const MAX_EVIDENCE_REF_CHARS = 300;

/** Validate a client-supplied acceptance evidence record. Never synthesizes one. */
export function parseAcceptanceEvidence(raw: unknown): { ok: true; value: AcceptanceEvidence } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'acceptanceEvidence must be an object.' };
  }
  const record = raw as Record<string, unknown>;
  if (!isAcceptanceEvidenceType(record.type)) {
    return {
      ok: false,
      reason: `acceptanceEvidence.type must be one of: ${ACCEPTANCE_EVIDENCE_TYPES.join(', ')}.`,
    };
  }
  if (typeof record.ref !== 'string' || record.ref.trim().length === 0 || record.ref.length > MAX_EVIDENCE_REF_CHARS) {
    return { ok: false, reason: 'acceptanceEvidence.ref is required (a real reference, at most 300 characters).' };
  }
  const reviewedBy = typeof record.reviewedBy === 'string' && record.reviewedBy.length > 0
    ? record.reviewedBy.slice(0, 200)
    : undefined;
  // acceptedAt is server-assigned by the caller; a client-supplied timestamp
  // is accepted only as an ISO string and is never trusted for ordering.
  const acceptedAt = typeof record.acceptedAt === 'string' && !Number.isNaN(Date.parse(record.acceptedAt))
    ? record.acceptedAt
    : new Date().toISOString();
  return {
    ok: true,
    value: { type: record.type, ref: record.ref.trim(), acceptedAt, ...(reviewedBy ? { reviewedBy } : {}) },
  };
}

export function canTransitionProposal(input: ProposalTransitionInput): ProposalTransitionResult {
  const { from, to, actor, approvalState, acceptanceEvidence } = input;
  if (!isProposalState(from)) return { ok: false, from, to, reason: 'Invalid current proposal state.' };
  if (!isProposalState(to)) return { ok: false, from, to, reason: 'to must be a valid proposal state.' };
  if (from === to) return { ok: false, from, to, reason: `Proposal is already ${to}.` };
  if (!(PROPOSAL_TRANSITIONS[from] ?? []).includes(to)) {
    return { ok: false, from, to, reason: `Transition ${from} → ${to} is not allowed.` };
  }

  // Sending is admin-gated, never client- or message-driven.
  if (to === 'SENT') {
    if (actor !== 'ADMIN') {
      return { ok: false, from, to, reason: 'Only an administrator can send a proposal; client content cannot send anything.' };
    }
    if (!isProposalApprovalState(approvalState) || approvalState !== 'APPROVED_FOR_SEND') {
      return { ok: false, from, to, reason: 'A proposal may only be sent after explicit admin approval (APPROVED_FOR_SEND).' };
    }
  }

  // Acceptance requires real evidence. Silence never accepts (§12).
  if (to === 'ACCEPTED') {
    if (actor === 'PROVIDER' || actor === 'ADMIN' || actor === 'CLIENT_EVIDENCE' || actor === 'SYSTEM') {
      const parsed = parseAcceptanceEvidence(acceptanceEvidence);
      if (!parsed.ok) return { ok: false, from, to, reason: parsed.reason };
    }
  }

  return { ok: true, from, to };
}

// ---------------------------------------------------------------------------
// Scope classification — finite scope by construction
// ---------------------------------------------------------------------------

export const SCOPE_CLASSIFICATIONS = ['IN_SCOPE', 'OUT_OF_SCOPE', 'ASSUMPTION', 'CHANGE_REQUEST'] as const;
export type ScopeClassification = (typeof SCOPE_CLASSIFICATIONS)[number];

export function isScopeClassification(value: unknown): value is ScopeClassification {
  return typeof value === 'string' && (SCOPE_CLASSIFICATIONS as readonly string[]).includes(value);
}

/** A scope row as stored on an immutable ProposalVersion. */
export interface ScopeContractItem {
  itemKey: string;
  title: string;
  classification: ScopeClassification;
  detail?: string;
  estimatedHours?: number;
}

export type ScopeMatchResult =
  | { kind: 'IN_SCOPE'; itemKey: string; item: ScopeContractItem }
  | { kind: 'OUT_OF_SCOPE'; reason: string; requiresChangeRequest: true }
  | { kind: 'ASSUMPTION'; itemKey: string; item: ScopeContractItem; requiresConfirmation: true };

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'with', 'in', 'on', 'my',
  'our', 'their', 'your', 'please', 'also', 'add', 'make', 'build', 'create', 'we',
  'i', 'is', 'are', 'be', 'it', 'that', 'this',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/**
 * Classify a requested item against a frozen version's scope contract.
 *
 * Deterministic and explainable: an explicit OUT_OF_SCOPE row always wins; an
 * explicit ASSUMPTION row requires confirmation; otherwise a token-overlap
 * threshold decides IN_SCOPE vs OUT_OF_SCOPE. There is no fuzzy "close enough"
 * path that could silently expand scope — anything not clearly matched becomes
 * OUT_OF_SCOPE and therefore a change request.
 */
export function classifyScopeRequest(
  requestText: string,
  scopeItems: readonly ScopeContractItem[],
): ScopeMatchResult {
  const normalized = requestText.trim();
  if (normalized.length === 0) {
    return { kind: 'OUT_OF_SCOPE', reason: 'Empty scope request cannot be matched to an in-scope item.', requiresChangeRequest: true };
  }

  const requestTokens = tokenize(normalized);
  if (requestTokens.size === 0) {
    return { kind: 'OUT_OF_SCOPE', reason: 'Scope request has no meaningful terms to match.', requiresChangeRequest: true };
  }

  const explicitOut = scopeItems.find(
    (i) => i.classification === 'OUT_OF_SCOPE' && matches(normalized, requestTokens, i),
  );
  if (explicitOut) {
    return { kind: 'OUT_OF_SCOPE', reason: `Explicitly excluded by scope item "${explicitOut.itemKey}".`, requiresChangeRequest: true };
  }

  const assumption = scopeItems.find(
    (i) => i.classification === 'ASSUMPTION' && matches(normalized, requestTokens, i),
  );

  const inScope = scopeItems.filter((i) => i.classification === 'IN_SCOPE');
  let best: { item: ScopeContractItem; overlap: number } | null = null;
  for (const item of inScope) {
    const overlap = overlapRatio(requestTokens, item);
    if (overlap >= SCOPE_MATCH_THRESHOLD && (best === null || overlap > best.overlap)) {
      best = { item, overlap };
    }
  }

  if (best) {
    if (assumption && assumption.itemKey === best.item.itemKey) {
      return { kind: 'ASSUMPTION', itemKey: assumption.itemKey, item: assumption, requiresConfirmation: true };
    }
    return { kind: 'IN_SCOPE', itemKey: best.item.itemKey, item: best.item };
  }

  if (assumption) {
    return { kind: 'ASSUMPTION', itemKey: assumption.itemKey, item: assumption, requiresConfirmation: true };
  }
  return {
    kind: 'OUT_OF_SCOPE',
    reason: 'Requested work does not match any IN_SCOPE item of the approved version.',
    requiresChangeRequest: true,
  };
}

/**
 * Fraction of the REQUEST's distinctive tokens that also appear in the scope
 * item. Requiring a high share of the request (not just one shared word)
 * keeps "add a mobile app to the 5-page website" from matching the website.
 */
export const SCOPE_MATCH_THRESHOLD = 0.6;

function overlapRatio(requestTokens: Set<string>, item: ScopeContractItem): number {
  const itemTokens = tokenize(`${item.itemKey} ${item.title} ${item.detail ?? ''}`);
  if (itemTokens.size === 0 || requestTokens.size === 0) return 0;
  let hits = 0;
  for (const token of requestTokens) if (itemTokens.has(token)) hits += 1;
  return hits / requestTokens.size;
}

function matches(text: string, tokens: Set<string>, item: ScopeContractItem): boolean {
  const haystack = `${item.itemKey} ${item.title}`.toLowerCase();
  const normalized = text.toLowerCase();
  // An explicit exclusion matches on a phrase hit, or on the same high-overlap
  // rule used for in-scope items.
  if (haystack.length > 2 && normalized.includes(haystack)) return true;
  return overlapRatio(tokens, item) >= SCOPE_MATCH_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Revision allowance — finite by construction
// ---------------------------------------------------------------------------

export const MAX_REVISION_ALLOWANCE = 10;
export const DEFAULT_REVISION_ALLOWANCE = 2;

export type RevisionVerdict =
  | { allowed: true; revisionNumber: number; remaining: number }
  | { allowed: false; reason: string; revisionLimitReached: true; requiresChangeRequest: true };

/**
 * Decide whether another revision round is allowed. `revisionsUsed` counts
 * rounds already consumed. The allowance lives on the IMMUTABLE version, so
 * raising it is itself a priced change (a new version), never an in-place edit.
 */
export function evaluateRevision(
  revisionAllowance: number,
  revisionsUsed: number,
): RevisionVerdict {
  if (!Number.isInteger(revisionAllowance) || revisionAllowance < 0 || revisionAllowance > MAX_REVISION_ALLOWANCE) {
    return {
      allowed: false,
      revisionLimitReached: true,
      requiresChangeRequest: true,
      reason: `revisionAllowance must be an integer between 0 and ${MAX_REVISION_ALLOWANCE}.`,
    };
  }
  if (!Number.isInteger(revisionsUsed) || revisionsUsed < 0) {
    return {
      allowed: false,
      revisionLimitReached: true,
      requiresChangeRequest: true,
      reason: 'revisionsUsed must be a non-negative integer.',
    };
  }
  if (revisionsUsed >= revisionAllowance) {
    return {
      allowed: false,
      revisionLimitReached: true,
      requiresChangeRequest: true,
      reason:
        `Revision limit reached (${revisionsUsed}/${revisionAllowance}). Further work requires an approved, `
        + 'paid change request — unlimited unpaid revisions are impossible by construction.',
    };
  }
  return {
    allowed: true,
    revisionNumber: revisionsUsed + 1,
    remaining: revisionAllowance - revisionsUsed - 1,
  };
}

// ---------------------------------------------------------------------------
// Version immutability
// ---------------------------------------------------------------------------

export const MAX_PROPOSAL_VERSION_TITLE_CHARS = 200;
export const MAX_SCOPE_ITEMS_PER_VERSION = 50;
export const MAX_DELIVERABLES_PER_VERSION = 50;
export const MAX_EXCLUSIONS_PER_VERSION = 50;
export const MAX_ASSUMPTIONS_PER_VERSION = 30;
export const MAX_VALIDITY_DAYS = 365;

export type VersionImmutabilityVerdict =
  | { ok: true }
  | { ok: false; reason: string; requiresNewVersion: true };

/**
 * A locked (approved or sent) version can never be edited — the only legal
 * change is a NEW version. `locked` is a one-way latch: it is never set false.
 */
export function assertVersionMutable(input: {
  locked: boolean;
  /** The version number already recorded for this proposal. */
  currentVersion: number;
  nextVersion: number;
}): VersionImmutabilityVerdict {
  if (input.locked) {
    return {
      ok: false,
      requiresNewVersion: true,
      reason: 'This proposal version is locked (approved or sent) and is immutable. Create a new version instead.',
    };
  }
  if (!Number.isInteger(input.nextVersion) || input.nextVersion < 1) {
    return { ok: false, requiresNewVersion: true, reason: 'nextVersion must be a positive integer.' };
  }
  if (input.nextVersion <= input.currentVersion) {
    return {
      ok: false,
      requiresNewVersion: true,
      reason: `Version numbers must increase (current v${input.currentVersion}, requested v${input.nextVersion}).`,
    };
  }
  return { ok: true };
}

/**
 * The definitive rule, independent of any caller: any change to commercial
 * terms of an existing proposal creates a new version. Used by the service to
 * assert that no UPDATE path ever targets a locked row's terms.
 */
export function requiresNewVersion(locked: boolean): boolean {
  return locked === true;
}

/** The next version number. Version 1 is created with the proposal itself. */
export function deriveProposalVersionNumber(currentVersion: number): number {
  return Math.max(1, Math.floor(currentVersion) + 1);
}

// ---------------------------------------------------------------------------
// Payment gate re-export (single source of truth with Phase 11.1)
// ---------------------------------------------------------------------------

export { isPaymentVerificationSource, type PaymentVerificationSource };

/** PROPOSAL_SEND must never be attempted while the proposal is BLOCKED. */
export function assertSendable(halalStatus: string): { ok: true } | { ok: false; reason: string } {
  if (halalStatus === 'BLOCKED' || halalStatus === 'NOT_ALLOWED') {
    return { ok: false, reason: 'A BLOCKED proposal cannot be sent; the halal gate cannot be overridden.' };
  }
  if (halalStatus === 'UNVERIFIED') {
    return { ok: false, reason: 'An UNVERIFIED proposal cannot be sent — halal screening must run first.' };
  }
  return { ok: true };
}