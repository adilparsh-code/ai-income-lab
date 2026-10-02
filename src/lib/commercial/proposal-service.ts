// ============================================================================
// PHASE 11.2 — PROPOSAL SERVICE (versioned, immutable, finite scope)
// ============================================================================
// The single write/read path for Proposal / ProposalVersion / ScopeItem /
// ScopeChangeRequest. Every mutation is server-validated, bounded, object-level
// scoped, and audited through the EXISTING SecurityEvent utility.
//
// Hard invariants enforced HERE (not merely documented):
//  - Versions are APPEND-ONLY. `createProposalVersion` never updates an
//    existing ProposalVersion's commercial terms; a locked version is refused.
//  - Sending requires admin approval (APPROVED_FOR_SEND); a client message can
//    never reach this service, and no input field can set approval itself.
//  - ACCEPTED requires structured acceptance evidence — never inferred.
//  - Scope is finite: an out-of-scope request becomes a ScopeChangeRequest in
//    REVIEW_REQUIRED, never executed and never auto-priced into a version.
//  - Payment verification never happens on a proposal. It lives on
//    ServiceEngagement / Milestone (Phase 11.3) behind a
//    PaymentVerificationSource.
// ============================================================================

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { isProspectLifecycleState } from '@/lib/clients/prospect-states';
import { offerHalalStatusFromScreen, type OfferHalalStatus } from './offer-states';
import {
  PROPOSAL_STATES,
  PROPOSAL_APPROVAL_STATES,
  SCOPE_CLASSIFICATIONS,
  isProposalState,
  isProposalApprovalState,
  isScopeClassification,
  parseAcceptanceEvidence,
  canTransitionProposal,
  assertSendable,
  classifyScopeRequest,
  deriveProposalVersionNumber,
  DEFAULT_REVISION_ALLOWANCE,
  MAX_REVISION_ALLOWANCE,
  MAX_PROPOSAL_VERSION_TITLE_CHARS,
  MAX_VALIDITY_DAYS,
  MAX_SCOPE_ITEMS_PER_VERSION,
  MAX_DELIVERABLES_PER_VERSION,
  MAX_EXCLUSIONS_PER_VERSION,
  MAX_ASSUMPTIONS_PER_VERSION,
  type ProposalState,
  type ScopeClassification,
  type ScopeContractItem,
} from './proposal-states';
import { isBoundedMoney, isCurrency, MAX_PRICE_USD } from './offer-states';

export type ProposalResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; status: 400 | 404 | 409; error: string };

// ---------------------------------------------------------------------------
// Bounded input limits
// ---------------------------------------------------------------------------

export const MAX_PROPOSALS_PER_PAGE = 100;
export const MAX_CHANGE_REQUESTS_PER_PAGE = 100;
export const MAX_SCOPE_ITEM_TITLE_CHARS = 200;
export const MAX_SCOPE_ITEM_DETAIL_CHARS = 1_000;
export const MAX_DELIVERABLE_TITLE_CHARS = 200;
export const MAX_TEXT_ITEM_CHARS = 500;
export const MAX_TIMELINE_CHARS = 500;
export const MAX_PAYMENT_TERMS_CHARS = 1_000;
export const MAX_CHANGE_REASON_CHARS = 500;
const MAX_SCOPE_ITEM_KEY_CHARS = 60;
const MAX_ESTIMATED_HOURS = 10_000;

// ---------------------------------------------------------------------------
// Create proposal (always with version 1)
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
  prospectId: unknown;
  offerId: unknown;
  opportunityId?: unknown;
  title: unknown;
  summary?: unknown;
  scopeItems?: unknown;
  deliverables?: unknown;
  exclusions?: unknown;
  assumptions?: unknown;
  price: unknown;
  currency?: unknown;
  estimatedTimeline?: unknown;
  paymentTerms?: unknown;
  revisionAllowance?: unknown;
  validityDays?: unknown;
  actor: string;
  surface: string;
}

export async function createProposal(input: CreateProposalInput): Promise<ProposalResult> {
  const prospectId = await loadProspectId(input.prospectId);
  if (prospectId === null) return { ok: false, status: 404, error: 'Prospect not found.' };

  const offerId = await loadOfferId(input.offerId);
  if (offerId === null) return { ok: false, status: 404, error: 'Offer not found.' };

  // A BLOCKED offer can never back a proposal.
  const offer = await db.offer.findUnique({ where: { id: offerId }, select: { id: true, halalStatus: true, status: true, price: true, currency: true } });
  if (!offer) return { ok: false, status: 404, error: 'Offer not found.' };
  if (offer.halalStatus === 'BLOCKED') {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PROPOSAL_REFUSED',
      surface: input.surface,
      outcome: 'refused',
      detail: 'offer is BLOCKED; proposal not created',
    });
    return { ok: false, status: 400, error: 'A BLOCKED offer cannot be proposed.' };
  }

  const terms = validateProposalTerms(input);
  if ('error' in terms) return { ok: false, status: 400, error: terms.error };

  // Halal status for the version: an explicit blocked/review verdict on the
  // offer propagates; otherwise the server screens the terms themselves.
  const halalStatus: OfferHalalStatus = offer.halalStatus === 'BLOCKED'
    ? 'BLOCKED'
    : offer.halalStatus === 'REVIEW_REQUIRED'
      ? 'REVIEW_REQUIRED'
      : offerHalalStatusFromScreen(
        screenForHalalCompliance(
          terms.title,
          `${terms.summary} ${terms.scopeItems.map((i) => i.title).join(' ')} ${terms.deliverables.map((d) => d.title).join(' ')}`,
          'Client Service',
          'Client Service',
          'ONE_TIME_PURCHASE',
        ).status,
      );

  const proposal = await db.proposal.create({
    data: {
      prospectId,
      offerId,
      opportunityId: typeof input.opportunityId === 'string' && input.opportunityId.length > 0
        ? input.opportunityId
        : null,
      state: 'DRAFT',
      // approvalState is NOT_APPROVED by construction — no input sets it.
      approvalState: 'NOT_APPROVED',
    },
  });

  const version = await db.proposalVersion.create({
    data: {
      proposalId: proposal.id,
      version: 1,
      title: terms.title,
      summary: terms.summary,
      scopeItems: JSON.stringify(terms.scopeItems),
      deliverables: JSON.stringify(terms.deliverables),
      exclusions: JSON.stringify(terms.exclusions),
      assumptions: JSON.stringify(terms.assumptions),
      price: terms.price,
      currency: terms.currency,
      estimatedTimeline: terms.estimatedTimeline,
      paymentTerms: terms.paymentTerms,
      revisionAllowance: terms.revisionAllowance,
      validityDays: terms.validityDays,
      halalStatus,
      // createdBy comes from the verified admin session, never the body.
      createdBy: input.actor,
      createdSource: 'ADMIN',
      changeReason: 'Initial version.',
    },
  });
  await db.scopeItem.createMany({
    data: terms.scopeItems.map((item) => ({
      proposalVersionId: version.id,
      itemKey: item.itemKey,
      title: item.title,
      classification: item.classification,
      detail: item.detail ?? '',
      estimatedHours: item.estimatedHours ?? 0,
    })),
  });
  await db.proposal.update({ where: { id: proposal.id }, data: { currentVersionId: version.id } });

  await auditSecurityEvent({
    kind: 'COMMERCIAL_PROPOSAL_CREATED',
    surface: input.surface,
    outcome: 'ok',
    detail: `proposal=${proposal.id.slice(0, 12)} offer=${offerId.slice(0, 12)} v1 halal=${halalStatus}`,
  });
  return { ok: true, proposalId: proposal.id, versionId: version.id, version: 1, halalStatus };
}

// ---------------------------------------------------------------------------
// New version (immutability enforced)
// ---------------------------------------------------------------------------

export interface CreateProposalVersionInput {
  proposalId: unknown;
  title: unknown;
  summary?: unknown;
  scopeItems?: unknown;
  deliverables?: unknown;
  exclusions?: unknown;
  assumptions?: unknown;
  price: unknown;
  currency?: unknown;
  estimatedTimeline?: unknown;
  paymentTerms?: unknown;
  revisionAllowance?: unknown;
  validityDays?: unknown;
  /** Why the terms changed. Required: a change is always explained. */
  changeReason: unknown;
  actor: string;
  surface: string;
}

export async function createProposalVersion(input: CreateProposalVersionInput): Promise<ProposalResult> {
  const proposal = await loadProposal(input.proposalId);
  if (!proposal) return { ok: false, status: 404, error: 'Proposal not found.' };

  // A closed proposal never gains new versions.
  if (proposal.state === 'ACCEPTED' || proposal.state === 'DECLINED' || proposal.state === 'EXPIRED' || proposal.state === 'SUPERSEDED') {
    return { ok: false, status: 400, error: `A ${proposal.state} proposal cannot receive a new version.` };
  }

  const existing = await db.proposalVersion.findMany({
    where: { proposalId: proposal.id },
    orderBy: { version: 'asc' },
    select: { id: true, version: true, locked: true },
  });
  const latest = existing[existing.length - 1] ?? null;
  const currentVersion = latest?.version ?? 0;
  // The version number is always DERIVED server-side from what exists — never
  // accepted from the caller, so it can never collide or move backwards.
  const nextVersion = deriveProposalVersionNumber(currentVersion);

  // A LOCKED predecessor is not a refusal — it is the whole point. Immutability
  // means the old terms are never edited; a change is a NEW row. The invariant
  // is enforced structurally: this function only ever CREATEs a version and
  // never updates one, so there is no code path that can mutate an existing
  // version's commercial terms.
  if (!Number.isInteger(nextVersion) || nextVersion <= currentVersion) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PROPOSAL_VERSION_REFUSED',
      surface: input.surface,
      outcome: 'refused',
      detail: `proposal=${proposal.id.slice(0, 12)} reason=version-numbers-must-increase`,
    });
    return { ok: false, status: 400, error: 'Version numbers must increase; a commercial change always creates a new version.' };
  }

  if (typeof input.changeReason !== 'string' || input.changeReason.trim().length === 0 || input.changeReason.length > MAX_CHANGE_REASON_CHARS) {
    return { ok: false, status: 400, error: `changeReason is required (at most ${MAX_CHANGE_REASON_CHARS} characters).` };
  }

  const terms = validateProposalTerms(input);
  if ('error' in terms) return { ok: false, status: 400, error: terms.error };

  const version = await db.proposalVersion.create({
    data: {
      proposalId: proposal.id,
      version: nextVersion,
      title: terms.title,
      summary: terms.summary,
      scopeItems: JSON.stringify(terms.scopeItems),
      deliverables: JSON.stringify(terms.deliverables),
      exclusions: JSON.stringify(terms.exclusions),
      assumptions: JSON.stringify(terms.assumptions),
      price: terms.price,
      currency: terms.currency,
      estimatedTimeline: terms.estimatedTimeline,
      paymentTerms: terms.paymentTerms,
      revisionAllowance: terms.revisionAllowance,
      validityDays: terms.validityDays,
      // Screening verdict is re-derived server-side for the new terms.
      halalStatus: offerHalalStatusFromScreen(
        screenForHalalCompliance(
          terms.title,
          `${terms.summary} ${terms.scopeItems.map((i) => i.title).join(' ')} ${terms.deliverables.map((d) => d.title).join(' ')}`,
          'Client Service',
          'Client Service',
          'ONE_TIME_PURCHASE',
        ).status,
      ),
      createdBy: input.actor,
      createdSource: 'ADMIN',
      changeReason: input.changeReason.trim(),
    },
  });
  await db.scopeItem.createMany({
    data: terms.scopeItems.map((item) => ({
      proposalVersionId: version.id,
      itemKey: item.itemKey,
      title: item.title,
      classification: item.classification,
      detail: item.detail ?? '',
      estimatedHours: item.estimatedHours ?? 0,
    })),
  });
  await db.proposal.update({ where: { id: proposal.id }, data: { currentVersionId: version.id } });

  await auditSecurityEvent({
    kind: 'COMMERCIAL_PROPOSAL_VERSION_CREATED',
    surface: input.surface,
    outcome: 'ok',
    detail: `proposal=${proposal.id.slice(0, 12)} v${nextVersion} (v${currentVersion} superseded)`,
  });
  return { ok: true, proposalId: proposal.id, versionId: version.id, version: nextVersion };
}

// ---------------------------------------------------------------------------
// Send approval (admin-only) + state transitions
// ---------------------------------------------------------------------------

export async function approveProposalForSend(options: {
  proposalId: unknown;
  to: unknown;
  actor: string;
  surface: string;
}): Promise<ProposalResult> {
  const proposal = await loadProposal(options.proposalId);
  if (!proposal) return { ok: false, status: 404, error: 'Proposal not found.' };
  if (!isProposalApprovalState(options.to)) {
    return { ok: false, status: 400, error: `to must be one of: ${PROPOSAL_APPROVAL_STATES.join(', ')}.` };
  }
  // Approval is only meaningful while the proposal is under review.
  if (options.to === 'APPROVED_FOR_SEND' && proposal.state !== 'INTERNAL_REVIEW') {
    return { ok: false, status: 400, error: 'A proposal can only be approved for send while it is INTERNAL_REVIEW.' };
  }
  await db.proposal.update({
    where: { id: proposal.id },
    data: {
      approvalState: options.to,
      approvedBy: options.to === 'APPROVED_FOR_SEND' ? options.actor : null,
      approvedAt: options.to === 'APPROVED_FOR_SEND' ? new Date() : null,
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_PROPOSAL_SEND_APPROVAL',
    surface: options.surface,
    outcome: 'ok',
    detail: `proposal=${proposal.id.slice(0, 12)} approvalState->${options.to}`,
  });
  return { ok: true, approvalState: options.to };
}

export async function transitionProposal(options: {
  proposalId: unknown;
  to: unknown;
  acceptanceEvidence?: unknown;
  actor: string;
  surface: string;
}): Promise<ProposalResult> {
  const proposal = await loadProposal(options.proposalId);
  if (!proposal) return { ok: false, status: 404, error: 'Proposal not found.' };
  if (!isProposalState(options.to)) {
    return { ok: false, status: 400, error: `to must be one of: ${PROPOSAL_STATES.join(', ')}.` };
  }
  const from = proposal.state as ProposalState;

  const verdict = canTransitionProposal({
    from,
    to: options.to,
    // The caller is always the verified admin session in this service.
    actor: 'ADMIN',
    approvalState: proposal.approvalState,
    acceptanceEvidence: options.acceptanceEvidence,
  });
  if (!verdict.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_PROPOSAL_TRANSITION_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: `proposal=${proposal.id.slice(0, 12)} ${from}->${String(options.to)}: ${verdict.reason.slice(0, 100)}`,
    });
    return { ok: false, status: 400, error: verdict.reason };
  }

  // Halal gate sits in the SEND path and cannot be overridden (§23).
  if (options.to === 'SENT') {
    if (!proposal.currentVersionId) {
      return { ok: false, status: 400, error: 'A proposal must have a current version before it can be sent.' };
    }
    const version = await db.proposalVersion.findUnique({ where: { id: proposal.currentVersionId }, select: { id: true, halalStatus: true } });
    if (!version) return { ok: false, status: 404, error: 'Current proposal version not found.' };
    const sendable = assertSendable(version.halalStatus);
    if (!sendable.ok) {
      await auditSecurityEvent({
        kind: 'COMMERCIAL_PROPOSAL_SEND_REFUSED',
        surface: options.surface,
        outcome: 'refused',
        detail: `proposal=${proposal.id.slice(0, 12)} reason=${sendable.reason.slice(0, 100)}`,
      });
      return { ok: false, status: 400, error: sendable.reason };
    }
  }

  const acceptance = options.to === 'ACCEPTED' ? parseAcceptanceEvidence(options.acceptanceEvidence) : null;
  if (acceptance && !acceptance.ok) {
    return { ok: false, status: 400, error: acceptance.reason };
  }

  // The current version becomes IMMUTABLE the moment the proposal is sent, and
  // every previous version is locked retroactively. After this, the only legal
  // change is a NEW version.
  if (options.to === 'SENT') {
    await db.proposalVersion.updateMany({
      where: { proposalId: proposal.id, locked: false },
      data: { locked: true, lockedAt: new Date() },
    });
  }

  await db.proposal.update({
    where: { id: proposal.id },
    data: {
      state: options.to,
      ...(options.to === 'ACCEPTED' && acceptance && acceptance.ok && proposal.currentVersionId
        ? { approvedVersionId: proposal.currentVersionId }
        : {}),
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_PROPOSAL_STATE',
    surface: options.surface,
    outcome: 'ok',
    detail: `proposal=${proposal.id.slice(0, 12)} ${from}->${options.to}`,
  });
  return {
    ok: true,
    state: options.to,
    ...(options.to === 'ACCEPTED' && acceptance && acceptance.ok
      ? { acceptanceEvidence: acceptance.value }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Scope change requests — the ONLY path for out-of-scope work
// ---------------------------------------------------------------------------

export async function createScopeChangeRequest(options: {
  proposalId: unknown;
  requestedSummary: unknown;
  requestedDetail?: unknown;
  /** Optional provenance: the Message row that raised it (DATA only). */
  sourceMessageId?: unknown;
  sourceFlag?: unknown;
  estimatedHours?: unknown;
  estimatedCost?: unknown;
  requiresPayment?: unknown;
  actor: string;
  surface: string;
}): Promise<ProposalResult> {
  const proposal = await loadProposal(options.proposalId);
  if (!proposal) return { ok: false, status: 404, error: 'Proposal not found.' };
  if (proposal.state === 'ACCEPTED' || proposal.state === 'DECLINED' || proposal.state === 'EXPIRED') {
    return { ok: false, status: 400, error: `A ${proposal.state} proposal cannot receive scope change requests.` };
  }
  if (typeof options.requestedSummary !== 'string' || options.requestedSummary.trim().length === 0 || options.requestedSummary.length > 1_000) {
    return { ok: false, status: 400, error: 'requestedSummary is required (at most 1000 characters).' };
  }
  const detail = typeof options.requestedDetail === 'string' && options.requestedDetail.length <= 2_000
    ? options.requestedDetail
    : '';
  const estimatedHours = options.estimatedHours === undefined || options.estimatedHours === null ? 0 : options.estimatedHours;
  if (typeof estimatedHours !== 'number' || !Number.isFinite(estimatedHours) || estimatedHours < 0 || estimatedHours > MAX_ESTIMATED_HOURS) {
    return { ok: false, status: 400, error: 'estimatedHours must be a non-negative number within bounds.' };
  }
  const estimatedCost = options.estimatedCost === undefined || options.estimatedCost === null ? 0 : options.estimatedCost;
  if (!isBoundedMoney(estimatedCost)) {
    return { ok: false, status: 400, error: 'estimatedCost must be a non-negative finite number within bounds.' };
  }

  // Deterministic classification against the CURRENT approved version's scope.
  // Anything not IN_SCOPE becomes a REVIEW_REQUIRED change request — it is
  // never executed and never silently absorbed.
  const classification = await classifyRequestAgainstCurrentVersion(proposal.currentVersionId, options.requestedSummary);

  const created = await db.scopeChangeRequest.create({
    data: {
      proposalId: proposal.id,
      proposalVersionId: proposal.currentVersionId,
      requestedSummary: options.requestedSummary.trim(),
      requestedDetail: detail,
      classification: classification.kind === 'IN_SCOPE' ? 'IN_SCOPE_MATCH' : classification.kind === 'ASSUMPTION' ? 'ASSUMPTION' : 'CHANGE_REQUEST',
      // Always starts in REVIEW_REQUIRED: a human decides, never the classifier.
      status: 'REVIEW_REQUIRED',
      sourceMessageId: typeof options.sourceMessageId === 'string' ? options.sourceMessageId : null,
      sourceFlag: typeof options.sourceFlag === 'string' ? options.sourceFlag : null,
      estimatedHours,
      estimatedCost,
      // A change is paid by default: work beyond scope is never unpaid.
      requiresPayment: options.requiresPayment === false ? false : true,
    },
  });

  // Scope creep is a deterministic risk signal on the prospect (Phase 11.1
  // counter), never a payment or governance change.
  if (classification.kind !== 'IN_SCOPE' && proposal.prospectId) {
    await db.prospect.update({ where: { id: proposal.prospectId }, data: { scopeChanges: { increment: 1 } } });
  }

  await auditSecurityEvent({
    kind: 'COMMERCIAL_SCOPE_CHANGE_REQUESTED',
    surface: options.surface,
    outcome: 'ok',
    detail: `proposal=${proposal.id.slice(0, 12)} kind=${classification.kind} requiresPayment=${options.requiresPayment !== false}`,
  });
  return {
    ok: true,
    changeRequestId: created.id,
    classification: created.classification,
    status: created.status,
  };
}

export async function resolveScopeChangeRequest(options: {
  changeRequestId: unknown;
  to: unknown;
  /** Required when to === 'CONVERTED_TO_VERSION'. */
  resolvedVersionId?: unknown;
  resolutionNote?: unknown;
  actor: string;
  surface: string;
}): Promise<ProposalResult> {
  if (typeof options.changeRequestId !== 'string' || options.changeRequestId.length === 0) {
    return { ok: false, status: 400, error: 'changeRequestId is required.' };
  }
  if (!['APPROVED', 'REJECTED', 'CONVERTED_TO_VERSION'].includes(String(options.to))) {
    return { ok: false, status: 400, error: 'to must be APPROVED, REJECTED, or CONVERTED_TO_VERSION.' };
  }
  const request = await db.scopeChangeRequest.findUnique({ where: { id: options.changeRequestId } });
  if (!request) return { ok: false, status: 404, error: 'Scope change request not found.' };
  if (request.status !== 'REVIEW_REQUIRED') {
    return { ok: false, status: 400, error: `This change request is already ${request.status}.` };
  }

  let resolvedVersionId: string | null = null;
  if (options.to === 'CONVERTED_TO_VERSION') {
    if (typeof options.resolvedVersionId !== 'string' || options.resolvedVersionId.length === 0) {
      return { ok: false, status: 400, error: 'CONVERTED_TO_VERSION requires a resolvedVersionId (a real new proposal version).' };
    }
    const version = await db.proposalVersion.findUnique({
      where: { id: options.resolvedVersionId },
      select: { id: true, proposalId: true },
    });
    if (!version) return { ok: false, status: 404, error: 'Resolved proposal version not found.' };
    // Object-level authorization: the version must belong to THIS proposal.
    if (version.proposalId !== request.proposalId) {
      return { ok: false, status: 400, error: 'The resolved version belongs to a different proposal.' };
    }
    resolvedVersionId = version.id;
  }

  const resolvedStatus = options.to as string;
  await db.scopeChangeRequest.update({
    where: { id: request.id },
    data: {
      status: resolvedStatus,
      resolvedVersionId,
      resolutionNote: typeof options.resolutionNote === 'string' ? options.resolutionNote.slice(0, 1_000) : '',
      resolvedBy: options.actor,
      resolvedAt: new Date(),
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_SCOPE_CHANGE_RESOLVED',
    surface: options.surface,
    outcome: 'ok',
    detail: `changeRequest=${request.id.slice(0, 12)} ->${String(options.to)}`,
  });
  return { ok: true, status: options.to };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listProposals(options: { prospectId?: unknown; state?: unknown; limit?: unknown }) {
  const where: Prisma.ProposalWhereInput = {};
  if (options.prospectId !== undefined && options.prospectId !== null) {
    if (typeof options.prospectId !== 'string') return { ok: false as const, status: 400 as const, error: 'Invalid prospectId filter.' };
    where.prospectId = options.prospectId;
  }
  if (options.state !== undefined && options.state !== null) {
    if (!isProposalState(options.state)) return { ok: false as const, status: 400 as const, error: 'Invalid state filter.' };
    where.state = options.state;
  }
  const limit = Math.max(1, Math.min(typeof options.limit === 'number' ? Math.floor(options.limit) : 50, MAX_PROPOSALS_PER_PAGE));
  const proposals = await db.proposal.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      prospectId: true,
      offerId: true,
      state: true,
      approvalState: true,
      currentVersionId: true,
      approvedVersionId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return { ok: true as const, proposals };
}

export async function getProposalDetail(proposalId: unknown) {
  if (typeof proposalId !== 'string' || proposalId.length === 0 || proposalId.length > 128) return null;
  return db.proposal.findUnique({
    where: { id: proposalId },
    include: {
      offer: { select: { id: true, type: true, title: true, price: true, currency: true, halalStatus: true, status: true, paymentState: true } },
      versions: {
        orderBy: { version: 'desc' },
        include: { scopeItemRows: true },
      },
      changeRequests: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
}

export async function listChangeRequests(proposalId: string, limitRaw: unknown) {
  const limit = Math.max(1, Math.min(typeof limitRaw === 'number' ? Math.floor(limitRaw) : 50, MAX_CHANGE_REQUESTS_PER_PAGE));
  return db.scopeChangeRequest.findMany({
    where: { proposalId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      requestedSummary: true,
      classification: true,
      status: true,
      estimatedHours: true,
      estimatedCost: true,
      requiresPayment: true,
      resolvedVersionId: true,
      createdAt: true,
    },
  });
}

/** The scope contract of a specific immutable version, as pure items. */
export async function scopeContractForVersion(versionId: string): Promise<ScopeContractItem[]> {
  const rows = await db.scopeItem.findMany({ where: { proposalVersionId: versionId }, orderBy: { itemKey: 'asc' } });
  return rows.map((r) => ({
    itemKey: r.itemKey,
    title: r.title,
    classification: r.classification as ScopeClassification,
    detail: r.detail,
    estimatedHours: r.estimatedHours,
  }));
}

/**
 * Classify a request against a version's frozen scope contract. Pure-ish:
 * reads the immutable ScopeItem rows, then applies the deterministic matcher.
 */
export async function classifyRequestAgainstCurrentVersion(
  versionId: string | null,
  requestText: string,
): Promise<ReturnType<typeof classifyScopeRequest>> {
  if (!versionId) {
    return {
      kind: 'OUT_OF_SCOPE' as const,
      reason: 'Proposal has no current version, so nothing can be in scope.',
      requiresChangeRequest: true as const,
    };
  }
  const items = await scopeContractForVersion(versionId);
  return classifyScopeRequest(requestText, items);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadProspectId(prospectId: unknown): Promise<string | null> {
  if (typeof prospectId !== 'string' || prospectId.length === 0 || prospectId.length > 128) return null;
  const prospect = await db.prospect.findUnique({ where: { id: prospectId }, select: { id: true, lifecycleState: true } });
  if (!prospect) return null;
  // Proposals are only for real prospects; an unknown lifecycle row is treated
  // as not-ready rather than silently accepted.
  if (!isProspectLifecycleState(prospect.lifecycleState)) return null;
  return prospect.id;
}

async function loadOfferId(offerId: unknown): Promise<string | null> {
  if (typeof offerId !== 'string' || offerId.length === 0 || offerId.length > 128) return null;
  return offerId;
}

async function loadProposal(proposalId: unknown) {
  if (typeof proposalId !== 'string' || proposalId.length === 0 || proposalId.length > 128) return null;
  return db.proposal.findUnique({
    where: { id: proposalId },
    select: { id: true, prospectId: true, offerId: true, state: true, approvalState: true, currentVersionId: true, approvedVersionId: true },
  });
}

interface ValidatedTerms {
  title: string;
  summary: string;
  scopeItems: ScopeContractItem[];
  deliverables: { title: string; kind: string; description: string }[];
  exclusions: string[];
  assumptions: string[];
  price: number;
  currency: string;
  estimatedTimeline: string;
  paymentTerms: string;
  revisionAllowance: number;
  validityDays: number;
}

/** Server-side validation of every commercial term. No input is trusted. */
function validateProposalTerms(input: {
  title: unknown;
  summary?: unknown;
  scopeItems?: unknown;
  deliverables?: unknown;
  exclusions?: unknown;
  assumptions?: unknown;
  price: unknown;
  currency?: unknown;
  estimatedTimeline?: unknown;
  paymentTerms?: unknown;
  revisionAllowance?: unknown;
  validityDays?: unknown;
}): { error: string } | ValidatedTerms {
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > MAX_PROPOSAL_VERSION_TITLE_CHARS) {
    return { error: `title is required (at most ${MAX_PROPOSAL_VERSION_TITLE_CHARS} characters).` };
  }
  if (input.summary !== undefined && input.summary !== null && (typeof input.summary !== 'string' || input.summary.length > 2_000)) {
    return { error: 'summary must be a string of at most 2000 characters.' };
  }
  if (!isBoundedMoney(input.price, MAX_PRICE_USD)) {
    return { error: 'price must be a non-negative finite number within bounds.' };
  }
  const currency = input.currency === undefined || input.currency === null ? 'USD' : input.currency;
  if (!isCurrency(currency)) return { error: 'currency must be USD.' };

  const revisionAllowance = input.revisionAllowance === undefined || input.revisionAllowance === null
    ? DEFAULT_REVISION_ALLOWANCE
    : input.revisionAllowance;
  if (typeof revisionAllowance !== 'number' || !Number.isInteger(revisionAllowance) || revisionAllowance < 0 || revisionAllowance > MAX_REVISION_ALLOWANCE) {
    return { error: `revisionAllowance must be an integer between 0 and ${MAX_REVISION_ALLOWANCE}. Revisions are finite by contract.` };
  }

  const validityDays = input.validityDays === undefined || input.validityDays === null ? 30 : input.validityDays;
  if (typeof validityDays !== 'number' || !Number.isInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) {
    return { error: `validityDays must be an integer between 1 and ${MAX_VALIDITY_DAYS}.` };
  }

  const scopeItems = validateScopeItems(input.scopeItems);
  if ('error' in scopeItems) return scopeItems;
  const deliverables = validateDeliverables(input.deliverables);
  if ('error' in deliverables) return deliverables;
  const exclusions = validateTextList(input.exclusions, MAX_EXCLUSIONS_PER_VERSION, 'exclusions');
  if ('error' in exclusions) return exclusions;
  const assumptions = validateTextList(input.assumptions, MAX_ASSUMPTIONS_PER_VERSION, 'assumptions');
  if ('error' in assumptions) return assumptions;

  return {
    title: input.title.trim(),
    summary: (input.summary as string | undefined) ?? '',
    scopeItems: scopeItems.items,
    deliverables,
    exclusions: exclusions.items,
    assumptions: assumptions.items,
    price: input.price as number,
    currency,
    estimatedTimeline: boundedText(input.estimatedTimeline, MAX_TIMELINE_CHARS),
    paymentTerms: boundedText(input.paymentTerms, MAX_PAYMENT_TERMS_CHARS),
    revisionAllowance,
    validityDays,
  };
}

function validateScopeItems(raw: unknown): { error: string } | { items: ScopeContractItem[] } {
  if (raw === undefined || raw === null) return { items: [] };
  if (!Array.isArray(raw)) return { error: 'scopeItems must be an array.' };
  if (raw.length > MAX_SCOPE_ITEMS_PER_VERSION) {
    return { error: `scopeItems must contain at most ${MAX_SCOPE_ITEMS_PER_VERSION} items.` };
  }
  const items: ScopeContractItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: 'scopeItems items must be objects.' };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.itemKey !== 'string' || record.itemKey.trim().length === 0 || record.itemKey.length > MAX_SCOPE_ITEM_KEY_CHARS) {
      return { error: `scopeItems itemKey is required (at most ${MAX_SCOPE_ITEM_KEY_CHARS} characters).` };
    }
    const itemKey = record.itemKey.trim();
    if (seen.has(itemKey)) return { error: `Duplicate scope itemKey: ${itemKey}.` };
    seen.add(itemKey);
    if (typeof record.title !== 'string' || record.title.trim().length === 0 || record.title.length > MAX_SCOPE_ITEM_TITLE_CHARS) {
      return { error: `scopeItems title is required (at most ${MAX_SCOPE_ITEM_TITLE_CHARS} characters).` };
    }
    const classification = record.classification ?? 'IN_SCOPE';
    if (!isScopeClassification(classification)) {
      return { error: `scopeItems classification must be one of: ${SCOPE_CLASSIFICATIONS.join(', ')}.` };
    }
    const detail = record.detail === undefined || record.detail === null ? '' : record.detail;
    if (typeof detail !== 'string' || detail.length > MAX_SCOPE_ITEM_DETAIL_CHARS) {
      return { error: `scopeItems detail must be a string of at most ${MAX_SCOPE_ITEM_DETAIL_CHARS} characters.` };
    }
    const estimatedHours = record.estimatedHours === undefined || record.estimatedHours === null ? 0 : record.estimatedHours;
    if (typeof estimatedHours !== 'number' || !Number.isFinite(estimatedHours) || estimatedHours < 0 || estimatedHours > MAX_ESTIMATED_HOURS) {
      return { error: 'scopeItems estimatedHours must be a non-negative number within bounds.' };
    }
    items.push({
      itemKey,
      title: record.title.trim(),
      classification,
      detail,
      estimatedHours,
    });
  }
  return { items };
}

function validateDeliverables(raw: unknown): { error: string } | { title: string; kind: string; description: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'deliverables must be an array.' };
  if (raw.length > MAX_DELIVERABLES_PER_VERSION) {
    return { error: `deliverables must contain at most ${MAX_DELIVERABLES_PER_VERSION} items.` };
  }
  const items: { title: string; kind: string; description: string }[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: 'deliverables items must be objects.' };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.title !== 'string' || record.title.trim().length === 0 || record.title.length > MAX_DELIVERABLE_TITLE_CHARS) {
      return { error: `deliverables title is required (at most ${MAX_DELIVERABLE_TITLE_CHARS} characters).` };
    }
    const kind = typeof record.kind === 'string' && record.kind.trim().length > 0 ? record.kind.trim().slice(0, 60) : 'DOCUMENT';
    const description = record.description === undefined || record.description === null ? '' : record.description;
    if (typeof description !== 'string' || description.length > MAX_TEXT_ITEM_CHARS) {
      return { error: `deliverables description must be a string of at most ${MAX_TEXT_ITEM_CHARS} characters.` };
    }
    items.push({ title: record.title.trim(), kind, description });
  }
  return items;
}

function validateTextList(raw: unknown, max: number, field: string): { error: string } | { items: string[] } {
  if (raw === undefined || raw === null) return { items: [] };
  if (!Array.isArray(raw)) return { error: `${field} must be an array of strings.` };
  if (raw.length > max) return { error: `${field} must contain at most ${max} items.` };
  const items: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > MAX_TEXT_ITEM_CHARS) {
      return { error: `${field} items must be non-empty strings of at most ${MAX_TEXT_ITEM_CHARS} characters.` };
    }
    items.push(entry.trim());
  }
  return { items };
}

function boundedText(raw: unknown, max: number): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return '';
  return raw.slice(0, max);
}