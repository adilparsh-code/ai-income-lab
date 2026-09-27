// Phase 9 — Growth & Optimization Engine public surface.
//
// Re-exports the deterministic building blocks so API routes and the business
// manager consume one coherent module. Nothing here executes jobs directly;
// execution always flows through the Job Runner via experiments.ts.

export * from './types';
export { computeHealth, computePortfolioScore } from './health';
export {
  canSpend,
  isExpired,
  validateExperimentRequest,
  BUDGET_LIMITS,
} from './budget';
export {
  attributeChannels,
  attributeExperiment,
  computeFunnelAnalytics,
  evaluateExperiment,
} from './attribution';
export { completionVerdict, decideLifecycle, nextAttempt } from './lifecycle';
export { decideGrowth } from './decision-engine';
export { recommendReinvestment, validateAllocation } from './reinvestment';
export {
  createGrowthExperiment,
  advanceGrowthExperiment,
  finalizeGrowthExperiment,
  listGrowthExperiments,
} from './experiments';
export { listGrowthDecisions, recordGrowthDecision } from './decisions';
export { recallLearnings, recordLearning, validateLearningInput } from './learning';
export {
  evaluatePortfolio,
  evaluatePortfolioItem,
  getGrowthDashboardView,
  listActiveExperiments,
} from './portfolio';
export { MAX_TICKS_PER_CALL, tickGrowthLoop, tickPortfolioGrowth } from './optimizer';
