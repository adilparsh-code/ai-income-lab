// Phase 4.5.3 — Agent Treasury (pure internal accounting layer).
//
// A BUSINESS-SAFE abstraction for an internal AI OPERATING BUDGET. This is
// NOT a bank account, wallet, or payment rail: no money moves, no financial
// integration exists, and nothing here can spend real funds. It is an
// accounting + policy model that answers:
//
//   - how much AI operating budget is allocated, spent, reserved, remaining
//   - how revenue should split (policy-configurable) between owner
//     allocation, business reserve, the AI operating budget, and growth
//     reinvestment
//   - whether a reinvestment recommendation is SUPPORTED by data and policy
//     (never automatic, never a transfer)
//
// All percentages/policies are env-configurable with conservative defaults.
// Every monetary figure in this module is an internal accounting figure in
// USD unless the caller labels otherwise. INSUFFICIENT_DATA is reported
// honestly when revenue records are absent.

// ---------------------------------------------------------------------------
// Policy configuration (env-driven, no hardcoded currency policy)
// ---------------------------------------------------------------------------

function readFraction(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw.trim().length === 0 ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

/** Fraction of net revenue allocated to the owner. Default 0.30. */
export function getOwnerAllocationRate(): number {
  return readFraction('TREASURY_OWNER_ALLOCATION_RATE', 0.3);
}

/** Fraction of net revenue held as business reserve. Default 0.50. */
export function getBusinessReserveRate(): number {
  return readFraction('TREASURY_BUSINESS_RESERVE_RATE', 0.5);
}

/** Fraction of net revenue routed to the AI operating budget. Default 0.10. */
export function getAiOperatingBudgetRate(): number {
  return readFraction('TREASURY_AI_OPERATING_BUDGET_RATE', 0.1);
}

/** Fraction of net revenue for growth reinvestment (the remainder). Default 0.10. */
export function getGrowthReinvestmentRate(): number {
  return readFraction('TREASURY_GROWTH_REINVESTMENT_RATE', 0.1);
}

/** Sanity guard: the four configured rates must sum to ~1. */
export function areTreasuryRatesConsistent(): boolean {
  const sum =
    getOwnerAllocationRate() + getBusinessReserveRate() + getAiOperatingBudgetRate() + getGrowthReinvestmentRate();
  return Math.abs(sum - 1) <= 0.001;
}

/**
 * Minimum contribution margin (0..1) required before any reinvestment
 * recommendation is allowed. Default 0.15.
 */
export function getReinvestmentMarginThreshold(): number {
  return readFraction('TREASURY_REINVESTMENT_MARGIN_THRESHOLD', 0.15);
}

// ---------------------------------------------------------------------------
// Treasury state (allocations, spend, reservations)
// ---------------------------------------------------------------------------

export interface TreasuryState {
  /** Total AI operating budget currently allocated (accounting units). */
  allocatedBudget: number;
  /** Amount actually consumed by AI usage (recorded spend). */
  spentBudget: number;
  /** Amount held for in-flight/committed work not yet spent. */
  reservedBudget: number;
  /** Amount ear-marked for reinvestment proposals (not spendable by agents). */
  reinvestmentBudget: number;
  /** Owner allocation recorded from net revenue (accounting only). */
  ownerAllocation: number;
  /** Business reserve recorded from net revenue (accounting only). */
  businessReserve: number;
}

export function emptyTreasury(): TreasuryState {
  return {
    allocatedBudget: 0,
    spentBudget: 0,
    reservedBudget: 0,
    reinvestmentBudget: 0,
    ownerAllocation: 0,
    businessReserve: 0,
  };
}

export interface TreasuryDerived {
  remainingBudget: number;
  /** Reserved + spent cannot exceed allocated; negative means corrupt state. */
  overCommitted: number;
  utilizationPercent: number | null; // null when allocatedBudget is 0
}

/** Derived views; always safe (never negative-remaining fantasy numbers). */
export function deriveTreasury(state: TreasuryState): TreasuryDerived {
  const remainingBudget = Math.max(0, state.allocatedBudget - state.spentBudget - state.reservedBudget);
  const committed = state.spentBudget + state.reservedBudget;
  const overCommitted = Math.max(0, committed - state.allocatedBudget);
  const utilizationPercent =
    state.allocatedBudget > 0 ? Math.round((state.spentBudget / state.allocatedBudget) * 10000) / 100 : null;
  return { remainingBudget, overCommitted, utilizationPercent };
}

export type ReserveResult =
  | { ok: true; remainingBudget: number }
  | { ok: false; reason: string; remainingBudget: number };

/** Reserve part of the remaining budget (e.g. for a planned workflow). */
export function reserveBudget(state: TreasuryState, amount: number): ReserveResult {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const { remainingBudget } = deriveTreasury(state);
  if (safeAmount === 0) {
    return { ok: false, reason: 'Reservation amount must be positive.', remainingBudget };
  }
  if (safeAmount > remainingBudget) {
    return {
      ok: false,
      reason: `Insufficient budget: requested $${safeAmount.toFixed(2)} but only $${remainingBudget.toFixed(2)} remains unreserved.`,
      remainingBudget,
    };
  }
  state.reservedBudget += safeAmount;
  return { ok: true, remainingBudget: deriveTreasury(state).remainingBudget };
}

/** Convert a reservation into recorded spend (after the work completed). */
export function commitReservation(state: TreasuryState, amount: number): ReserveResult {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  if (safeAmount === 0) {
    return { ok: false, reason: 'Commit amount must be positive.', remainingBudget: deriveTreasury(state).remainingBudget };
  }
  if (safeAmount > state.reservedBudget) {
    return {
      ok: false,
      reason: `Commit amount $${safeAmount.toFixed(2)} exceeds the reserved amount $${state.reservedBudget.toFixed(2)}.`,
      remainingBudget: deriveTreasury(state).remainingBudget,
    };
  }
  state.reservedBudget -= safeAmount;
  state.spentBudget += safeAmount;
  return { ok: true, remainingBudget: deriveTreasury(state).remainingBudget };
}

/** Release a reservation without spending (work cancelled/failed). */
export function releaseReservation(state: TreasuryState, amount: number): ReserveResult {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  if (safeAmount === 0) {
    return { ok: false, reason: 'Release amount must be positive.', remainingBudget: deriveTreasury(state).remainingBudget };
  }
  if (safeAmount > state.reservedBudget) {
    return {
      ok: false,
      reason: `Release amount $${safeAmount.toFixed(2)} exceeds the reserved amount $${state.reservedBudget.toFixed(2)}.`,
      remainingBudget: deriveTreasury(state).remainingBudget,
    };
  }
  state.reservedBudget -= safeAmount;
  return { ok: true, remainingBudget: deriveTreasury(state).remainingBudget };
}

/** Record AI spend directly (from estimated AgentLog cost, never billing). */
export function recordSpend(state: TreasuryState, amount: number): ReserveResult {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  if (safeAmount === 0) {
    return { ok: false, reason: 'Spend amount must be positive.', remainingBudget: deriveTreasury(state).remainingBudget };
  }
  state.spentBudget += safeAmount;
  return { ok: true, remainingBudget: deriveTreasury(state).remainingBudget };
}

// ---------------------------------------------------------------------------
// Revenue waterfall (policy-configurable; accounting only — never transfers)
// ---------------------------------------------------------------------------

export interface RevenueInput {
  /** Gross recorded revenue for the period. */
  grossRevenue: number;
  /** Operating cost for the period (fees + advertising + other + AI cost). */
  operatingCost: number;
}

export interface RevenueWaterfall {
  grossRevenue: number;
  operatingCost: number;
  netRevenue: number;
  ownerAllocation: number;
  businessReserve: number;
  aiOperatingBudget: number;
  growthReinvestment: number;
  /** Rates actually applied (for transparent display). */
  ratesApplied: {
    owner: number;
    reserve: number;
    aiOperating: number;
    growth: number;
  };
  /** 'INSUFFICIENT_DATA' when no usable revenue input exists. */
  dataStatus: 'OK' | 'INSUFFICIENT_DATA';
}

/**
 * Split net revenue across the four policy buckets. Deterministic accounting
 * math — it moves numbers, never money. With INSUFFICIENT_DATA (no revenue)
 * all buckets are 0 and the status says so honestly.
 */
export function computeRevenueWaterfall(input: RevenueInput): RevenueWaterfall {
  const gross = Number.isFinite(input.grossRevenue) && input.grossRevenue > 0 ? input.grossRevenue : 0;
  const cost = Number.isFinite(input.operatingCost) && input.operatingCost >= 0 ? input.operatingCost : 0;
  if (gross <= 0) {
    return {
      grossRevenue: 0,
      operatingCost: 0,
      netRevenue: 0,
      ownerAllocation: 0,
      businessReserve: 0,
      aiOperatingBudget: 0,
      growthReinvestment: 0,
      ratesApplied: {
        owner: getOwnerAllocationRate(),
        reserve: getBusinessReserveRate(),
        aiOperating: getAiOperatingBudgetRate(),
        growth: getGrowthReinvestmentRate(),
      },
      dataStatus: 'INSUFFICIENT_DATA',
    };
  }

  const netRevenue = Math.max(0, gross - cost);
  const owner = round2(netRevenue * getOwnerAllocationRate());
  const reserve = round2(netRevenue * getBusinessReserveRate());
  const aiOperating = round2(netRevenue * getAiOperatingBudgetRate());
  const growth = round2(Math.max(0, netRevenue - owner - reserve - aiOperating));

  return {
    grossRevenue: round2(gross),
    operatingCost: round2(cost),
    netRevenue: round2(netRevenue),
    ownerAllocation: owner,
    businessReserve: reserve,
    aiOperatingBudget: aiOperating,
    growthReinvestment: growth,
    ratesApplied: {
      owner: getOwnerAllocationRate(),
      reserve: getBusinessReserveRate(),
      aiOperating: getAiOperatingBudgetRate(),
      growth: getGrowthReinvestmentRate(),
    },
    dataStatus: 'OK',
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Reinvestment recommendation (policy + data gated; never automatic)
// ---------------------------------------------------------------------------

export type ReinvestmentArea =
  | 'AI_MODEL_CAPACITY'
  | 'PRODUCT_IMPROVEMENT'
  | 'NEW_PRODUCT'
  | 'RESEARCH'
  | 'TRAFFIC_ACQUISITION'
  | 'PUBLISHING_INFRASTRUCTURE'
  | 'AUTOMATION';

export interface ReinvestmentEvidenceInput {
  /** Contribution margin percent (0..1) from the deterministic BI layer. */
  contributionMarginPercent: number | null;
  /** Total recorded net revenue across the business. */
  netRevenue: number;
  /** Recorded experiment outcomes: profitable ones matter here. */
  experiments: { id: string; revenue: number; budget: number; decision: string | null }[];
  /** Count of products with any recorded revenue. */
  productsWithRevenue: number;
  /** Count of opportunities in the pipeline (non-rejected). */
  activeOpportunityCount: number;
}

export type ReinvestmentDataStatus = 'INSUFFICIENT_DATA' | 'DATA_SUPPORTED';

export interface ReinvestmentRecommendation {
  recommend: boolean;
  dataStatus: ReinvestmentDataStatus;
  /** Suggested area(s), only when dataStatus is DATA_SUPPORTED and policy allows. */
  suggestedAreas: ReinvestmentArea[];
  rationale: string;
  /** The policy gates that evaluated, for transparent display. */
  gates: {
    marginThresholdMet: boolean;
    netRevenuePositive: boolean;
    supportingEvidence: boolean;
  };
  /** Explicit human-control statement — always true. */
  requiresHumanApproval: true;
  /** Always false in this phase: no automatic money movement exists. */
  automaticTransfer: false;
}

/**
 * Evaluate whether a reinvestment recommendation is supported. The system
 * NEVER executes a transfer: at most it recommends, gated by
 * - deterministic margin >= threshold,
 * - positive net revenue,
 * - at least one supporting signal (profitable experiment, earning product,
 *   or an active pipeline worth funding).
 */
export function evaluateReinvestment(
  evidence: ReinvestmentEvidenceInput,
): ReinvestmentRecommendation {
  const margin = evidence.contributionMarginPercent;
  const marginThresholdMet = margin !== null && Number.isFinite(margin) && margin >= getReinvestmentMarginThreshold();
  const netRevenuePositive = Number.isFinite(evidence.netRevenue) && evidence.netRevenue > 0;

  const profitableExperiment = evidence.experiments.some(
    (e) => Number.isFinite(e.revenue) && Number.isFinite(e.budget) && e.revenue > e.budget,
  );
  const supportingEvidence =
    profitableExperiment || evidence.productsWithRevenue > 0 || evidence.activeOpportunityCount > 0;

  if (!netRevenuePositive || margin === null) {
    return {
      recommend: false,
      dataStatus: 'INSUFFICIENT_DATA',
      suggestedAreas: [],
      rationale:
        'Reinvestment cannot be evaluated: net revenue is not positive or margin is unknown. Record revenue and cost data first.',
      gates: { marginThresholdMet: false, netRevenuePositive, supportingEvidence },
      requiresHumanApproval: true,
      automaticTransfer: false,
    };
  }

  if (!marginThresholdMet || !supportingEvidence) {
    const reasonBits: string[] = [];
    if (!marginThresholdMet) {
      reasonBits.push(
        `contribution margin ${(margin * 100).toFixed(1)}% is below the configured reinvestment threshold ${(getReinvestmentMarginThreshold() * 100).toFixed(1)}%`,
      );
    }
    if (!supportingEvidence) {
      reasonBits.push('no profitable experiment, earning product, or active pipeline opportunity exists to fund');
    }
    return {
      recommend: false,
      dataStatus: 'DATA_SUPPORTED',
      suggestedAreas: [],
      rationale: `Reinvestment not recommended: ${reasonBits.join('; ')}.`,
      gates: { marginThresholdMet, netRevenuePositive, supportingEvidence },
      requiresHumanApproval: true,
      automaticTransfer: false,
    };
  }

  // Policy-supported reinvestment: rank areas by the evidence available.
  const suggestedAreas: ReinvestmentArea[] = [];
  if (evidence.activeOpportunityCount > 0) suggestedAreas.push('RESEARCH');
  if (evidence.productsWithRevenue > 0) suggestedAreas.push('PRODUCT_IMPROVEMENT');
  if (profitableExperiment) suggestedAreas.push('TRAFFIC_ACQUISITION');
  suggestedAreas.push('AUTOMATION');

  return {
    recommend: true,
    dataStatus: 'DATA_SUPPORTED',
    suggestedAreas,
    rationale:
      `Reinvestment is policy-supported: contribution margin ${(margin * 100).toFixed(1)}% meets the threshold, ` +
      `net revenue is $${evidence.netRevenue.toFixed(2)}, and supporting signals exist ` +
      `(profitable experiment: ${profitableExperiment ? 'yes' : 'no'}, products with revenue: ${evidence.productsWithRevenue}, ` +
      `active opportunities: ${evidence.activeOpportunityCount}). This is a RECOMMENDATION ONLY — ` +
      'a human must approve any actual spend, and no automatic transfer exists.',
    gates: { marginThresholdMet, netRevenuePositive, supportingEvidence },
    requiresHumanApproval: true,
    automaticTransfer: false,
  };
}
