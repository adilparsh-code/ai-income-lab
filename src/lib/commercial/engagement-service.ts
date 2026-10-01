// ============================================================================
// PHASE 11.3 — ENGAGEMENT SERVICE (execution + delivery + revenue)
// ============================================================================
// The single write/read path for ServiceEngagement / Milestone / Deliverable /
// ServiceIssue. It reuses the EXISTING Job Runner, Revenue ledger (unique
// idempotencyKey), LearningEntry, HumanReview and SecurityEvent infrastructure —
// there is NO second job system and NO second revenue ledger.
//
// What this service refuses to do (enforced here, not merely documented):
//  - Authorize unpaid work. WORK_AUTHORIZED requires PAYMENT_VERIFIED, which
//    requires a PaymentVerificationSource. No body field can supply it.
//  - Mark a deliverable DELIVERED without QA, or ACCEPTED without evidence.
//  - Record revenue from a client message, a "PAID" body flag, or a client
//    screenshot. Revenue requires a verified payment event, a provider API
//    read, or an approved manual admin verification.
//  - Fabricate anything. Every derived field is computed from real rows.
// ============================================================================

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import { isPaymentVerificationSource } from '@/lib/clients/prospect-states';
import {
  ENGAGEMENT_STATES,
  MILESTONE_PAYMENT_STATES,
  DELIVERABLE_STATES,
  SERVICE_ISSUE_TYPES,
  isEngagementState,
  isMilestonePaymentState,
  isDeliverableState,
  isServiceIssueType,
  isServiceIssueStatus,
  canTransitionEngagement,
  canTransitionMilestonePayment,
  canTransitionDeliverable,
  canTransitionIssue,
  classifyRevisionRequest,
  parseDeliveryAcceptance,
  isWorkAuthorized,
  LOW_RISK_EXCEPTION_DEFAULT,
  type EngagementState,
  type MilestonePaymentState,
  type DeliverableState,
  type LowRiskException,
  type ServiceIssueType,
  type ServiceIssueStatus,
} from './engagement-states';
import { isMicroServiceKind, findMicroService, type MicroServiceKind } from './micro-services';
import { isCurrency } from './offer-states';
import { randomUUID } from 'node:crypto';

export type EngagementResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; status: 400 | 404 | 409; error: string };

export const MAX_ENGAGEMENTS_PER_PAGE = 100;

// ---------------------------------------------------------------------------
// Create engagement
// ---------------------------------------------------------------------------

export interface CreateEngagementInput {
  engagementType: unknown;
  title: unknown;
  scopeSummary?: unknown;
  offerId?: unknown;
  proposalId?: unknown;
  proposalVersionId?: unknown;
  opportunityId?: unknown;
  prospectId?: unknown;
  /** Required for MICRO_SERVICE; must be a valid catalogue kind. */
  microServiceKind?: unknown;
  totalPrice: unknown;
  currency?: unknown;
  /** Explicit admin-configured low-risk exception (OFF by default). */
  lowRiskException?: unknown;
  actor: string;
  surface: string;
}

export async function createEngagement(input: CreateEngagementInput): Promise<EngagementResult> {
  const engagementType = String(input.engagementType);
  if (engagementType !== 'MICRO_SERVICE' && engagementType !== 'CLIENT_SERVICE') {
    return { ok: false, status: 400, error: 'engagementType must be MICRO_SERVICE or CLIENT_SERVICE.' };
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 300) {
    return { ok: false, status: 400, error: 'title is required (at most 300 characters).' };
  }
  if (typeof input.totalPrice !== 'number' || !Number.isFinite(input.totalPrice) || input.totalPrice < 0) {
    return { ok: false, status: 400, error: 'totalPrice must be a non-negative finite number.' };
  }
  const currency = input.currency === undefined || input.currency === null ? 'USD' : input.currency;
  if (!isCurrency(currency)) return { ok: false, status: 400, error: 'currency must be USD.' };

  // Micro-services must reference a valid catalogue kind — bounded work only.
  let microServiceKind: MicroServiceKind | null = null;
  if (engagementType === 'MICRO_SERVICE') {
    if (!isMicroServiceKind(input.microServiceKind)) {
      return { ok: false, status: 400, error: 'A MICRO_SERVICE engagement requires a valid microServiceKind.' };
    }
    microServiceKind = input.microServiceKind;
  }

  // Verify links exist so no dangling engagement can be created.
  if (typeof input.prospectId === 'string' && input.prospectId.length > 0) {
    const prospect = await db.prospect.findUnique({ where: { id: input.prospectId }, select: { id: true } });
    if (!prospect) return { ok: false, status: 404, error: 'Prospect not found.' };
  }
  if (typeof input.offerId === 'string' && input.offerId.length > 0) {
    const offer = await db.offer.findUnique({ where: { id: input.offerId }, select: { id: true } });
    if (!offer) return { ok: false, status: 404, error: 'Offer not found.' };
  }

  const lowRisk = normalizeLowRiskException(input.lowRiskException);
  const created = await db.serviceEngagement.create({
    data: {
      engagementType,
      title: input.title.trim(),
      scopeSummary: typeof input.scopeSummary === 'string' ? input.scopeSummary.slice(0, 2_000) : '',
      offerId: typeof input.offerId === 'string' ? input.offerId : null,
      proposalId: typeof input.proposalId === 'string' ? input.proposalId : null,
      proposalVersionId: typeof input.proposalVersionId === 'string' ? input.proposalVersionId : null,
      opportunityId: typeof input.opportunityId === 'string' ? input.opportunityId : null,
      prospectId: typeof input.prospectId === 'string' ? input.prospectId : null,
      totalPrice: input.totalPrice,
      currency,
      // A micro-service stores its bounded kind in the scope summary prefix so
      // the catalogue stays the single source of truth without a new column.
      state: 'NO_COMMITMENT',
      paymentState: 'NOT_DUE',
      exposureCapUsd: lowRisk.enabled ? lowRisk.exposureCapUsd : 0,
      lowRiskExceptionApplied: false,
    },
  });

  if (microServiceKind) {
    const definition = findMicroService(microServiceKind);
    if (definition) {
      await db.serviceEngagement.update({
        where: { id: created.id },
        data: { scopeSummary: `[${microServiceKind}] ${created.scopeSummary}`.slice(0, 2_000) },
      });
    }
  }

  await auditSecurityEvent({
    kind: 'COMMERCIAL_ENGAGEMENT_CREATED',
    surface: input.surface,
    outcome: 'ok',
    detail: `engagement=${created.id.slice(0, 12)} type=${engagementType} state=NO_COMMITMENT`,
  });
  return { ok: true, engagementId: created.id, state: 'NO_COMMITMENT' };
}

function normalizeLowRiskException(raw: unknown): LowRiskException {
  if (typeof raw !== 'object' || raw === null) return LOW_RISK_EXCEPTION_DEFAULT;
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === true;
  const prospectRiskState = typeof record.prospectRiskState === 'string' ? record.prospectRiskState : 'PAYMENT_VERIFIED';
  const exposureCapUsd = typeof record.exposureCapUsd === 'number' && Number.isFinite(record.exposureCapUsd)
    ? record.exposureCapUsd
    : 0;
  return { enabled, prospectRiskState, exposureCapUsd };
}

// ---------------------------------------------------------------------------
// State transition (the payment gate lives here)
// ---------------------------------------------------------------------------

export async function transitionEngagement(options: {
  engagementId: unknown;
  to: unknown;
  /** REQUIRED (and validated) when to === PAYMENT_VERIFIED. */
  paymentVerificationSource?: unknown;
  paymentVerificationRef?: unknown;
  lowRiskException?: unknown;
  actor: string;
  surface: string;
}): Promise<EngagementResult> {
  const engagement = await db.serviceEngagement.findUnique({
    where: { id: typeof options.engagementId === 'string' ? options.engagementId : '' },
    select: {
      id: true, state: true, paymentState: true, prospectId: true, exposureCapUsd: true,
      lowRiskExceptionApplied: true, workAuthorizedAt: true,
    },
  });
  if (!engagement) return { ok: false, status: 404, error: 'Engagement not found.' };
  if (!isEngagementState(options.to)) {
    return { ok: false, status: 400, error: `to must be one of: ${ENGAGEMENT_STATES.join(', ')}.` };
  }

  const prospectRiskState = engagement.prospectId
    ? (await db.prospect.findUnique({ where: { id: engagement.prospectId }, select: { riskState: true } }))?.riskState
    : undefined;

  const verdict = canTransitionEngagement({
    from: engagement.state as EngagementState,
    to: options.to,
    actor: 'ADMIN',
    verificationSource: options.paymentVerificationSource,
    lowRiskException: normalizeLowRiskException(options.lowRiskException),
    prospectRiskState,
  });
  if (!verdict.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_ENGAGEMENT_TRANSITION_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: `engagement=${engagement.id.slice(0, 12)} ${engagement.state}->${String(options.to)}: ${verdict.reason.slice(0, 100)}`,
    });
    return { ok: false, status: 400, error: verdict.reason };
  }

  const to = options.to as EngagementState;
  const isVerification = to === 'PAYMENT_VERIFIED';
  const updates: Prisma.ServiceEngagementUpdateInput = { state: to };
  if (isVerification) {
    updates.paymentState = 'PAYMENT_VERIFIED';
    updates.verificationSource = options.paymentVerificationSource as string;
    updates.providerRef = (options.paymentVerificationRef as string | undefined) ?? null;
    updates.verifiedAt = new Date();
  }
  if (to === 'WORK_AUTHORIZED' && !engagement.workAuthorizedAt) {
    updates.workAuthorizedAt = new Date();
  }
  if (verdict.lowRiskExceptionApplied) {
    updates.lowRiskExceptionApplied = true;
  }
  if (to === 'COMPLETED') {
    updates.completedAt = new Date();
  }

  await db.serviceEngagement.update({ where: { id: engagement.id }, data: updates });
  if (verdict.lowRiskExceptionApplied) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_LOW_RISK_EXCEPTION_APPLIED',
      surface: options.surface,
      outcome: 'ok',
      detail: `engagement=${engagement.id.slice(0, 12)} exposureCap=$${engagement.exposureCapUsd}`,
    });
  }
  await auditSecurityEvent({
    kind: 'COMMERCIAL_ENGAGEMENT_STATE',
    surface: options.surface,
    outcome: 'ok',
    detail: `engagement=${engagement.id.slice(0, 12)} ${engagement.state}->${to}`,
  });
  return { ok: true, state: to, lowRiskExceptionApplied: verdict.lowRiskExceptionApplied };
}

// ---------------------------------------------------------------------------
// Milestones — the per-milestone payment machine
// ---------------------------------------------------------------------------

export async function createMilestone(options: {
  engagementId: unknown;
  key: unknown;
  title: unknown;
  percent?: unknown;
  amountUsd?: unknown;
  actor: string;
  surface: string;
}): Promise<EngagementResult> {
  const engagementId = typeof options.engagementId === 'string' ? options.engagementId : null;
  if (!engagementId) return { ok: false, status: 400, error: 'engagementId is required.' };
  if (typeof options.key !== 'string' || options.key.trim().length === 0 || options.key.length > 60) {
    return { ok: false, status: 400, error: 'key is required (at most 60 characters).' };
  }
  if (typeof options.title !== 'string' || options.title.trim().length === 0 || options.title.length > 200) {
    return { ok: false, status: 400, error: 'title is required (at most 200 characters).' };
  }
  const engagement = await db.serviceEngagement.findUnique({ where: { id: engagementId }, select: { id: true, state: true } });
  if (!engagement) return { ok: false, status: 404, error: 'Engagement not found.' };

  const percent = options.percent === undefined || options.percent === null ? 0 : options.percent;
  if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100) {
    return { ok: false, status: 400, error: 'percent must be an integer between 0 and 100.' };
  }
  const amountUsd = options.amountUsd === undefined || options.amountUsd === null ? 0 : options.amountUsd;
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 0) {
    return { ok: false, status: 400, error: 'amountUsd must be a non-negative finite number.' };
  }

  const created = await db.milestone.create({
    data: {
      engagementId,
      key: options.key.trim(),
      title: options.title.trim(),
      percent,
      amountUsd,
      paymentState: 'NOT_DUE',
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_MILESTONE_CREATED',
    surface: options.surface,
    outcome: 'ok',
    detail: `milestone=${created.id.slice(0, 12)} engagement=${engagementId.slice(0, 12)} key=${created.key}`,
  });
  return { ok: true, milestoneId: created.id };
}

export async function transitionMilestonePayment(options: {
  milestoneId: unknown;
  to: unknown;
  paymentVerificationSource?: unknown;
  providerRef?: unknown;
  actor: string;
  surface: string;
}): Promise<EngagementResult> {
  const milestoneId = typeof options.milestoneId === 'string' ? options.milestoneId : null;
  if (!milestoneId) return { ok: false, status: 400, error: 'milestoneId is required.' };
  const milestone = await db.milestone.findUnique({
    where: { id: milestoneId },
    select: { id: true, paymentState: true, engagementId: true, amountUsd: true },
  });
  if (!milestone) return { ok: false, status: 404, error: 'Milestone not found.' };
  if (!isMilestonePaymentState(options.to)) {
    return { ok: false, status: 400, error: `to must be one of: ${MILESTONE_PAYMENT_STATES.join(', ')}.` };
  }

  const verdict = canTransitionMilestonePayment({
    from: milestone.paymentState as MilestonePaymentState,
    to: options.to,
    verificationSource: options.paymentVerificationSource,
  });
  if (!verdict.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_MILESTONE_PAYMENT_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: `milestone=${milestoneId.slice(0, 12)} ${milestone.paymentState}->${String(options.to)}`,
    });
    return { ok: false, status: 400, error: verdict.reason };
  }

  const to = options.to as MilestonePaymentState;
  await db.milestone.update({
    where: { id: milestone.id },
    data: {
      paymentState: to,
      verificationSource: to === 'PAYMENT_VERIFIED' ? (options.paymentVerificationSource as string) : null,
      providerRef: to === 'PAYMENT_VERIFIED' ? (options.providerRef as string | undefined ?? null) : null,
      verifiedAt: to === 'PAYMENT_VERIFIED' ? new Date() : null,
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_MILESTONE_PAYMENT_STATE',
    surface: options.surface,
    outcome: 'ok',
    detail: `milestone=${milestone.id.slice(0, 12)} ->${to}`,
  });
  return { ok: true, paymentState: to };
}

// ---------------------------------------------------------------------------
// Deliverables — explicit delivery, finite revisions, honest acceptance
// ---------------------------------------------------------------------------

export async function createDeliverable(options: {
  engagementId: unknown;
  title: unknown;
  kind: unknown;
  milestoneKey?: unknown;
  revisionLimit?: unknown;
  isPreview?: unknown;
  actor: string;
  surface: string;
}): Promise<EngagementResult> {
  const engagementId = typeof options.engagementId === 'string' ? options.engagementId : null;
  if (!engagementId) return { ok: false, status: 400, error: 'engagementId is required.' };
  if (typeof options.title !== 'string' || options.title.trim().length === 0 || options.title.length > 200) {
    return { ok: false, status: 400, error: 'title is required (at most 200 characters).' };
  }
  if (typeof options.kind !== 'string' || options.kind.trim().length === 0 || options.kind.length > 60) {
    return { ok: false, status: 400, error: 'kind is required (at most 60 characters).' };
  }
  const engagement = await db.serviceEngagement.findUnique({
    where: { id: engagementId },
    select: { id: true, state: true },
  });
  if (!engagement) return { ok: false, status: 404, error: 'Engagement not found.' };

  const revisionLimit = options.revisionLimit === undefined || options.revisionLimit === null ? 2 : options.revisionLimit;
  if (typeof revisionLimit !== 'number' || !Number.isInteger(revisionLimit) || revisionLimit < 0 || revisionLimit > 10) {
    return { ok: false, status: 400, error: 'revisionLimit must be an integer between 0 and 10. Revisions are finite.' };
  }

  const created = await db.deliverable.create({
    data: {
      engagementId,
      title: options.title.trim(),
      kind: options.kind.trim(),
      milestoneKey: typeof options.milestoneKey === 'string' ? options.milestoneKey : null,
      revisionLimit,
      isPreview: options.isPreview === true,
      // State is DRAFT by construction: a generated artifact is never
      // automatically delivered or accepted.
      state: 'DRAFT',
      revisionCount: 0,
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_DELIVERABLE_CREATED',
    surface: options.surface,
    outcome: 'ok',
    detail: `deliverable=${created.id.slice(0, 12)} engagement=${engagementId.slice(0, 12)} state=DRAFT`,
  });
  return { ok: true, deliverableId: created.id, state: 'DRAFT' };
}

export async function transitionDeliverable(options: {
  deliverableId: unknown;
  to: unknown;
  actor: 'ADMIN' | 'SYSTEM' | 'CLIENT_EVIDENCE' | 'QA';
  /** Client-requested change text; classified, never executed directly. */
  revisionRequest?: unknown;
  acceptanceEvidence?: unknown;
  artifactRefs?: unknown;
  qaSummary?: unknown;
  surface: string;
}): Promise<EngagementResult> {
  const deliverableId = typeof options.deliverableId === 'string' ? options.deliverableId : null;
  if (!deliverableId) return { ok: false, status: 400, error: 'deliverableId is required.' };
  const deliverable = await db.deliverable.findUnique({
    where: { id: deliverableId },
    include: { engagement: { select: { state: true } } },
  });
  if (!deliverable) return { ok: false, status: 404, error: 'Deliverable not found.' };
  if (!isDeliverableState(options.to)) {
    return { ok: false, status: 400, error: `to must be one of: ${DELIVERABLE_STATES.join(', ')}.` };
  }

  const verdict = canTransitionDeliverable({
    from: deliverable.state as DeliverableState,
    to: options.to,
    actor: options.actor,
    acceptanceEvidence: options.acceptanceEvidence,
    revisionCount: deliverable.revisionCount,
    revisionLimit: deliverable.revisionLimit,
    engagementState: deliverable.engagement.state,
    isPreview: deliverable.isPreview,
  });
  if (!verdict.ok) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_DELIVERABLE_TRANSITION_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: `deliverable=${deliverableId.slice(0, 12)} ${deliverable.state}->${String(options.to)}: ${verdict.reason.slice(0, 100)}`,
    });
    return { ok: false, status: 400, error: verdict.reason };
  }

  const to = options.to as DeliverableState;
  const updates: Prisma.DeliverableUpdateInput = { state: to };
  if (verdict.revisionNumber !== null) {
    // A revision round consumes the finite allowance.
    updates.revisionCount = { increment: 1 };
  }
  if (to === 'DELIVERED') updates.deliveredAt = new Date();
  if (to === 'ACCEPTED') {
    updates.acceptedAt = new Date();
    const parsed = parseDeliveryAcceptance(options.acceptanceEvidence);
    if (parsed.ok) {
      updates.acceptanceEvidence = JSON.stringify(options.acceptanceEvidence).slice(0, 2_000);
    }
  }
  if (typeof options.artifactRefs === 'object' && options.artifactRefs !== null && !Array.isArray(options.artifactRefs)) {
    // Bounded: artifact refs only, never secrets/credentials.
    updates.artifactRefs = JSON.stringify(options.artifactRefs).slice(0, 4_000);
  }
  if (typeof options.qaSummary === 'string') updates.qaSummary = options.qaSummary.slice(0, 1_000);

  await db.deliverable.update({ where: { id: deliverable.id }, data: updates });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_DELIVERABLE_STATE',
    surface: options.surface,
    outcome: 'ok',
    detail: `deliverable=${deliverable.id.slice(0, 12)} ${deliverable.state}->${to}`,
  });
  return { ok: true, state: to, revisionNumber: verdict.revisionNumber };
}

/**
 * Classify a client's revision request. Returns the decision WITHOUT mutating
 * the deliverable: within allowance → REVISION; beyond → CHANGE_REQUEST_REQUIRED
 * (a paid change request), never a silent additional round.
 */
export async function classifyDeliverableRevision(options: {
  deliverableId: unknown;
  requestedSummary: unknown;
  surface: string;
}): Promise<EngagementResult> {
  const deliverableId = typeof options.deliverableId === 'string' ? options.deliverableId : null;
  if (!deliverableId) return { ok: false, status: 400, error: 'deliverableId is required.' };
  if (typeof options.requestedSummary !== 'string' || options.requestedSummary.trim().length === 0) {
    return { ok: false, status: 400, error: 'requestedSummary is required.' };
  }
  const deliverable = await db.deliverable.findUnique({
    where: { id: deliverableId },
    select: { id: true, revisionCount: true, revisionLimit: true },
  });
  if (!deliverable) return { ok: false, status: 404, error: 'Deliverable not found.' };

  const classification = classifyRevisionRequest({
    requestedSummary: options.requestedSummary,
    revisionCount: deliverable.revisionCount,
    revisionLimit: deliverable.revisionLimit,
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_REVISION_CLASSIFIED',
    surface: options.surface,
    outcome: 'ok',
    detail: `deliverable=${deliverableId.slice(0, 12)} kind=${classification.kind} used=${deliverable.revisionCount}/${deliverable.revisionLimit}`,
  });
  return { ok: true, classification: classification.kind, reason: classification.reason };
}

// ---------------------------------------------------------------------------
// Issues (human-only decisions)
// ---------------------------------------------------------------------------

export async function createServiceIssue(options: {
  engagementId: unknown;
  issueType: unknown;
  summary?: unknown;
  correlationId?: unknown;
  surface: string;
}): Promise<EngagementResult> {
  const engagementId = typeof options.engagementId === 'string' ? options.engagementId : null;
  if (!engagementId) return { ok: false, status: 400, error: 'engagementId is required.' };
  if (!isServiceIssueType(options.issueType)) {
    return { ok: false, status: 400, error: `issueType must be one of: ${SERVICE_ISSUE_TYPES.join(', ')}.` };
  }
  const engagement = await db.serviceEngagement.findUnique({ where: { id: engagementId }, select: { id: true } });
  if (!engagement) return { ok: false, status: 404, error: 'Engagement not found.' };

  const created = await db.serviceIssue.create({
    data: {
      engagementId,
      issueType: options.issueType,
      summary: typeof options.summary === 'string' ? options.summary.slice(0, 1_000) : '',
      correlationId: options.correlationId === 'client-message' ? `client-message:${randomUUID()}` : 'admin:manual',
      // Every issue requires a human decision; the system only drafts.
      requiresHuman: true,
    },
  });
  // Route the issue into the EXISTING human-review queue.
  await db.humanReview.create({
    data: {
      category: 'IRREVERSIBLE',
      title: `Service issue requires human decision: ${created.issueType}`,
      detail: `engagement=${engagementId} issue=${created.id} summary=${created.summary.slice(0, 200)}`.slice(0, 300),
      requestedBy: 'system',
      status: 'PENDING',
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_SERVICE_ISSUE_OPENED',
    surface: options.surface,
    outcome: 'ok',
    detail: `issue=${created.id.slice(0, 12)} type=${created.issueType} requiresHuman=true`,
  });
  return { ok: true, issueId: created.id, requiresHuman: true };
}

export async function resolveServiceIssue(options: {
  issueId: unknown;
  to: unknown;
  resolutionNote?: unknown;
  actor: string;
  surface: string;
}): Promise<EngagementResult> {
  const issueId = typeof options.issueId === 'string' ? options.issueId : null;
  if (!issueId) return { ok: false, status: 400, error: 'issueId is required.' };
  const issue = await db.serviceIssue.findUnique({
    where: { id: issueId },
    select: { id: true, status: true, issueType: true },
  });
  if (!issue) return { ok: false, status: 404, error: 'Service issue not found.' };
  if (!isServiceIssueStatus(options.to)) {
    return { ok: false, status: 400, error: 'to must be a valid issue status.' };
  }
  const verdict = canTransitionIssue({
    from: issue.status as ServiceIssueStatus,
    to: options.to,
    issueType: issue.issueType as ServiceIssueType,
    // Only an admin (a verified session in the route) can decide.
    actor: 'ADMIN',
  });
  if (!verdict.ok) return { ok: false, status: 400, error: verdict.reason };
  const to = options.to as ServiceIssueStatus;
  await db.serviceIssue.update({
    where: { id: issue.id },
    data: {
      status: to,
      resolutionNote: typeof options.resolutionNote === 'string' ? options.resolutionNote.slice(0, 1_000) : '',
      decidedBy: options.actor,
      decidedAt: new Date(),
    },
  });
  await auditSecurityEvent({
    kind: 'COMMERCIAL_SERVICE_ISSUE_RESOLVED',
    surface: options.surface,
    outcome: 'ok',
    detail: `issue=${issue.id.slice(0, 12)} ${issue.status}->${to}`,
  });
  return { ok: true, status: to };
}

// ---------------------------------------------------------------------------
// Evidence-backed revenue — the ONLY path that writes service revenue
// ---------------------------------------------------------------------------

/**
 * Record verified service revenue into the EXISTING Revenue ledger.
 *
 * Requires a PaymentVerificationSource. There is deliberately NO "paid: true"
 * body field, no client-supplied status, and no screenshot path. The revenue
 * row is written with a deterministic idempotencyKey derived from the
 * (engagement, milestone, verification ref) triple, so replaying the same
 * verified payment can never double-count.
 */
export async function recordServiceRevenue(options: {
  engagementId: unknown;
  milestoneId?: unknown;
  paymentVerificationSource: unknown;
  paymentVerificationRef: unknown;
  revenueSource: unknown;
  amountUsd: unknown;
  surface: string;
}): Promise<EngagementResult> {
  const engagementId = typeof options.engagementId === 'string' ? options.engagementId : null;
  if (!engagementId) return { ok: false, status: 400, error: 'engagementId is required.' };

  // The gate. No source ⇒ no revenue, ever.
  if (!isPaymentVerificationSource(options.paymentVerificationSource)) {
    await auditSecurityEvent({
      kind: 'COMMERCIAL_REVENUE_REFUSED',
      surface: options.surface,
      outcome: 'refused',
      detail: 'revenue refused: paymentVerificationSource is not PROVIDER_WEBHOOK | PROVIDER_API | MANUAL_ADMIN_APPROVED',
    });
    return {
      ok: false, status: 400,
      error: 'Revenue requires a paymentVerificationSource (PROVIDER_WEBHOOK | PROVIDER_API | MANUAL_ADMIN_APPROVED).',
    };
  }
  if (typeof options.paymentVerificationRef !== 'string' || options.paymentVerificationRef.trim().length === 0) {
    return { ok: false, status: 400, error: 'paymentVerificationRef is required (a real provider reference).' };
  }
  if (typeof options.amountUsd !== 'number' || !Number.isFinite(options.amountUsd) || options.amountUsd <= 0) {
    return { ok: false, status: 400, error: 'amountUsd must be a positive finite number. Revenue is never fabricated.' };
  }
  if (typeof options.revenueSource !== 'string' || options.revenueSource.trim().length === 0 || options.revenueSource.length > 60) {
    return { ok: false, status: 400, error: 'revenueSource is required (at most 60 characters).' };
  }

  const engagement = await db.serviceEngagement.findUnique({
    where: { id: engagementId },
    select: { id: true, opportunityId: true, currency: true, state: true },
  });
  if (!engagement) return { ok: false, status: 404, error: 'Engagement not found.' };

  const milestoneId = typeof options.milestoneId === 'string' ? options.milestoneId : null;
  if (milestoneId) {
    const milestone = await db.milestone.findUnique({ where: { id: milestoneId }, select: { id: true, engagementId: true } });
    if (!milestone) return { ok: false, status: 404, error: 'Milestone not found.' };
    // Object-level authorization: the milestone must belong to this engagement.
    if (milestone.engagementId !== engagement.id) {
      return { ok: false, status: 400, error: 'Milestone does not belong to this engagement.' };
    }
  }

  // Deterministic idempotency key — a replayed verified payment is a no-op.
  const idempotencyKey = `service:${engagementId}:${milestoneId ?? 'engagement'}:${options.paymentVerificationRef}`;

  try {
    const created = await db.revenue.create({
      data: {
        date: new Date(),
        revenueSource: options.revenueSource.trim(),
        grossRevenue: options.amountUsd,
        fees: 0,
        advertisingCost: 0,
        otherCosts: 0,
        netRevenue: options.amountUsd,
        currency: engagement.currency,
        opportunityId: engagement.opportunityId,
        idempotencyKey,
        referenceNote: `Verified via ${options.paymentVerificationSource}. Engagement ${engagementId}.`.slice(0, 300),
      },
    });
    await auditSecurityEvent({
      kind: 'COMMERCIAL_REVENUE_RECORDED',
      surface: options.surface,
      outcome: 'ok',
      detail: `revenue=${created.id.slice(0, 12)} engagement=${engagementId.slice(0, 12)} source=${options.paymentVerificationSource}`,
    });
    return { ok: true, revenueId: created.id, idempotencyKey };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
      // Duplicate verified payment — idempotent success, never a double-count.
      const existing = await db.revenue.findUnique({ where: { idempotencyKey }, select: { id: true } });
      await auditSecurityEvent({
        kind: 'COMMERCIAL_REVENUE_DUPLICATE',
        surface: options.surface,
        outcome: 'ok',
        detail: `engagement=${engagementId.slice(0, 12)} idempotent replay — no second revenue row created`,
      });
      return { ok: true, revenueId: existing?.id ?? null, duplicate: true, idempotencyKey };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listEngagements(options: { state?: unknown; engagementType?: unknown; limit?: unknown }) {
  const where: Prisma.ServiceEngagementWhereInput = {};
  if (options.state !== undefined && options.state !== null) {
    if (!isEngagementState(options.state)) return { ok: false as const, status: 400 as const, error: 'Invalid state filter.' };
    where.state = options.state;
  }
  if (options.engagementType !== undefined && options.engagementType !== null) {
    const type = String(options.engagementType);
    if (type !== 'MICRO_SERVICE' && type !== 'CLIENT_SERVICE') {
      return { ok: false as const, status: 400 as const, error: 'Invalid engagementType filter.' };
    }
    where.engagementType = type;
  }
  const limit = Math.max(1, Math.min(typeof options.limit === 'number' ? Math.floor(options.limit) : 50, MAX_ENGAGEMENTS_PER_PAGE));
  const engagements = await db.serviceEngagement.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true, engagementType: true, title: true, state: true, paymentState: true,
      totalPrice: true, currency: true, exposureCapUsd: true, completedAt: true, updatedAt: true,
    },
  });
  return { ok: true as const, engagements };
}

export async function getEngagementDetail(engagementId: unknown) {
  if (typeof engagementId !== 'string' || engagementId.length === 0 || engagementId.length > 128) return null;
  return db.serviceEngagement.findUnique({
    where: { id: engagementId },
    include: {
      milestones: { orderBy: { createdAt: 'asc' } },
      deliverables: { orderBy: { createdAt: 'asc' } },
      issues: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
}

export { isWorkAuthorized };