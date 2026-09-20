// Phase 4.5.3 — Deterministic Intelligent Routing.
//
// Answers, deterministically and before any AI call: WHAT should happen next,
// WHICH agent should execute, WHAT context it needs, and WHETHER AI is
// necessary at all. Business Manager consumes this to pick its next-best
// action; the job layer can use it to choose what to run next.
//
// Safety: routing NEVER bypasses halal gates. A NOT_ALLOWED opportunity
// routes to BLOCKED (no agent, no AI); REVIEW_REQUIRED routes to
// HUMAN_REVIEW. Routing is a pure function of recorded state.

import type { AgentType } from './types';

// ---------------------------------------------------------------------------
// Routing outputs
// ---------------------------------------------------------------------------

export type RouteAction =
  | 'RESEARCH'
  | 'VALIDATE'
  | 'BUILD_PRODUCT'
  | 'CONNECT_PUBLISHING'
  | 'RUN_EXPERIMENT'
  | 'ANALYZE'
  | 'REVIEW_REVENUE'
  | 'COLLECT_DATA'
  | 'HUMAN_REVIEW'
  | 'NO_ACTION'
  | 'BLOCKED';

export interface RouteContextNeed {
  agent: AgentType;
  /** Handoff/coordination context the target agent should receive. */
  contextNeeds: ('research_context' | 'validation_context' | 'verified_data' | 'user_entered_data' | 'ai_inference' | 'business_data')[];
  rationale: string;
}

export interface RoutingDecision {
  action: RouteAction;
  agent: AgentType | null;
  contextNeeds: RouteContextNeed['contextNeeds'];
  rationale: string;
  /** DEGRADED/BUDGET_LIMIT force deterministic paths. */
  executionMode: 'NORMAL' | 'DEGRADED' | 'BUDGET_LIMIT';
  /** Human review explicitly required by routing (halal or policy). */
  humanReviewRequired: boolean;
  /** Whether the routed action needs AI at all (deterministic alternatives). */
  requiresAi: boolean;
}

export interface RoutingOpportunityState {
  opportunityId: string | null;
  halalStatus: string;
  status: string;
  hasResearchLog: boolean;
  hasValidationData: boolean;
  hasCompletedExperiment: boolean;
  hasPositiveExperiment: boolean;
  hasProduct: boolean;
  /** Status of this opportunity's most-advanced product (null when none).
   *  Phase B: 'READY_TO_DEPLOY' means the product pipeline completed
   *  (READY_FOR_PUBLISHING) and the honest next step is the publishing
   *  capability, which is NOT_CONFIGURED until a provider is connected. */
  productStatus: string | null;
  hasPublishedProduct: boolean;
  hasRevenue: boolean;
  netRevenue: number;
  contributionProfit: number;
  revenueHealth: 'NO_DATA' | 'NON_POSITIVE_NET' | 'UNPROFITABLE' | 'PROFITABLE';
}

export interface RoutingBudgetState {
  /** Remaining AI operating budget (USD) after today's estimated spend. */
  remainingDailyBudgetUsd: number | null; // null = unlimited
  /** True when the efficiency layer reports budget exhaustion. */
  budgetExhausted: boolean;
}

/**
 * The deterministic core of the business loop:
 *   NEW OPPORTUNITY → RESEARCH → VALIDATION → PRODUCT → EXPERIMENT →
 *   ANALYTICS → BUSINESS MANAGER → next best action.
 *
 * Non-linear reality is respected: underperformance/pause states, missing
 * data, and budget/halal gates can all divert the chain at any point.
 */
export function determineNextAction(
  state: RoutingOpportunityState,
  budget: RoutingBudgetState = { remainingDailyBudgetUsd: null, budgetExhausted: false },
): RoutingDecision {
  const blocked = state.halalStatus === 'NOT_ALLOWED';
  const review = state.halalStatus === 'REVIEW_REQUIRED';

  // HARD SAFETY GATES (never bypassed by anything below).
  if (blocked) {
    return {
      action: 'BLOCKED',
      agent: null,
      contextNeeds: [],
      rationale: 'Opportunity halalStatus is NOT_ALLOWED. No agent, no AI call, no autonomous execution.',
      executionMode: 'NORMAL',
      humanReviewRequired: false,
      requiresAi: false,
    };
  }
  if (review) {
    return {
      action: 'HUMAN_REVIEW',
      agent: null,
      contextNeeds: [],
      rationale: 'Opportunity halalStatus is REVIEW_REQUIRED. A qualified human must review before any execution.',
      executionMode: 'NORMAL',
      humanReviewRequired: true,
      requiresAi: false,
    };
  }

  const executionMode: RoutingDecision['executionMode'] = budget.budgetExhausted
    ? 'BUDGET_LIMIT'
    : 'NORMAL';

  // Lifecycle routing (first match wins).
  if (!state.hasResearchLog && !state.hasValidationData && !state.hasProduct) {
    return {
      action: 'RESEARCH',
      agent: 'research',
      contextNeeds: ['user_entered_data'],
      rationale: 'No research, validation, or product evidence exists; the loop starts at research.',
      executionMode,
      humanReviewRequired: false,
      requiresAi: true,
    };
  }

  if (!state.hasValidationData) {
    return {
      action: 'VALIDATE',
      agent: 'validation',
      contextNeeds: ['research_context', 'user_entered_data'],
      rationale: 'Research exists but validation data does not; validation consumes the research handoff.',
      executionMode,
      humanReviewRequired: false,
      requiresAi: true,
    };
  }

  if (!state.hasProduct) {
    return {
      action: 'BUILD_PRODUCT',
      agent: 'product',
      contextNeeds: ['research_context', 'validation_context', 'verified_data', 'user_entered_data'],
      rationale: 'Validation is promising enough to proceed; product consumes research + validation context and verified data.',
      executionMode,
      humanReviewRequired: false,
      requiresAi: true,
    };
  }

  // Phase B: a product that finished the creation pipeline is READY_FOR_
  // PUBLISHING (spec record) / READY_TO_DEPLOY (guarded lifecycle). The
  // truthful next action is the publishing capability — which stays
  // NOT_CONFIGURED until an authorized provider is connected and a human
  // approves. The system never pretends external publishing is available.
  if (state.productStatus === 'READY_TO_DEPLOY') {
    return {
      action: 'CONNECT_PUBLISHING',
      agent: null,
      contextNeeds: [],
      rationale: 'The product completed the creation pipeline (specification, generation, quality gate, safety screening, landing page; READY_FOR_PUBLISHING). No publishing capability is connected (NOT_CONFIGURED); connect an authorized provider and provide explicit human approval before anything is published.',
      executionMode,
      humanReviewRequired: false,
      requiresAi: false,
    };
  }

  if (!state.hasCompletedExperiment) {
    return {
      action: 'RUN_EXPERIMENT',
      agent: 'validation',
      contextNeeds: ['validation_context', 'user_entered_data'],
      rationale: 'A product exists but no experiment reached a decision; a decisive test is required before scaling.',
      executionMode,
      humanReviewRequired: false,
      requiresAi: false,
    };
  }

  if (!state.hasRevenue) {
    return {
      action: 'COLLECT_DATA',
      agent: null,
      contextNeeds: [],
      rationale: 'Experiments completed but no revenue is recorded; collect real-world data before analysis can mean anything.',
      executionMode: executionMode === 'BUDGET_LIMIT' ? 'BUDGET_LIMIT' : 'NORMAL',
      humanReviewRequired: false,
      requiresAi: false,
    };
  }

  // Revenue exists: branch on deterministic profitability health.
  if (state.revenueHealth === 'UNPROFITABLE') {
    return {
      action: 'REVIEW_REVENUE',
      agent: 'analytics',
      contextNeeds: ['business_data'],
      rationale: 'Revenue is positive but contribution profit is not; analytics reviews unit economics before any growth action.',
      executionMode,
      humanReviewRequired: false,
      requiresAi: false,
    };
  }
  if (state.revenueHealth === 'PROFITABLE' && state.hasPublishedProduct) {
    return {
      action: 'ANALYZE',
      agent: 'analytics',
      contextNeeds: ['business_data'],
      rationale: 'Profitable revenue with published products; analytics identifies optimization and reinvestment options.',
      executionMode,
      humanReviewRequired: false,
      requiresAi: false,
    };
  }

  return {
    action: 'COLLECT_DATA',
    agent: null,
    contextNeeds: [],
    rationale: 'Business state does not match a clear growth path; collect more verified data before deciding.',
    executionMode,
    humanReviewRequired: false,
    requiresAi: false,
  };
}

// ---------------------------------------------------------------------------
// AI-necessity evaluation (deterministic fallback preference)
// ---------------------------------------------------------------------------

export interface AiNecessityInput {
  action: RouteAction;
  /** Does verified data already answer the question? */
  hasVerifiedAnswer: boolean;
  /** Is the requested output deterministic (computable without AI)? */
  isDeterministicallyComputable: boolean;
  /** Budget/efficiency layer verdict for this call. */
  budgetAllowsAi: boolean;
}

export interface AiNecessityDecision {
  useAi: boolean;
  reason: string;
  fallback: 'DETERMINISTIC' | 'SKIP' | 'PROCEED_ANYWAY';
}

/**
 * Decide whether AI is necessary. Deterministic logic wins whenever it can
 * produce the required output; AI is for judgment work only.
 */
export function evaluateAiNecessity(input: AiNecessityInput): AiNecessityDecision {
  if (input.isDeterministicallyComputable) {
    return {
      useAi: false,
      reason: 'The required output is deterministic; AI is unnecessary.',
      fallback: 'DETERMINISTIC',
    };
  }
  if (input.hasVerifiedAnswer) {
    return {
      useAi: false,
      reason: 'Verified data already answers this question; narration can be produced without new AI inference.',
      fallback: 'DETERMINISTIC',
    }
  }
  if (!input.budgetAllowsAi) {
    return {
      useAi: false,
      reason: 'Budget/efficiency policy blocks AI spend for this call; deterministic fallback applies.',
      fallback: 'SKIP',
    };
  }
  return { useAi: true, reason: 'Judgment work requires AI inference; budget allows it.', fallback: 'PROCEED_ANYWAY' };
}
