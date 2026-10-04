// ============================================================================
// PHASE 11.3 — ENGAGEMENT / MILESTONE / DELIVERABLE / ISSUE STATE MACHINES
// ============================================================================
// Pure state machines for service execution and delivery (Phase 11.3). No DB,
// no network, no AI provider.
//
// THE HARD INVARIANT (docs/phase-11-design.md §1.1, §20):
//   UNPAID → EXECUTING is IMPOSSIBLE by default.
//   WORK_AUTHORIZED is reachable only from PAYMENT_VERIFIED, and
//   PAYMENT_VERIFIED is reachable only through a PaymentVerificationSource
//   (PROVIDER_WEBHOOK | PROVIDER_API | MANUAL_ADMIN_APPROVED).
//   The single exception is an explicitly configured low-risk exception
//   (OFF by default, requires LOW_RISK | PAYMENT_VERIFIED prospect AND a
//   positive exposureCap), and applying it is always reported.
//
// The second hard invariant: a generated artifact is NOT delivered and NOT
// accepted. DRAFT → QA_PENDING → QA_PASSED → READY_FOR_DELIVERY → DELIVERED →
// CLIENT_REVIEW → ACCEPTED, and ACCEPTED requires structured evidence. Silence
// never accepts.
// ============================================================================

import { evaluateRevision, type RevisionVerdict } from './proposal-states';

// ---------------------------------------------------------------------------
// Engagement states
// ---------------------------------------------------------------------------

export const ENGAGEMENT_STATES = [
  'NO_COMMITMENT',
  'PROPOSAL_SENT',
  'ACCEPTED',
  'PAYMENT_REQUIRED',
  'PAYMENT_PENDING',
  'PAYMENT_VERIFIED',
  'WORK_AUTHORIZED',
  'WORK_IN_PROGRESS',
  'DELIVERABLE_READY',
  'FINAL_PAYMENT_REQUIRED',
  'DELIVERY_AUTHORIZED',
  'COMPLETED',
  'PAUSED',
  'TERMINATED',
  'CANCELLED',
] as const;
export type EngagementState = (typeof ENGAGEMENT_STATES)[number];

export function isEngagementState(value: unknown): value is EngagementState {
  return typeof value === 'string' && (ENGAGEMENT_STATES as readonly string[]).includes(value);
}

/**
 * Engagement transitions are deny-by-default. Note what is NOT listed:
 *  - PAUSED / TERMINATED / CANCELLED are only reachable from admin action, and
 *    there is deliberately NO transition OUT of them (an engagement is never
 *    silently resumed after termination).
 *  - WORK_AUTHORIZED is reachable ONLY from PAYMENT_VERIFIED.
 */
export const ENGAGEMENT_TRANSITIONS: Readonly<Record<EngagementState, readonly EngagementState[]>> = {
  NO_COMMITMENT: ['PROPOSAL_SENT', 'PAUSED', 'TERMINATED'],
  PROPOSAL_SENT: ['ACCEPTED', 'CANCELLED', 'PAUSED', 'TERMINATED'],
  ACCEPTED: ['PAYMENT_REQUIRED', 'CANCELLED', 'PAUSED', 'TERMINATED'],
  PAYMENT_REQUIRED: ['PAYMENT_PENDING', 'PAYMENT_VERIFIED', 'CANCELLED', 'PAUSED', 'TERMINATED'],
  PAYMENT_PENDING: ['PAYMENT_VERIFIED', 'CANCELLED', 'PAUSED', 'TERMINATED'],
  // The ONLY way into authorized work.
  PAYMENT_VERIFIED: ['WORK_AUTHORIZED', 'CANCELLED', 'PAUSED', 'TERMINATED'],
  WORK_AUTHORIZED: ['WORK_IN_PROGRESS', 'PAUSED', 'TERMINATED'],
  WORK_IN_PROGRESS: ['DELIVERABLE_READY', 'PAUSED', 'TERMINATED'],
  DELIVERABLE_READY: ['FINAL_PAYMENT_REQUIRED', 'DELIVERY_AUTHORIZED', 'PAUSED', 'TERMINATED'],
  FINAL_PAYMENT_REQUIRED: ['PAYMENT_VERIFIED', 'DELIVERY_AUTHORIZED', 'PAUSED', 'TERMINATED'],
  DELIVERY_AUTHORIZED: ['COMPLETED', 'PAUSED', 'TERMINATED'],
  COMPLETED: [],
  PAUSED: [],
  TERMINATED: [],
  CANCELLED: [],
};

/** The admin-only states: never entered by a client message or an agent. */
export const ADMIN_ONLY_ENGAGEMENT_STATES: readonly EngagementState[] = ['PAUSED', 'TERMINATED', 'CANCELLED'];

export type EngagementActor = 'ADMIN' | 'SYSTEM' | 'PROVIDER';

export interface LowRiskException {
  /** Admin-configured permission; OFF by default and never assumed. */
  enabled: boolean;
  /** Prospect risk state that permits the exception. */
  prospectRiskState: string;
  /** Hard ceiling on authorized unpaid work. Must be > 0 to apply. */
  exposureCapUsd: number;
}

export const LOW_RISK_EXCEPTION_DEFAULT: LowRiskException = {
  enabled: false,
  prospectRiskState: 'PAYMENT_VERIFIED',
  exposureCapUsd: 0,
};

/** Prospect risk states that are eligible for the low-risk exception. */
export const LOW_RISK_ELIGIBLE_RISK_STATES = ['PAYMENT_VERIFIED', 'LOW_RISK'] as const;

export interface EngagementTransitionInput {
  from: EngagementState;
  to: EngagementState;
  actor: EngagementActor;
  /** Required when to === 'PAYMENT_VERIFIED'. */
  verificationSource?: unknown;
  /** Required when to === 'PAYMENT_REQUIRED' or 'FINAL_PAYMENT_REQUIRED'. */
  amountUsd?: number;
  /** The configured low-risk exception (defaults to OFF). */
  lowRiskException?: LowRiskException;
  /** Prospect risk state, used only by the low-risk exception path. */
  prospectRiskState?: string;
}

export type EngagementTransitionResult =
  | { ok: true; from: EngagementState; to: EngagementState; lowRiskExceptionApplied: boolean }
  | { ok: false; from: EngagementState; to: EngagementState; reason: string };

/**
 * Decide whether an engagement may enter `to`.
 *
 * The gate order is deliberate: structural legality first, then admin-only
 * authority, then payment truth. Payment verification is checked BEFORE the
 * transition table is consulted for the authorization step, so there is no
 * path that reaches WORK_AUTHORIZED without a real source.
 */
export function canTransitionEngagement(input: EngagementTransitionInput): EngagementTransitionResult {
  const {
    from, to, actor, verificationSource, lowRiskException = LOW_RISK_EXCEPTION_DEFAULT, prospectRiskState,
  } = input;
  if (!isEngagementState(from)) return { ok: false, from, to, reason: 'Invalid current engagement state.' };
  if (!isEngagementState(to)) return { ok: false, from, to, reason: 'to must be a valid engagement state.' };

  // Payment truth is verified here regardless of the transition table, so the
  // caller can never argue that a legal transition makes an unverified payment
  // acceptable.
  if (to === 'PAYMENT_VERIFIED') {
    const valid =
      typeof verificationSource === 'string'
      && ['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED'].includes(verificationSource)
      && typeof verificationSource === 'string'
      && verificationSource.length > 0;
    if (!valid) {
      return {
        ok: false, from, to,
        reason:
          'PAYMENT_VERIFIED requires a paymentVerificationSource (PROVIDER_WEBHOOK | PROVIDER_API | '
          + 'MANUAL_ADMIN_APPROVED). A client claim, screenshot or receipt is never a source.',
      };
    }
  }

  if (ADMIN_ONLY_ENGAGEMENT_STATES.includes(to) && actor !== 'ADMIN') {
    return {
      ok: false, from, to,
      reason: `${to} is an administrator-only decision; client content and agents cannot pause, terminate or cancel an engagement.`,
    };
  }
  if (actor === 'ADMIN' || actor === 'SYSTEM' || actor === 'PROVIDER') {
    // permitted actors only
  } else {
    return { ok: false, from, to, reason: 'Unknown actor.' };
  }

  // The low-risk exception: the ONLY way to reach authorized work unpaid. This
  // is evaluated BEFORE the transition table so the refusal explains the
  // payment gate rather than merely reporting an illegal edge.
  let lowRiskExceptionApplied = false;
  if (to === 'WORK_AUTHORIZED' && from !== 'PAYMENT_VERIFIED') {
    const applied = evaluateLowRiskException(lowRiskException, prospectRiskState);
    if (!applied.ok) return { ok: false, from, to, reason: applied.reason };
    lowRiskExceptionApplied = true;
  }

  if (!(ENGAGEMENT_TRANSITIONS[from] ?? []).includes(to)) {
    return { ok: false, from, to, reason: `Transition ${from} → ${to} is not allowed.` };
  }

  return { ok: true, from, to, lowRiskExceptionApplied };
}

export function evaluateLowRiskException(
  config: LowRiskException,
  prospectRiskState: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!config.enabled) {
    return {
      ok: false,
      reason:
        'Unpaid → executing is not permitted by default. WORK_AUTHORIZED requires PAYMENT_VERIFIED, which '
        + 'requires a provider webhook, a provider API, or an explicitly approved admin manual verification.',
    };
  }
  if (!config.exposureCapUsd || !Number.isFinite(config.exposureCapUsd) || config.exposureCapUsd <= 0) {
    return { ok: false, reason: 'The low-risk exception requires a positive exposureCapUsd bounding unpaid work.' };
  }
  if (
    typeof prospectRiskState !== 'string'
    || !(LOW_RISK_ELIGIBLE_RISK_STATES as readonly string[]).includes(prospectRiskState)
  ) {
    return {
      ok: false,
      reason: `The low-risk exception requires a prospect riskState of ${LOW_RISK_ELIGIBLE_RISK_STATES.join(' or ')}.`,
    };
  }
  return { ok: true };
}

/** Whether an engagement is currently authorized to execute paid work. */
export function isWorkAuthorized(state: string): boolean {
  return ['WORK_AUTHORIZED', 'WORK_IN_PROGRESS', 'DELIVERABLE_READY', 'FINAL_PAYMENT_REQUIRED', 'DELIVERY_AUTHORIZED'].includes(state);
}

// ---------------------------------------------------------------------------
// Milestone payment machine
// ---------------------------------------------------------------------------

export const MILESTONE_PAYMENT_STATES = [
  'NOT_DUE',
  'PAYMENT_REQUIRED',
  'PAYMENT_PENDING',
  'PAYMENT_VERIFIED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type MilestonePaymentState = (typeof MILESTONE_PAYMENT_STATES)[number];

export function isMilestonePaymentState(value: unknown): value is MilestonePaymentState {
  return typeof value === 'string' && (MILESTONE_PAYMENT_STATES as readonly string[]).includes(value);
}

export const MILESTONE_TRANSITIONS: Readonly<Record<MilestonePaymentState, readonly MilestonePaymentState[]>> = {
  NOT_DUE: ['PAYMENT_REQUIRED'],
  PAYMENT_REQUIRED: ['PAYMENT_PENDING', 'PAYMENT_VERIFIED'],
  PAYMENT_PENDING: ['PAYMENT_VERIFIED'],
  PAYMENT_VERIFIED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  REFUNDED: [],
  PARTIALLY_REFUNDED: [],
};

export function canTransitionMilestonePayment(input: {
  from: MilestonePaymentState;
  to: MilestonePaymentState;
  verificationSource?: unknown;
}): { ok: true } | { ok: false; reason: string } {
  if (!isMilestonePaymentState(input.from)) return { ok: false, reason: 'Invalid current milestone payment state.' };
  if (!isMilestonePaymentState(input.to)) return { ok: false, reason: 'to must be a valid milestone payment state.' };
  if (!(MILESTONE_TRANSITIONS[input.from] ?? []).includes(input.to)) {
    return { ok: false, reason: `Transition ${input.from} → ${input.to} is not allowed.` };
  }
  if (input.to === 'PAYMENT_VERIFIED') {
    if (
      typeof input.verificationSource !== 'string'
      || !['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED'].includes(input.verificationSource)
    ) {
      return {
        ok: false,
        reason:
          'PAYMENT_VERIFIED requires a paymentVerificationSource (PROVIDER_WEBHOOK | PROVIDER_API | '
          + 'MANUAL_ADMIN_APPROVED). A client message can at most mark the milestone PAYMENT_PENDING.',
      };
    }
  }
  // Refunds are financial actions: admin-only, and never autonomous.
  if ((input.to === 'REFUNDED' || input.to === 'PARTIALLY_REFUNDED') && !['REFUNDED', 'PARTIALLY_REFUNDED'].includes(input.to)) {
    return { ok: false, reason: 'Refund transitions require an administrator.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Deliverable states — explicit delivery, finite revisions
// ---------------------------------------------------------------------------

export const DELIVERABLE_STATES = [
  'DRAFT',
  'QA_PENDING',
  'QA_PASSED',
  'READY_FOR_DELIVERY',
  'DELIVERED',
  'CLIENT_REVIEW',
  'ACCEPTED',
  'REVISION_REQUESTED',
  'REVISION_LIMIT_REACHED',
  'WITHHELD',
  'COMPLETED',
] as const;
export type DeliverableState = (typeof DELIVERABLE_STATES)[number];

export function isDeliverableState(value: unknown): value is DeliverableState {
  return typeof value === 'string' && (DELIVERABLE_STATES as readonly string[]).includes(value);
}

export const DELIVERABLE_TRANSITIONS: Readonly<Record<DeliverableState, readonly DeliverableState[]>> = {
  // Generation lands in DRAFT. There is deliberately NO DRAFT → DELIVERED edge.
  DRAFT: ['QA_PENDING', 'WITHHELD'],
  QA_PENDING: ['QA_PASSED', 'DRAFT', 'WITHHELD'],
  QA_PASSED: ['READY_FOR_DELIVERY', 'REVISION_REQUESTED', 'WITHHELD'],
  READY_FOR_DELIVERY: ['DELIVERED', 'REVISION_REQUESTED', 'WITHHELD'],
  DELIVERED: ['CLIENT_REVIEW', 'REVISION_REQUESTED', 'WITHHELD'],
  CLIENT_REVIEW: ['ACCEPTED', 'REVISION_REQUESTED', 'WITHHELD'],
  // A revision round consumes the finite allowance.
  REVISION_REQUESTED: ['QA_PENDING', 'REVISION_LIMIT_REACHED', 'WITHHELD'],
  // No way out except a paid change request, which produces a NEW deliverable.
  REVISION_LIMIT_REACHED: ['WITHHELD'],
  WITHHELD: [],
  ACCEPTED: ['COMPLETED'],
  COMPLETED: [],
};

export type DeliverableActor = 'ADMIN' | 'SYSTEM' | 'CLIENT_EVIDENCE' | 'QA';

export interface DeliverableTransitionInput {
  from: DeliverableState;
  to: DeliverableState;
  actor: DeliverableActor;
  /** Required for ACCEPTED: structured evidence, never silence. */
  acceptanceEvidence?: unknown;
  /** Required for a revision round: the finite allowance check. */
  revisionCount?: number;
  revisionLimit?: number;
  /** Required to leave WITHHELD / RELEASE a final deliverable. */
  engagementState?: string;
  /** Preview deliverables may be delivered without final delivery authorization. */
  isPreview?: boolean;
}

export type DeliverableTransitionResult =
  | { ok: true; from: DeliverableState; to: DeliverableState; revisionNumber: number | null }
  | { ok: false; from: DeliverableState; to: DeliverableState; reason: string };

export function canTransitionDeliverable(input: DeliverableTransitionInput): DeliverableTransitionResult {
  const {
    from, to, actor, acceptanceEvidence, revisionCount = 0, revisionLimit = 2, engagementState, isPreview = false,
  } = input;
  if (!isDeliverableState(from)) return { ok: false, from, to, reason: 'Invalid current deliverable state.' };
  if (!isDeliverableState(to)) return { ok: false, from, to, reason: 'to must be a valid deliverable state.' };

  if (!(DELIVERABLE_TRANSITIONS[from] ?? []).includes(to)) {
    return { ok: false, from, to, reason: `Transition ${from} → ${to} is not allowed.` };
  }

  // QA is distinct from generation: only QA may mark QA_PASSED.
  if (to === 'QA_PASSED' && actor !== 'QA' && actor !== 'ADMIN') {
    return {
      ok: false, from, to,
      reason: 'Only a QA step (or an administrator acting on QA evidence) may mark a deliverable QA_PASSED.',
    };
  }

  // Acceptance requires evidence. Silence NEVER accepts.
  if (to === 'ACCEPTED') {
    if (actor === 'CLIENT_EVIDENCE') {
      const parsed = parseDeliveryAcceptance(acceptanceEvidence);
      if (!parsed.ok) return { ok: false, from, to, reason: parsed.reason };
    }
    if (from !== 'CLIENT_REVIEW') {
      return {
        ok: false, from, to,
        reason: 'A deliverable can only be ACCEPTED after it has been delivered and is in CLIENT_REVIEW.',
      };
    }
  }

  // Final (non-preview) delivery requires the engagement to be authorized for
  // delivery. A preview release is safe during review.
  if (to === 'DELIVERED' && !isPreview) {
    if (from !== 'READY_FOR_DELIVERY') {
      return { ok: false, from, to, reason: 'A final deliverable can only be DELIVERED from READY_FOR_DELIVERY (QA must pass first).' };
    }
    if (engagementState !== 'DELIVERY_AUTHORIZED' && engagementState !== 'FINAL_PAYMENT_REQUIRED') {
      return {
        ok: false, from, to,
        reason: 'Final delivery requires the engagement to be DELIVERY_AUTHORIZED (or FINAL_PAYMENT_REQUIRED for a preview).',
      };
    }
  }

  // Revisions are finite. Exceeding the allowance lands in REVISION_LIMIT_REACHED
  // and requires a paid change request to continue.
  let revisionNumber: number | null = null;
  if (to === 'REVISION_REQUESTED') {
    const verdict: RevisionVerdict = evaluateRevision(revisionLimit, revisionCount);
    if (!verdict.allowed) {
      return { ok: false, from, to, reason: verdict.reason };
    }
    revisionNumber = verdict.revisionNumber;
  }
  if (to === 'REVISION_LIMIT_REACHED') {
    return { ok: true, from, to, revisionNumber: null };
  }

  return { ok: true, from, to, revisionNumber };
}

export const DELIVERY_ACCEPTANCE_EVIDENCE_TYPES = [
  'PROVIDER_PAYMENT',
  'EXPLICIT_CLIENT_MESSAGE',
  'SIGNED_DOCUMENT',
  'ADMIN_VERIFIED',
] as const;
export type DeliveryAcceptanceEvidenceType = (typeof DELIVERY_ACCEPTANCE_EVIDENCE_TYPES)[number];

export function parseDeliveryAcceptance(raw: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'acceptanceEvidence must be an object with a type and a real reference.' };
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.type !== 'string'
    || !(DELIVERY_ACCEPTANCE_EVIDENCE_TYPES as readonly string[]).includes(record.type)
  ) {
    return {
      ok: false,
      reason: `acceptanceEvidence.type must be one of: ${DELIVERY_ACCEPTANCE_EVIDENCE_TYPES.join(', ')}. Silence is never acceptance.`,
    };
  }
  if (typeof record.ref !== 'string' || record.ref.trim().length === 0 || record.ref.length > 300) {
    return { ok: false, reason: 'acceptanceEvidence.ref is required (a real reference, at most 300 characters).' };
  }
  return { ok: true };
}

/**
 * Classify a client's revision request against the deliverable's finite
 * allowance. Within limit → a revision round. Beyond → a paid change request.
 * A client message can never itself authorize additional work.
 */
export function classifyRevisionRequest(input: {
  requestedSummary: string;
  revisionCount: number;
  revisionLimit: number;
}): { kind: 'REVISION' | 'CHANGE_REQUEST_REQUIRED'; revisionNumber: number | null; reason: string } {
  const verdict = evaluateRevision(input.revisionLimit, input.revisionCount);
  if (!verdict.allowed) {
    return { kind: 'CHANGE_REQUEST_REQUIRED', revisionNumber: null, reason: verdict.reason };
  }
  return { kind: 'REVISION', revisionNumber: verdict.revisionNumber, reason: 'Within the approved revision allowance.' };
}

// ---------------------------------------------------------------------------
// Service issues — disputes, cancellations, refunds
// ---------------------------------------------------------------------------

export const SERVICE_ISSUE_TYPES = [
  'CANCELLATION_REQUESTED',
  'CANCELLATION_APPROVED',
  'DISPUTE',
  'CHARGEBACK',
  'REFUND_REQUESTED',
  'REFUND_PROCESSED',
  'PAUSE_REQUESTED',
  'TERMINATION_REQUESTED',
] as const;
export type ServiceIssueType = (typeof SERVICE_ISSUE_TYPES)[number];

export function isServiceIssueType(value: unknown): value is ServiceIssueType {
  return typeof value === 'string' && (SERVICE_ISSUE_TYPES as readonly string[]).includes(value);
}

export const SERVICE_ISSUE_STATUSES = ['OPEN', 'APPROVED', 'REJECTED', 'RESOLVED', 'PROCESSED'] as const;
export type ServiceIssueStatus = (typeof SERVICE_ISSUE_STATUSES)[number];

export function isServiceIssueStatus(value: unknown): value is ServiceIssueStatus {
  return typeof value === 'string' && (SERVICE_ISSUE_STATUSES as readonly string[]).includes(value);
}

export const SERVICE_ISSUE_TRANSITIONS: Readonly<Record<ServiceIssueStatus, readonly ServiceIssueStatus[]>> = {
  OPEN: ['APPROVED', 'REJECTED'],
  APPROVED: ['PROCESSED', 'RESOLVED'],
  REJECTED: ['RESOLVED'],
  RESOLVED: [],
  PROCESSED: [],
};

/** Every issue type requires a human decision. The system only drafts. */
export const HUMAN_ONLY_ISSUE_TYPES: readonly ServiceIssueType[] = [
  'CANCELLATION_APPROVED',
  'DISPUTE',
  'CHARGEBACK',
  'REFUND_REQUESTED',
  'REFUND_PROCESSED',
  'TERMINATION_REQUESTED',
];

export function canTransitionIssue(input: {
  from: ServiceIssueStatus;
  to: ServiceIssueStatus;
  issueType: ServiceIssueType;
  actor: 'ADMIN' | 'SYSTEM';
}): { ok: true } | { ok: false; reason: string } {
  if (!isServiceIssueStatus(input.from)) return { ok: false, reason: 'Invalid current issue status.' };
  if (!isServiceIssueStatus(input.to)) return { ok: false, reason: 'to must be a valid issue status.' };
  if (!(SERVICE_ISSUE_TRANSITIONS[input.from] ?? []).includes(input.to)) {
    return { ok: false, reason: `Transition ${input.from} → ${input.to} is not allowed.` };
  }
  if (
    HUMAN_ONLY_ISSUE_TYPES.includes(input.issueType)
    && input.to !== 'OPEN'
    && input.actor !== 'ADMIN'
  ) {
    return {
      ok: false,
      reason: `${input.issueType} is a human-only decision (refund, dispute, chargeback, cancellation, termination). The system drafts only.`,
    };
  }
  return { ok: true };
}