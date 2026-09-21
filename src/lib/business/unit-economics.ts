/**
 * Pure business-metric helpers for the future Revenue/Profit Engine.
 *
 * This module deliberately has no database, AI, provider, or UI dependency so
 * it can be reused by dashboard analytics, Business Manager, and Ruflo workers.
 * Missing/invalid denominators return null instead of NaN or Infinity.
 */

export interface UnitEconomicsInput {
  grossRevenue: number;
  refunds?: number;
  platformFees?: number;
  paymentFees?: number;
  otherVariableCosts?: number;
}

export interface UnitEconomicsResult {
  grossRevenue: number;
  refunds: number;
  netRevenue: number;
  platformFees: number;
  paymentFees: number;
  otherVariableCosts: number;
  contributionProfit: number;
  contributionMarginPercent: number | null;
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safePercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const value = (numerator / denominator) * 100;
  return Number.isFinite(value) ? value : null;
}

/** Calculate net revenue and contribution profit without introducing NaN/Infinity. */
export function calculateUnitEconomics(input: UnitEconomicsInput): UnitEconomicsResult {
  const grossRevenue = finiteOrZero(input.grossRevenue);
  const refunds = Math.max(0, finiteOrZero(input.refunds));
  const platformFees = Math.max(0, finiteOrZero(input.platformFees));
  const paymentFees = Math.max(0, finiteOrZero(input.paymentFees));
  const otherVariableCosts = Math.max(0, finiteOrZero(input.otherVariableCosts));

  const netRevenue = grossRevenue - refunds;
  const contributionProfit =
    netRevenue - platformFees - paymentFees - otherVariableCosts;

  return {
    grossRevenue,
    refunds,
    netRevenue,
    platformFees,
    paymentFees,
    otherVariableCosts,
    contributionProfit,
    contributionMarginPercent: safePercent(contributionProfit, netRevenue),
  };
}

/** Calculate a break-even revenue target from fixed costs and a contribution margin. */
export function calculateBreakEvenRevenue(
  fixedCosts: number,
  contributionMarginPercent: number,
): number | null {
  if (!Number.isFinite(fixedCosts) || fixedCosts < 0) return null;
  if (!Number.isFinite(contributionMarginPercent) || contributionMarginPercent <= 0) {
    return null;
  }

  const result = fixedCosts / (contributionMarginPercent / 100);
  return Number.isFinite(result) ? result : null;
}

/** Calculate ROI as a percentage. Returns null when the investment base is invalid. */
export function calculateRoiPercent(
  profit: number,
  investment: number,
): number | null {
  if (!Number.isFinite(profit) || !Number.isFinite(investment) || investment <= 0) {
    return null;
  }

  const result = (profit / investment) * 100;
  return Number.isFinite(result) ? result : null;
}
