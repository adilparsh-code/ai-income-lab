// ============================================================================
// PHASE 11.1 — PROSPECT STATES + DETERMINISTIC RISK ENGINE
// ============================================================================
// Safe constants, validators, and state-transition helpers for the Prospect
// lifecycle and risk model designed in docs/phase-11-design.md (Phase 11.0
// §3.1, §6, §10). Everything here is deterministic, explainable, and unit
// tested. There is NO opaque AI score anywhere.
//
// Hard invariants (Phase 11.0 §10, Phase 11.1 spec §9–10):
// - riskState = PAYMENT_VERIFIED can ONLY be set through an explicit
//   verification source (PROVIDER_WEBHOOK | PROVIDER_API |
//   MANUAL_ADMIN_APPROVED). A client message, screenshot, receipt, or
//   transaction-id claim can NEVER set it (see message-classifier: claims
//   become PAYMENT_CLAIM trust flags only).
// - lifecycleState CONTACTED is gated: it may only be entered through the
//   explicit gated transition (approved-contact future mechanism). Client
//   messages never mutate privileged lifecycle state.
// - Deterministic security signals always win over any advisory classifier.
// ============================================================================

import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------

export const PROSPECT_LIFECYCLE_STATES = [
  'NEW',
  'UNVERIFIED',
  'QUALIFIED',
  'CONTACTED',
  'CLIENT',
  'LOST',
  'BLOCKED',
] as const;

export type ProspectLifecycleState = (typeof PROSPECT_LIFECYCLE_STATES)[number];

export function isProspectLifecycleState(value: unknown): value is ProspectLifecycleState {
  return typeof value === 'string' && (PROSPECT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Risk states
// ---------------------------------------------------------------------------

export const PROSPECT_RISK_STATES = [
  'NEW',
  'UNVERIFIED',
  'LOW_RISK',
  'NORMAL',
  'REVIEW_REQUIRED',
  'PAYMENT_REQUIRED',
  'PAYMENT_VERIFIED',
  'HIGH_RISK',
  'BLOCKED',
] as const;

export type ProspectRiskState = (typeof PROSPECT_RISK_STATES)[number];

export function isProspectRiskState(value: unknown): value is ProspectRiskState {
  return typeof value === 'string' && (PROSPECT_RISK_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Provenance sources
// ---------------------------------------------------------------------------

export const PROSPECT_SOURCES = ['DISCOVERY_PROVIDER', 'INBOUND', 'REFERRAL', 'MANUAL'] as const;

export type ProspectSource = (typeof PROSPECT_SOURCES)[number];

export function isProspectSource(value: unknown): value is ProspectSource {
  return typeof value === 'string' && (PROSPECT_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Payment verification sources (Phase 11.0 §5). Phase 11.1 implements the
// constants + the invariant; the actual verification flows stay in later
// phases. A client message is NOT a verification source.
// ---------------------------------------------------------------------------

export const PAYMENT_VERIFICATION_SOURCES = ['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED'] as const;

export type PaymentVerificationSource = (typeof PAYMENT_VERIFICATION_SOURCES)[number];

export function isPaymentVerificationSource(value: unknown): value is PaymentVerificationSource {
  return typeof value === 'string' && (PAYMENT_VERIFICATION_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Lifecycle transitions — explicit, explainable, deny-by-default
// ---------------------------------------------------------------------------

/**
 * Allowed lifecycle transitions. CONTACTED is intentionally NOT reachable
 * from NEW/UNVERIFIED here: approved first contact is a future, human-gated
 * outreach mechanism (Phase 11.1 sends nothing). BLOCKED is admin-only in
 * the service layer; LOST covers graceful exits.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<ProspectLifecycleState, readonly ProspectLifecycleState[]>> = {
  NEW: ['UNVERIFIED', 'QUALIFIED', 'LOST', 'BLOCKED'],
  UNVERIFIED: ['QUALIFIED', 'LOST', 'BLOCKED'],
  QUALIFIED: ['CONTACTED', 'LOST', 'BLOCKED'],
  CONTACTED: ['CLIENT', 'LOST', 'BLOCKED'],
  CLIENT: ['LOST', 'BLOCKED'], // no casual CLIENT → PROSPECT demotion
  LOST: ['BLOCKED'], // terminal-ish; admin may re-block
  BLOCKED: [], // terminal; only direct admin override writes leave it
};

export type LifecycleTransitionResult =
  | { ok: true; from: ProspectLifecycleState; to: ProspectLifecycleState }
  | { ok: false; from: ProspectLifecycleState; to: ProspectLifecycleState; reason: string };

/** Pure check — validates a lifecycle transition against the allow-list. */
export function canTransitionLifecycle(
  from: ProspectLifecycleState,
  to: ProspectLifecycleState,
): LifecycleTransitionResult {
  const allowed = LIFECYCLE_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true, from, to };
  return { ok: false, from, to, reason: `Transition ${from} → ${to} is not allowed.` };
}

/**
 * Gated CONTACTED entry — the ONLY way CONTACTED is reachable. Callers must
 * present an explicit approval reference (the future outreach-approval
 * mechanism). Phase 11.1 exposes this helper for the service layer and tests;
 * no route in 11.1 calls it with a client-supplied input.
 */
export function approvedContactTransition(
  from: ProspectLifecycleState,
  approvalRef: string | null | undefined,
): LifecycleTransitionResult {
  if (from !== 'QUALIFIED') {
    return { ok: false, from, to: 'CONTACTED', reason: 'CONTACTED is only reachable from QUALIFIED via approved contact.' };
  }
  if (typeof approvalRef !== 'string' || approvalRef.trim().length === 0) {
    return { ok: false, from, to: 'CONTACTED', reason: 'Approved contact requires an approval reference (human gate).' };
  }
  return { ok: true, from, to: 'CONTACTED' };
}

// ---------------------------------------------------------------------------
// Deterministic risk engine — counters → riskState, fully explainable
// ---------------------------------------------------------------------------

/** Numeric risk inputs (from Prospect counters) — pure and serializable. */
export interface RiskSignals {
  acceptedCount: number;
  paidCount: number;
  failedPaymentCount: number;
  disputeCount: number;
  chargebackCount: number;
  cancellationCount: number;
  scopeChanges: number;
  revisionOverruns: number;
  abuseFlags: number;
  injectionFlags: number;
  /** Optional context flags — deterministic inputs, never AI-derived. */
  identityComplete: boolean;
  hasChargebackHistory: boolean;
  hasHighValueRequest: boolean;
  hasUnpaidDeliveryHistory: boolean;
}

export function emptyRiskSignals(): RiskSignals {
  return {
    acceptedCount: 0,
    paidCount: 0,
    failedPaymentCount: 0,
    disputeCount: 0,
    chargebackCount: 0,
    cancellationCount: 0,
    scopeChanges: 0,
    revisionOverruns: 0,
    abuseFlags: 0,
    injectionFlags: 0,
    identityComplete: false,
    hasChargebackHistory: false,
    hasHighValueRequest: false,
    hasUnpaidDeliveryHistory: false,
  };
}

export interface RiskDecision {
  riskState: ProspectRiskState;
  /** Why: every contributing rule, so the decision is explainable. */
  reasons: string[];
}

/**
 * Deterministic, ordered risk rules (Phase 11.0 §6). The FIRST matching rule
 * wins; every rule contributes a human-readable reason. Thresholds are fixed
 * here (admin-configurable constants can come later without changing the
 * shape). Note the ordering: HIGH_RISK before REVIEW_REQUIRED before
 * identity-derived states.
 *
 * PAYMENT_VERIFIED is deliberately NOT producible by this function — it can
 * only be set by an explicit verification flow with a PaymentVerificationSource.
 */
export function evaluateRisk(signals: RiskSignals): RiskDecision {
  const reasons: string[] = [];

  if (signals.chargebackCount > 0 || signals.hasChargebackHistory) {
    reasons.push('chargeback history present');
  }
  if (signals.disputeCount >= 2) {
    reasons.push(`disputeCount=${signals.disputeCount} (>=2)`);
  }
  if (signals.injectionFlags >= 2) {
    reasons.push(`injectionFlags=${signals.injectionFlags} (>=2)`);
  }
  if (signals.hasUnpaidDeliveryHistory) {
    reasons.push('unpaid delivery history present');
  }
  if (reasons.length > 0) {
    return { riskState: 'HIGH_RISK', reasons };
  }

  if (signals.failedPaymentCount > 0) reasons.push(`failedPaymentCount=${signals.failedPaymentCount} (>0)`);
  if (signals.cancellationCount >= 2) reasons.push(`cancellationCount=${signals.cancellationCount} (>=2)`);
  if (signals.scopeChanges >= 2) reasons.push(`scopeChanges=${signals.scopeChanges} (>=2)`);
  if (signals.revisionOverruns >= 1) reasons.push(`revisionOverruns=${signals.revisionOverruns} (>=1)`);
  if (signals.abuseFlags >= 1) reasons.push(`abuseFlags=${signals.abuseFlags} (>=1)`);
  if (signals.injectionFlags === 1) reasons.push('injectionFlags=1');
  if (signals.hasHighValueRequest) reasons.push('high-value request above threshold');
  if (reasons.length > 0) {
    return { riskState: 'REVIEW_REQUIRED', reasons };
  }

  if (signals.acceptedCount >= 1 && signals.paidCount >= 1 && signals.disputeCount === 0) {
    return { riskState: 'LOW_RISK', reasons: [`acceptedCount=${signals.acceptedCount}, paidCount=${signals.paidCount}, no disputes`] };
  }
  if (signals.identityComplete) {
    return { riskState: 'NORMAL', reasons: ['identity complete, no negative signals'] };
  }
  return { riskState: 'UNVERIFIED', reasons: ['identity incomplete (email only or minimal business info)'] };
}

// ---------------------------------------------------------------------------
// Prisma row → engine input mapper (pure)
// ---------------------------------------------------------------------------

type ProspectCounters = {
  acceptedCount: number;
  paidCount: number;
  failedPaymentCount: number;
  disputeCount: number;
  chargebackCount: number;
  cancellationCount: number;
  scopeChanges: number;
  revisionOverruns: number;
  abuseFlags: number;
  injectionFlags: number;
  email: string | null;
  website: string | null;
  businessInfo: string;
};

/** Identity is "complete" with email AND (website OR non-empty businessInfo). */
export function riskSignalsFromProspect(prospect: ProspectCounters): RiskSignals {
  let businessInfoComplete = false;
  try {
    const parsed: unknown = JSON.parse(prospect.businessInfo || '{}');
    businessInfoComplete =
      typeof parsed === 'object' && parsed !== null && Object.keys(parsed as Record<string, unknown>).length > 0;
  } catch {
    businessInfoComplete = false;
  }
  return {
    acceptedCount: prospect.acceptedCount,
    paidCount: prospect.paidCount,
    failedPaymentCount: prospect.failedPaymentCount,
    disputeCount: prospect.disputeCount,
    chargebackCount: prospect.chargebackCount,
    cancellationCount: prospect.cancellationCount,
    scopeChanges: prospect.scopeChanges,
    revisionOverruns: prospect.revisionOverruns,
    abuseFlags: prospect.abuseFlags,
    injectionFlags: prospect.injectionFlags,
    identityComplete: Boolean(prospect.email) && (Boolean(prospect.website) || businessInfoComplete),
    hasChargebackHistory: prospect.chargebackCount > 0,
    hasHighValueRequest: false,
    hasUnpaidDeliveryHistory: false,
  };
}

/** Allowed explicit-set risk states via the service layer (PAYMENT_VERIFIED excluded — see gate). */
export type ExplicitRiskState = Exclude<
  ProspectRiskState,
  'PAYMENT_VERIFIED'
>;

export function isExplicitRiskState(value: unknown): value is ExplicitRiskState {
  return isProspectRiskState(value) && value !== 'PAYMENT_VERIFIED';
}

/** Bounded evidenceRefs / businessInfo writer helper (pure). */
export function boundedJsonArrayRef(refs: readonly { type: string; id: string }[]): string {
  const bounded = refs.slice(0, 50).map((r) => ({
    type: String(r.type).slice(0, 60),
    id: String(r.id).slice(0, 128),
  }));
  return JSON.stringify(bounded) as string;
}

export function boundedBusinessInfo(info: Prisma.InputJsonValue | undefined): string {
  if (info === undefined) return '{}';
  try {
    const text = JSON.stringify(info);
    return text.length > 4000 ? text.slice(0, 4000) : text;
  } catch {
    return '{}';
  }
}
