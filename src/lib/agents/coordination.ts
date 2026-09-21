// Phase 4.5.3 — Agent Coordination: handoff contracts + memory foundation.
//
// Compact, provenance-aware context handoffs between agents. Every handoff
// carries source agent/execution, evidence type, confidence, relevant facts,
// hypotheses, unresolved questions, and a recommended next step. Full
// database dumps and conversation histories are structurally impossible here:
// handoffs are built from bounded, labelled fields only.
//
// The memory foundation stores categorized, scoped, timestamped, compact
// memory entries with provenance. It is NOT unrestricted conversational
// memory: categories are fixed, sizes are bounded, and retrieval is filtered
// by scope and relevance.
//
// Both structures are pure: tests and callers can construct them without a
// database; persistence stays with the caller (AgentLog/PipelineRun today).

// ---------------------------------------------------------------------------
// Handoff contracts
// ---------------------------------------------------------------------------

export type HandoffEvidenceType = 'AI_INFERENCE' | 'VERIFIED_DATA' | 'USER_ENTERED' | 'SEARCH_DISCOVERY';

export interface AgentHandoff {
  /** Producing agent type, e.g. 'research'. */
  sourceAgent: string;
  /** Producing execution reference (AgentLog id / PipelineRun id). */
  sourceExecutionId: string | null;
  /** Where the producing execution can be audited. */
  sourceRef: string | null;
  /** Dominant evidence type of the handed-off content. */
  evidenceType: HandoffEvidenceType;
  /** Confidence in 0..1 when the producer reports one; null otherwise. */
  confidence: number | null;
  createdAt: string;
  /** Compact, relevant facts (bounded length each). */
  relevantFacts: string[];
  /** Working hypotheses (never stated as facts). */
  hypotheses: string[];
  /** What the producer could not resolve. */
  unresolvedQuestions: string[];
  /** Producer's recommended next step for the consumer. */
  recommendedNextStep: string | null;
}

const MAX_FACTS = 12;
const MAX_FACT_LENGTH = 300;
const MAX_QUESTIONS = 8;

/** Build a bounded, validated handoff; over-long lists are truncated honestly. */
export function buildHandoff(input: {
  sourceAgent: string;
  sourceExecutionId?: string | null;
  sourceRef?: string | null;
  evidenceType: HandoffEvidenceType;
  confidence?: number | null;
  createdAt?: string;
  relevantFacts?: string[];
  hypotheses?: string[];
  unresolvedQuestions?: string[];
  recommendedNextStep?: string | null;
}): AgentHandoff {
  const clampList = (values: string[] | undefined, max: number): string[] =>
    (values ?? [])
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().slice(0, MAX_FACT_LENGTH))
      .slice(0, max);

  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.min(1, Math.max(0, input.confidence))
      : null;

  return {
    sourceAgent: input.sourceAgent,
    sourceExecutionId: input.sourceExecutionId ?? null,
    sourceRef: input.sourceRef ?? null,
    evidenceType: input.evidenceType,
    confidence,
    createdAt: input.createdAt ?? new Date().toISOString(),
    relevantFacts: clampList(input.relevantFacts, MAX_FACTS),
    hypotheses: clampList(input.hypotheses, MAX_FACTS),
    unresolvedQuestions: clampList(input.unresolvedQuestions, MAX_QUESTIONS),
    recommendedNextStep:
      input.recommendedNextStep && input.recommendedNextStep.trim().length > 0
        ? input.recommendedNextStep.trim().slice(0, MAX_FACT_LENGTH)
        : null,
  };
}

/** Provenance ranking used for conflict resolution: verified > user > fetched > AI. */
export function evidenceRank(evidenceType: HandoffEvidenceType): number {
  switch (evidenceType) {
    case 'VERIFIED_DATA':
      return 3;
    case 'USER_ENTERED':
      return 2;
    case 'SEARCH_DISCOVERY':
      return 1;
    case 'AI_INFERENCE':
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Conflict handling
// ---------------------------------------------------------------------------

/** Deterministic signal labels an agent may report about the same entity. */
export type AgentSignal =
  | 'PROMISING'
  | 'NEEDS_VALIDATION'
  | 'WEAK_SIGNAL'
  | 'POOR_RESULTS'
  | 'PROVEN'
  | 'BLOCKED';

export interface AgentPosition {
  agent: string;
  signal: AgentSignal;
  evidenceType: HandoffEvidenceType;
  /** When the producing evidence was collected (provenance freshness). */
  collectedAt: string;
}

export interface ConflictAssessment {
  hasConflict: boolean;
  /** Human-readable conflict description, when present. */
  conflictDescription: string | null;
  /** The position chosen as the basis for the safe action, if any. */
  preferredPosition: AgentPosition | null;
  /** Why the preferred position won (provenance/freshness reasoning). */
  resolutionReason: string | null;
  /** Deterministic safe action that does NOT blindly follow positive signals. */
  safeAction: 'REQUEST_HUMAN_REVIEW' | 'CONTINUE_WITH_CAUTION' | 'PROCEED_ON_VERIFIED' | 'NO_ACTION';
  /** Signals considered, for transparent display. */
  considered: AgentPosition[];
}

/** Signals that express a positive outlook. */
const POSITIVE_SIGNALS: ReadonlySet<AgentSignal> = new Set(['PROMISING', 'PROVEN']);

/** Signals that express doubt or failure. */
const NEGATIVE_SIGNALS: ReadonlySet<AgentSignal> = new Set(['WEAK_SIGNAL', 'POOR_RESULTS', 'NEEDS_VALIDATION']);

/**
 * Assess disagreement between agent positions. Rules:
 * - A BLOCKED position always wins (safety first).
 * - Mixed positive/negative signals → conflict: prefer the position with the
 *   strongest provenance, break ties by recency, and choose a SAFE action
 *   (human review when unverified signals disagree; cautious continuation on
 *   verified evidence). AI must not override verified evidence or safety.
 * - Unanimous signals → no conflict; proceed only on verified/user evidence.
 */
export function assessConflict(positions: AgentPosition[]): ConflictAssessment {
  const considered = [...positions];
  if (considered.length === 0) {
    return {
      hasConflict: false,
      conflictDescription: null,
      preferredPosition: null,
      resolutionReason: 'No agent positions supplied; no assessment possible.',
      safeAction: 'NO_ACTION',
      considered,
    };
  }

  // Safety dominance: any BLOCKED position blocks.
  const blocked = considered.find((p) => p.signal === 'BLOCKED');
  if (blocked) {
    return {
      hasConflict: considered.length > 1,
      conflictDescription: blocked
        ? `Conflict resolved by safety dominance: ${blocked.agent} reported BLOCKED.`
        : null,
      preferredPosition: blocked,
      resolutionReason: 'Safety-dominant signal: BLOCKED overrides all other signals regardless of provenance.',
      safeAction: 'REQUEST_HUMAN_REVIEW',
      considered,
    };
  }

  const hasPositive = considered.some((p) => POSITIVE_SIGNALS.has(p.signal));
  const hasNegative = considered.some((p) => NEGATIVE_SIGNALS.has(p.signal));

  if (!(hasPositive && hasNegative)) {
    // No disagreement between positive/negative camps.
    const verified = considered.find((p) => evidenceRank(p.evidenceType) >= 2);
    return {
      hasConflict: false,
      conflictDescription: null,
      preferredPosition: verified ?? considered[0],
      resolutionReason: verified
        ? `Signals agree; verified/user-entered evidence from ${verified.agent} is preferred.`
        : 'Signals agree but no verified/user-entered evidence exists; caution applies.',
      safeAction: verified ? 'PROCEED_ON_VERIFIED' : 'CONTINUE_WITH_CAUTION',
      considered,
    };
  }

  // Genuine conflict: rank by provenance, then freshness.
  const byStrength = [...considered].sort((a, b) => {
    const rankDiff = evidenceRank(b.evidenceType) - evidenceRank(a.evidenceType);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime();
  });
  const preferred = byStrength[0];
  const verifiedPreferred = evidenceRank(preferred.evidenceType) >= 2;

  return {
    hasConflict: true,
    conflictDescription:
      `Agents disagree: ${considered.map((p) => `${p.agent}=${p.signal} (${p.evidenceType})`).join('; ')}.`,
    preferredPosition: preferred,
    resolutionReason: verifiedPreferred
      ? `Conflict present; strongest provenance (${preferred.evidenceType} from ${preferred.agent}) preferred over weaker signals.`
      : 'Conflict present but no verified/user-entered evidence exists; AI must not pick the positive signal without verification.',
    safeAction: verifiedPreferred ? 'PROCEED_ON_VERIFIED' : 'REQUEST_HUMAN_REVIEW',
    considered,
  };
}

// ---------------------------------------------------------------------------
// Memory foundation
// ---------------------------------------------------------------------------

export const MEMORY_CATEGORIES = [
  'VERIFIED_FACTS',
  'USER_ENTERED',
  'AI_INFERENCE',
  'EXPERIMENT_RESULTS',
  'BUSINESS_DECISIONS',
  'FAILED_HYPOTHESES',
  'SUCCESSFUL_PATTERNS',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  scope: string; // e.g. 'opportunity:<id>' | 'product:<id>' | 'global'
  content: string;
  evidenceType: HandoffEvidenceType;
  provenance: string; // which agent/system recorded it
  createdAt: string;
}

const MAX_MEMORY_CONTENT = 600;

/** Validate + bound a memory entry (pure; persistence is the caller's job). */
export function createMemoryEntry(input: {
  id: string;
  category: MemoryCategory;
  scope: string;
  content: string;
  evidenceType: HandoffEvidenceType;
  provenance: string;
  createdAt?: string;
}): MemoryEntry {
  return {
    id: input.id,
    category: input.category,
    scope: input.scope.slice(0, 200),
    content: input.content.trim().slice(0, MAX_MEMORY_CONTENT),
    evidenceType: input.evidenceType,
    provenance: input.provenance.slice(0, 120),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Retrieval: scope-filtered, category-filtered, most-recent-first, bounded.
 * The relevance score is deterministic (category weight + recency bucket);
 * no AI is needed to select memory. Old information is NOT re-sent wholesale —
 * callers pass the compact result into a compressed context block.
 */
export function retrieveMemory(
  entries: MemoryEntry[],
  options: {
    scope?: string;
    categories?: MemoryCategory[];
    limit?: number;
    now?: Date;
  } = {},
): MemoryEntry[] {
  const now = options.now ?? new Date();
  const scope = options.scope;
  const categories = options.categories;
  const limit = options.limit ?? 10;

  const filtered = entries.filter(
    (e) =>
      (scope === undefined || e.scope === scope) &&
      (categories === undefined || categories.includes(e.category)),
  );

  const categoryWeight = (category: MemoryCategory): number => {
    // Verified/user evidence ranks above inference for the same recency.
    switch (category) {
      case 'VERIFIED_FACTS':
        return 3;
      case 'USER_ENTERED':
        return 3;
      case 'EXPERIMENT_RESULTS':
        return 2;
      case 'BUSINESS_DECISIONS':
        return 2;
      case 'SUCCESSFUL_PATTERNS':
        return 2;
      case 'FAILED_HYPOTHESES':
        return 2;
      case 'AI_INFERENCE':
        return 1;
    }
  };

  const recencyBucket = (createdAt: string): number => {
    const ageMs = now.getTime() - new Date(createdAt).getTime();
    const ageDays = Math.max(0, ageMs / 86_400_000);
    if (ageDays <= 7) return 3;
    if (ageDays <= 30) return 2;
    if (ageDays <= 90) return 1;
    return 0;
  };

  return filtered
    .sort((a, b) => {
      const w = categoryWeight(b.category) - categoryWeight(a.category);
      if (w !== 0) return w;
      const r = recencyBucket(b.createdAt) - recencyBucket(a.createdAt);
      if (r !== 0) return r;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, limit);
}

/** Compact a memory list into context items for compressContext(). */
export function memoryToContextItems(entries: MemoryEntry[]): {
  label: string;
  text: string;
  evidenceType: string;
}[] {
  return entries.map((e) => ({
    label: `${e.category} · ${e.scope}`,
    text: e.content,
    evidenceType: e.evidenceType,
  }));
}
