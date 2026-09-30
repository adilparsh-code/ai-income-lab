// Phase 10 — AI Operations & Income Observatory: shared types.
//
// The observatory is a READ-ONLY intelligence layer over existing records. It
// introduces no new source of truth and never writes to the tables it reads.
// Every value carries a DATA_QUALITY label so UNKNOWN is never silently
// rendered as a number (Phase 10.15).

// ---------------------------------------------------------------------------
// Data quality (Phase 10.15) — every observability value is labelled.
// ---------------------------------------------------------------------------

export const DATA_QUALITY_LABELS = ['REAL', 'DERIVED', 'ESTIMATED', 'UNKNOWN'] as const;
export type DataQuality = (typeof DATA_QUALITY_LABELS)[number];

/** A value plus its provenance label. `label: 'UNKNOWN'` must render as UNKNOWN, not 0. */
export interface QualityValue<T = number> {
  value: T | null;
  label: DataQuality;
  /** Short, secret-free description of the source of the value. */
  source: string;
}

export function qualityValue<T>(value: T | null, label: DataQuality, source: string): QualityValue<T> {
  return { value, label, source };
}

// ---------------------------------------------------------------------------
// Agent overview (Phase 10.2)
// ---------------------------------------------------------------------------

export interface AgentObservation {
  agentId: string;
  role: string;
  /** AgentHealth.state or 'UNKNOWN' when no snapshot exists. */
  healthState: string;
  governance: {
    paused: boolean;
    requiresApproval: boolean;
    budgetLimitUsd: number;
    budgetConsumedUsd: number | null; // null = no recorded cost rows → UNKNOWN
    permissionCount: number;
  };
  runs: {
    total: number;
    running: number;
    succeeded: number;
    failed: number;
    blocked: number;
    humanReview: number;
    lastActivityAt: string | null; // null = never ran
  };
  /** The most recent AgentRun, or null. */
  lastRun: AgentRunSnapshot | null;
  /** In-progress run (RUNNING/QUEUED), or null. */
  currentRun: AgentRunSnapshot | null;
  modelProvider: QualityValue<string>;
  estimatedAiCostUsd: QualityValue<number>;
  nextAction: string | null; // deterministic, from supervisor/decision data only
}

export interface AgentRunSnapshot {
  id: string;
  jobType: string;
  stage: string;
  status: string;
  correlationId: string;
  startedAt: string;
  completedAt: string | null;
  safetyVerdict: string | null;
  failureReason: string | null;
  jobId: string | null;
}

// ---------------------------------------------------------------------------
// Timeline (Phase 10.3)
// ---------------------------------------------------------------------------

export type TimelineSource =
  | 'AGENT_RUN'
  | 'JOB_RUN'
  | 'OPPORTUNITY'
  | 'PRODUCT'
  | 'PRODUCT_DEPLOYMENT'
  | 'GROWTH_EXPERIMENT'
  | 'GROWTH_DECISION'
  | 'LEARNING_ENTRY'
  | 'REVENUE'
  | 'PRODUCT_EVENT'
  | 'HUMAN_REVIEW'
  | 'SECURITY_EVENT'
  | 'HANDOFF';

export interface TimelineEntry {
  at: string;
  source: TimelineSource;
  /** Deterministic human label built from the persisted row. */
  action: string;
  entityKind: string;
  entityId: string | null;
  agentId: string | null;
  stage: string | null;
  result: string | null;
  correlationId: string | null;
  /** Audit reference: the durable row the event came from. */
  auditRef: string;
}

// ---------------------------------------------------------------------------
// Learning observatory (Phase 10.6 / 10.7)
// ---------------------------------------------------------------------------

export type LearningEpistemicState =
  | 'OBSERVED'
  | 'HYPOTHESIS'
  | 'VALIDATED'
  | 'INVALIDATED'
  | 'SUPERSEDED'
  | 'UNVERIFIED';

export interface LearningObservation {
  id: string;
  agent: string | null; // derived from linked experiment/opportunity provenance; null = UNKNOWN
  hypothesis: string;
  result: string; // raw LearningEntry.result
  epistemicState: LearningEpistemicState;
  confidence: number;
  evidenceType: string;
  metric: string;
  baselineValue: number;
  measuredValue: number;
  applicability: string;
  opportunityId: string | null;
  experimentId: string | null;
  createdAt: string;
  outcomeLink: OutcomeLink | null;
}

/** Deterministic Learning → Experiment → Product → Revenue trace (10.7). */
export interface OutcomeLink {
  chain: string[]; // e.g. ['Learning le_1', 'Experiment gx_2', 'Product pr_3', 'Revenue via 12 purchases']
  experimentId: string | null;
  productId: string | null;
  opportunityId: string | null;
  conversions: number | null;
  revenueUsd: QualityValue<number>;
  /** 'UNATTRIBUTED' when no deterministic path exists. */
  attribution: 'ATTRIBUTED' | 'UNATTRIBUTED';
}

// ---------------------------------------------------------------------------
// Income & P&L observatory (Phase 10.8)
// ---------------------------------------------------------------------------

export interface PnlBreakdownRow {
  key: string;
  grossRevenueUsd: number;
  feesUsd: number;
  advertisingCostUsd: number;
  otherCostsUsd: number;
  netRevenueUsd: number;
  /** Number of Revenue rows behind this row (evidence of data, not padding). */
  entries: number;
}

export interface PnlObservatory {
  totals: {
    grossRevenueUsd: QualityValue<number>;
    totalCostUsd: QualityValue<number>;
    netContributionUsd: QualityValue<number>;
    aiCostUsd: QualityValue<number>;
    margin: QualityValue<number>; // fraction 0..1; null when grossRevenue = 0
    roi: QualityValue<number>; // null when totalCost = 0
  };
  byProduct: PnlBreakdownRow[];
  byOpportunity: PnlBreakdownRow[];
  byBusinessModel: PnlBreakdownRow[];
  bySource: PnlBreakdownRow[];
  byMonth: PnlBreakdownRow[];
  aiCostByAgent: { agentType: string; estimatedCostUsd: number; entries: number }[];
  /** Revenue rows without a product/opportunity link — shown, never folded into "by X". */
  unallocatedRevenueUsd: number;
  unallocatedEntries: number;
}

// ---------------------------------------------------------------------------
// Halal / safety map (Phase 10.9)
// ---------------------------------------------------------------------------

export interface HalalMap {
  opportunities: { allowed: number; reviewRequired: number; blocked: number };
  products: { allowed: number; reviewRequired: number; blocked: number };
  revenue: {
    allowedUsd: number | null;
    reviewRequiredUsd: number | null;
    blockedUsd: number | null;
    unknownUsd: number; // rows whose screening status cannot be determined
  };
  /** Producer assertions never override these receiver-side verdicts. */
  note: string;
}

// ---------------------------------------------------------------------------
// Integration health (Phase 10.10)
// ---------------------------------------------------------------------------

export interface IntegrationHealth {
  name: string;
  state: 'CONNECTED' | 'AVAILABLE' | 'NOT_CONNECTED' | 'NOT_CONFIGURED' | 'DEGRADED' | 'ERROR' | 'DISABLED';
  detail: string;
  /** Deterministic next step to reach CONNECTED, when applicable. */
  requiredForConnected: string[];
}

// ---------------------------------------------------------------------------
// Phase 10.4 — Publishing rows + Phase 10.5 — customer interactions
// ---------------------------------------------------------------------------

export interface PublishingRow {
  productId: string;
  productName: string;
  status: string;
  /** Derived from the parent opportunity's screened status; 'UNKNOWN' when unlinkable. */
  halalStatus: string;
  destination: string | null;
  publishState: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  lastDeploymentAt: string | null;
  deploymentErrors: string[];
  traffic: { visitors: number; purchases: number };
  attributedRevenueUsd: number | null;
  revenueQuality: 'REAL' | 'UNKNOWN';
}

export interface CustomerInteractionView {
  state: 'NOT_CONNECTED';
  detail: string;
  interactions: [];
  requiredForConnected: string[];
}

// ---------------------------------------------------------------------------
// Phase 10.11 — GitHub watcher
// ---------------------------------------------------------------------------

export interface GitHubWatcherView {
  state: 'NOT_CONNECTED' | 'AVAILABLE';
  detail: string;
  commits: unknown[];
  pullRequests: unknown[];
  ciRuns: unknown[];
  governance: {
    readOnly: true;
    mutationPolicy: string;
    humanApprovalRequiredFor: string[];
  };
}

// ---------------------------------------------------------------------------
// Executive "now" view (Phase 10.12) + next actions (Phase 10.13)
// ---------------------------------------------------------------------------

export interface ExecutiveNow {
  active: { agentId: string; jobType: string; stage: string; correlationId: string; startedAt: string }[];
  research: { label: string; detail: string; entityRef: string | null }[];
  build: { label: string; detail: string; entityRef: string | null }[];
  publish: { label: string; detail: string; state: string; entityRef: string | null }[];
  traffic: { source: string; visitors: number; label: string; quality: DataQuality }[];
  conversion: { label: string; conversions: number; quality: DataQuality; entityRef: string | null }[];
  revenue: { label: string; amountUsd: number; quality: DataQuality; entityRef: string | null }[];
  learning: { label: string; epistemicState: LearningEpistemicState; confidence: number; ref: string }[];
  risks: { severity: 'HIGH' | 'MEDIUM'; label: string; ref: string | null }[];
  next: { label: string; reason: string; ref: string | null; humanApprovalRequired: boolean };
}

export interface NextAction {
  priority: number; // lower = earlier
  category: string;
  label: string;
  reason: string;
  ref: string | null;
  humanApprovalRequired: boolean;
}

export interface NextActionsView {
  generatedAt: string;
  actions: NextAction[];
  paused: boolean;
}

// ---------------------------------------------------------------------------
// GitHub watcher (Phase 10.11)
// ---------------------------------------------------------------------------

export interface GitHubWatcherView {
  state: 'NOT_CONNECTED' | 'AVAILABLE';
  detail: string;
  /** Always empty while NOT_CONNECTED — never fabricated. */
  commits: unknown[];
  pullRequests: unknown[];
  ciRuns: unknown[];
  governance: {
    readOnly: true;
    mutationPolicy: string;
    humanApprovalRequiredFor: string[];
  };
}
