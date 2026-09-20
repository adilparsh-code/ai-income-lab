// Phase 6 — Intelligent decision core (pure functions over AgentContext).
//
// Consumes the previously dormant deterministic layers on REAL production
// paths:
//   - intelligent-routing.determineNextAction  (WHAT next / WHO / WHY)
//   - coordination.assessConflict              (agent disagreement handling)
//   - evidence-strength classification         (via AgentContext)
//
// Safety invariants (unchanged):
//   - NOT_ALLOWED routes to BLOCKED before anything else; no agent, no AI.
//   - REVIEW_REQUIRED routes to HUMAN_REVIEW; no autonomous approval.
//   - Recorded data (VERIFIED_DATA) outranks AI inference in conflicts.
//   - The deterministic decision tree stays authoritative; AI never overrides.

import { determineNextAction, type RoutingDecision, type RoutingOpportunityState } from './intelligent-routing';
import { assessConflict, type AgentPosition, type ConflictAssessment } from './coordination';
import type { AgentContext } from './agent-context';

// ---------------------------------------------------------------------------
// Routing state derived from real context
// ---------------------------------------------------------------------------

/**
 * Map an assembled AgentContext onto the existing deterministic router's
 * input. Everything is copied from records; nothing is guessed. Halal status
 * is passed through untouched so the router's hard gates stay authoritative.
 */
export function routingStateFromContext(ctx: AgentContext): RoutingOpportunityState {
  const opp = ctx.opportunity;
  const hasProduct = ctx.product.statuses.length > 0;
  const hasPublishedProduct = ctx.product.statuses.some((p) =>
    ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status),
  );
  // Phase B: the most-advanced product status drives the post-build routing
  // gate (READY_TO_DEPLOY = creation pipeline finished → CONNECT_PUBLISHING).
  const productStatus = ctx.product.statuses.find((p) => p.status === 'READY_TO_DEPLOY')?.status
    ?? ctx.product.statuses[0]?.status
    ?? null;
  const netRevenue = ctx.revenue.netTotal;
  const hasRevenue = ctx.revenue.recordCount > 0;
  const contributionProfit = netRevenue > 0 ? netRevenue : 0;

  const revenueHealth: RoutingOpportunityState['revenueHealth'] = !hasRevenue
    ? 'NO_DATA'
    : netRevenue <= 0
      ? 'NON_POSITIVE_NET'
      : 'PROFITABLE';

  return {
    opportunityId: opp?.id ?? null,
    halalStatus: opp?.halalStatus ?? 'HALAL',
    status: opp?.status ?? 'UNKNOWN',
    hasResearchLog: ctx.research.sourceRef !== null,
    hasValidationData: ctx.validation.sourceRef !== null || ctx.experiments.total > 0,
    hasCompletedExperiment: ctx.experiments.completedDecisions.some((d) => ['SCALE', 'KILL'].includes(d)),
    hasPositiveExperiment: ctx.experiments.positiveDecisions > 0,
    hasProduct,
    productStatus,
    hasPublishedProduct,
    hasRevenue,
    netRevenue,
    contributionProfit,
    revenueHealth,
  };
}

export interface IntelligenceView {
  routing: RoutingDecision;
  conflicts: ConflictAssessment;
  /** One-line deterministic answer to "what should happen next and why". */
  nextStep: {
    action: RoutingDecision['action'];
    agent: RoutingDecision['agent'];
    reason: string;
    humanApprovalRequired: boolean;
    requiresAi: boolean;
  };
}

/**
 * Build the full deterministic intelligence view for an opportunity context.
 * Agent positions come from RECORDED slices only:
 *   research  → PROMISING / NEEDS_VALIDATION / WEAK_SIGNAL (from recommendation)
 *   validation→ same scale from its stored recommendation
 *   analytics → PROVEN / POOR_RESULTS from recorded revenue health
 *   business-manager → BLOCKED only when the DB halal status says so.
 */
export function buildIntelligenceView(ctx: AgentContext): IntelligenceView {
  const state = routingStateFromContext(ctx);
  const routing = determineNextAction(state);

  const positions: AgentPosition[] = [];
  const now = ctx.assembledAt;

  const researchRec = /PROMISING/.test(ctx.research.summary)
    ? 'PROMISING'
    : /WEAK_SIGNAL/.test(ctx.research.summary)
      ? 'WEAK_SIGNAL'
      : null;
  if (ctx.research.sourceRef && researchRec) {
    positions.push({ agent: 'research', signal: researchRec, evidenceType: ctx.research.evidenceType, collectedAt: ctx.research.recordedAt ?? now });
  }

  const validationRec = /PROMISING/.test(ctx.validation.summary)
    ? 'PROMISING'
    : /WEAK_SIGNAL/.test(ctx.validation.summary)
      ? 'WEAK_SIGNAL'
      : /NEEDS_VALIDATION/.test(ctx.validation.summary)
        ? 'NEEDS_VALIDATION'
        : null;
  if (ctx.validation.sourceRef && validationRec) {
    positions.push({ agent: 'validation', signal: validationRec, evidenceType: ctx.validation.evidenceType, collectedAt: ctx.validation.recordedAt ?? now });
  }

  if (ctx.revenue.recordCount > 0) {
    positions.push({
      agent: 'analytics',
      signal: ctx.revenue.netTotal > 0 ? 'PROVEN' : 'POOR_RESULTS',
      evidenceType: 'VERIFIED_DATA',
      collectedAt: ctx.revenue.slice.recordedAt ?? now,
    });
  } else if (ctx.experiments.total > 0) {
    positions.push({
      agent: 'analytics',
      signal: ctx.experiments.positiveDecisions > 0 ? 'PROMISING' : 'POOR_RESULTS',
      evidenceType: 'VERIFIED_DATA',
      collectedAt: ctx.experiments.slice.recordedAt ?? now,
    });
  }

  if (ctx.opportunity?.halalStatus === 'NOT_ALLOWED') {
    positions.push({ agent: 'business-manager', signal: 'BLOCKED', evidenceType: 'VERIFIED_DATA', collectedAt: now });
  }

  const conflicts = assessConflict(positions);

  // The deterministic next step wins over any agent signal. Conflicts add
  // human review when the conflict assessor demands it and the router itself
  // has not already stopped at a gate. Defense-in-depth: CONFLICTING evidence
  // strength (verified outcomes contradicting a positive outlook) always
  // forces human review, matching evidence-strength semantics.
  const conflictingStrength = ctx.evidenceStrength.strength === 'CONFLICTING';
  const humanReviewRequired =
    routing.humanReviewRequired ||
    (conflicts.safeAction === 'REQUEST_HUMAN_REVIEW' && routing.action !== 'BLOCKED' && routing.action !== 'HUMAN_REVIEW') ||
    (conflictingStrength && routing.action !== 'BLOCKED');

  const reason = humanReviewRequired && !routing.humanReviewRequired
    ? `${routing.rationale} ${conflicts.resolutionReason ?? ''}`.trim()
    : routing.rationale;

  // Advancement guard: when a conflict was resolved in favor of a NEGATIVE
  // verified position (e.g. analytics reports POOR_RESULTS on recorded data),
  // the router must not advance execution (BUILD_PRODUCT). Recorded data has
  // higher authority than AI optimism, so the safe action is collecting more
  // data — never building on a losing verified signal.
  const NEGATIVE_SIGNALS = new Set(['POOR_RESULTS', 'WEAK_SIGNAL', 'NEEDS_VALIDATION']);
  const negativeVerifiedWinner =
    conflicts.hasConflict &&
    conflicts.preferredPosition !== null &&
    NEGATIVE_SIGNALS.has(conflicts.preferredPosition.signal);
  let action = humanReviewRequired && routing.action !== 'BLOCKED' ? 'HUMAN_REVIEW' : routing.action;
  let agent = humanReviewRequired && routing.action !== 'BLOCKED' ? null : routing.agent;
  if (negativeVerifiedWinner && action === 'BUILD_PRODUCT') {
    action = 'COLLECT_DATA';
    agent = null;
  }

  return {
    routing,
    conflicts,
    nextStep: {
      action,
      agent,
      reason: negativeVerifiedWinner && action === 'COLLECT_DATA'
        ? `${reason} Verified outcome data is negative; advancing to product building is not justified.`
        : reason,
      humanApprovalRequired: humanReviewRequired || routing.humanReviewRequired,
      requiresAi: routing.requiresAi,
    },
  };
}
