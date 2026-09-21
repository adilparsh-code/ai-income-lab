// Phase 4.5.3 — AI Cost & Efficiency Engine (pure layer).
//
// Implements the efficiency mechanisms for the intelligent AI economy WITHOUT
// duplicating the existing usage/aggregation system (src/lib/ai/usage.ts) or
// the daily-cost guard in generate.ts:
//
//   1. TOKEN BUDGETS     — per-request, per-agent, per-purpose, daily, monthly
//                          (all env-configurable, no hardcoded currency values).
//   2. DEDUPLICATION     — bounded window of recent request signatures;
//                          identical requests inside the window are prevented.
//   3. CACHING           — TTL cache of validated AI results keyed by an
//                          explicit caller-supplied cache key; hit/miss
//                          accounting. Freshness stays the caller's duty via
//                          short TTLs; a key never outlives its TTL.
//   4. CONTEXT COMPRESSION — compact, labelled context blocks so agents stop
//                          dumping entire histories into prompts.
//   5. SAVINGS ESTIMATION — deterministic estimates of avoided tokens/cost
//                          from dedup + cache hits (ESTIMATE, never billing).
//
// Everything here is process-local and in-memory by design: it optimizes AI
// spend within a running server instance and is never presented as durable
// business data. Nothing here knows about concrete providers, keys, or secrets.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EfficiencySnapshot {
  cacheHits: number;
  cacheMisses: number;
  duplicateRequestsPrevented: number;
  /** Estimated input tokens avoided by dedup. */
  dedupAvoidedInputTokens: number;
  /** Estimated USD avoided by dedup (caller-supplied price model). */
  dedupAvoidedCostUsd: number;
  /** Estimated input tokens avoided by cache hits. */
  cacheAvoidedInputTokens: number;
  /** Estimated USD avoided by cache hits. */
  cacheAvoidedCostUsd: number;
}

export interface EfficiencyTotals extends EfficiencySnapshot {
  /** Null when no cache lookups happened. */
  cacheHitRate: number | null;
  totalAvoidedTokens: number;
  totalAvoidedCostUsd: number;
}

export function emptySnapshot(): EfficiencySnapshot {
  return {
    cacheHits: 0,
    cacheMisses: 0,
    duplicateRequestsPrevented: 0,
    dedupAvoidedInputTokens: 0,
    dedupAvoidedCostUsd: 0,
    cacheAvoidedInputTokens: 0,
    cacheAvoidedCostUsd: 0,
  };
}

export function snapshotTotals(snapshot: EfficiencySnapshot): EfficiencyTotals {
  const lookups = snapshot.cacheHits + snapshot.cacheMisses;
  return {
    ...snapshot,
    cacheHitRate: lookups === 0 ? null : (snapshot.cacheHits / lookups) * 100,
    totalAvoidedTokens: snapshot.dedupAvoidedInputTokens + snapshot.cacheAvoidedInputTokens,
    totalAvoidedCostUsd:
      Math.round((snapshot.dedupAvoidedCostUsd + snapshot.cacheAvoidedCostUsd) * 1_000_000) / 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// Configuration (env-driven, safe fallbacks)
// ---------------------------------------------------------------------------

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per-request max input tokens (context compression target). Default 24k. */
export function getMaxRequestInputTokens(): number {
  return readPositiveNumber('AI_MAX_REQUEST_INPUT_TOKENS', 24000);
}

function envTokenBudget(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function budgetEnvSuffix(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Per-agent daily token budget (input+output). Null when unset. */
export function getAgentDailyTokenBudget(agent: string): number | null {
  return envTokenBudget('AI_TOKEN_BUDGET_AGENT_' + budgetEnvSuffix(agent));
}

/** Per-purpose daily token budget (input+output). Null when unset. */
export function getPurposeDailyTokenBudget(purpose: string): number | null {
  return envTokenBudget('AI_TOKEN_BUDGET_PURPOSE_' + budgetEnvSuffix(purpose));
}

/** Daily token budget across all AI calls (input+output). Null when unset. */
export function getDailyTokenBudget(): number | null {
  return envTokenBudget('AI_DAILY_TOKEN_BUDGET');
}

/** Monthly token budget (input+output). Null when unset. */
export function getMonthlyTokenBudget(): number | null {
  return envTokenBudget('AI_MONTHLY_TOKEN_BUDGET');
}

/** TTL (seconds) for cached AI results. Defaults to 900 (15 min). */
export function getCacheTtlSeconds(): number {
  return readPositiveNumber('AI_CACHE_TTL_SECONDS', 900);
}

/** Dedup window (seconds). Defaults to 60. */
export function getDedupWindowSeconds(): number {
  return readPositiveNumber('AI_DEDUP_WINDOW_SECONDS', 60);
}

// ---------------------------------------------------------------------------
// Token usage ledger (process-local, rolls over at UTC day boundaries)
// ---------------------------------------------------------------------------

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface UsageTick {
  agent: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  at: Date;
}

interface TokenLedger {
  day: string;
  totalTokens: number;
  byAgent: Map<string, number>;
  byPurpose: Map<string, number>;
}

const ledger: TokenLedger = {
  day: '',
  totalTokens: 0,
  byAgent: new Map(),
  byPurpose: new Map(),
};

function rolloverLedger(now: Date): void {
  const day = utcDayKey(now);
  if (ledger.day !== day) {
    ledger.day = day;
    ledger.totalTokens = 0;
    ledger.byAgent.clear();
    ledger.byPurpose.clear();
  }
}

/** Record tokens consumed by a completed AI call. */
export function recordTokenUsage(tick: UsageTick): void {
  rolloverLedger(tick.at);
  const tokens =
    Math.max(0, Math.floor(tick.inputTokens)) + Math.max(0, Math.floor(tick.outputTokens));
  ledger.totalTokens += tokens;
  ledger.byAgent.set(tick.agent, (ledger.byAgent.get(tick.agent) ?? 0) + tokens);
  ledger.byPurpose.set(tick.purpose, (ledger.byPurpose.get(tick.purpose) ?? 0) + tokens);
}

/** Process-local counters for observability surfaces. */
export function getTokenLedgerTotals(now: Date = new Date()): {
  day: string;
  totalTokens: number;
  byAgent: Record<string, number>;
  byPurpose: Record<string, number>;
} {
  rolloverLedger(now);
  return {
    day: ledger.day,
    totalTokens: ledger.totalTokens,
    byAgent: Object.fromEntries(ledger.byAgent),
    byPurpose: Object.fromEntries(ledger.byPurpose),
  };
}

/** Internal test seam: reset the ledger deterministically. */
export function __resetTokenLedger(): void {
  ledger.day = '';
  ledger.totalTokens = 0;
  ledger.byAgent.clear();
  ledger.byPurpose.clear();
}

export type TokenBudgetKind = 'request' | 'daily' | 'monthly' | 'agent' | 'purpose';

export interface TokenBudgetDecision {
  /** True when the call may proceed under all token budgets. */
  allowed: boolean;
  /** First budget that blocks the call, when not allowed. */
  reason: string | null;
  budgetKind: TokenBudgetKind | null;
}

/**
 * Evaluate all token budgets for a prospective call of `estimatedTotalTokens`
 * (input + output). Order: request → daily → monthly → agent → purpose
 * (first blocker wins). Never throws; unset budgets are unlimited.
 */
export function checkTokenBudgets(input: {
  estimatedTotalTokens: number;
  agent: string;
  purpose: string;
  now?: Date;
}): TokenBudgetDecision {
  const { estimatedTotalTokens, agent, purpose } = input;
  const now = input.now ?? new Date();
  const tokens = Number.isFinite(estimatedTotalTokens) && estimatedTotalTokens > 0
    ? Math.floor(estimatedTotalTokens)
    : 0;
  rolloverLedger(now);

  const requestCap = getMaxRequestInputTokens();
  if (tokens > requestCap * 1.5) {
    return {
      allowed: false,
      reason: `Request exceeds the maximum sensible size (${tokens} tokens vs ${requestCap} budget target); compress or split the context first.`,
      budgetKind: 'request',
    };
  }

  const daily = getDailyTokenBudget();
  if (daily !== null && ledger.totalTokens + tokens > daily) {
    return {
      allowed: false,
      reason: `Daily token budget reached (${ledger.totalTokens}/${daily}); use deterministic fallback where possible.`,
      budgetKind: 'daily',
    };
  }

  const monthly = getMonthlyTokenBudget();
  if (monthly !== null && ledger.totalTokens + tokens > monthly) {
    return {
      allowed: false,
      reason: 'Monthly token budget reached; AI calls paused until the budget resets.',
      budgetKind: 'monthly',
    };
  }

  const agentCap = getAgentDailyTokenBudget(agent);
  if (agentCap !== null && (ledger.byAgent.get(agent) ?? 0) + tokens > agentCap) {
    return {
      allowed: false,
      reason: `Daily token budget for agent "${agent}" reached (${ledger.byAgent.get(agent) ?? 0}/${agentCap}).`,
      budgetKind: 'agent',
    };
  }

  const purposeCap = getPurposeDailyTokenBudget(purpose);
  if (purposeCap !== null && (ledger.byPurpose.get(purpose) ?? 0) + tokens > purposeCap) {
    return {
      allowed: false,
      reason: `Daily token budget for purpose "${purpose}" reached (${ledger.byPurpose.get(purpose) ?? 0}/${purposeCap}).`,
      budgetKind: 'purpose',
    };
  }

  return { allowed: true, reason: null, budgetKind: null };
}

// ---------------------------------------------------------------------------
// Request signature + dedup window
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash — small, fast, dependency-free, deterministic. */
export function hashSignature(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic request signature over (provider, model, purpose, prompt,
 * shape-relevant options). Never contains key material — there is none here.
 */
export function buildRequestSignature(input: {
  provider: string;
  model: string;
  purpose: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
}): string {
  return hashSignature(
    JSON.stringify([
      input.provider,
      input.model,
      input.purpose,
      input.prompt,
      input.maxOutputTokens ?? null,
      input.temperature ?? null,
    ]),
  );
}

interface DedupEntry {
  signature: string;
  at: number;
  inputTokens: number;
  costUsd: number;
}

const DEDUP_MAX_ENTRIES = 500;

const dedupWindow: DedupEntry[] = [];

function pruneDedup(nowMs: number): void {
  const windowMs = getDedupWindowSeconds() * 1000;
  while (dedupWindow.length > 0 && nowMs - dedupWindow[0].at > windowMs) {
    dedupWindow.shift();
  }
  while (dedupWindow.length > DEDUP_MAX_ENTRIES) {
    dedupWindow.shift();
  }
}

export interface DedupDecision {
  duplicate: boolean;
  /** Record a completed call in the dedup window (call AFTER a real run). */
  record(signature: string, inputTokens: number, costUsd: number, now?: Date): void;
}

/**
 * Check whether an identical request already ran inside the dedup window.
 * The returned `record` closure must be invoked after a real (non-duplicate)
 * AI call completes so future identical requests are recognized.
 */
export function checkDuplicate(signature: string, now: Date = new Date()): DedupDecision {
  pruneDedup(now.getTime());
  const duplicate = dedupWindow.some((e) => e.signature === signature);
  return {
    duplicate,
    record(sig, inputTokens, costUsd, at = new Date()) {
      pruneDedup(at.getTime());
      dedupWindow.push({
        signature: sig,
        at: at.getTime(),
        inputTokens: Math.max(0, Math.floor(inputTokens)),
        costUsd: Math.max(0, costUsd),
      });
      while (dedupWindow.length > DEDUP_MAX_ENTRIES) dedupWindow.shift();
    },
  };
}

/** Account a prevented duplicate into the snapshot (pure accounting). */
export function accountDuplicatePrevented(
  snapshot: EfficiencySnapshot,
  entry: Pick<DedupEntry, 'inputTokens' | 'costUsd'>,
): void {
  snapshot.duplicateRequestsPrevented += 1;
  snapshot.dedupAvoidedInputTokens += entry.inputTokens;
  snapshot.dedupAvoidedCostUsd =
    Math.round((snapshot.dedupAvoidedCostUsd + entry.costUsd) * 1_000_000) / 1_000_000;
}

/** Internal test seam: clear the dedup window. */
export function __resetDedupWindow(): void {
  dedupWindow.length = 0;
}

// ---------------------------------------------------------------------------
// Result cache (TTL, bounded, explicit keys only)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  inputTokens: number;
  costUsd: number;
}

const CACHE_MAX_ENTRIES = 200;

const resultCache = new Map<string, CacheEntry<unknown>>();

function pruneCache(nowMs: number): void {
  for (const [key, entry] of resultCache) {
    if (entry.expiresAt <= nowMs) resultCache.delete(key);
  }
  while (resultCache.size > CACHE_MAX_ENTRIES) {
    // Delete the oldest insertion (Map preserves insertion order).
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

export interface CacheLookup<T> {
  hit: boolean;
  value: T | null;
}

/**
 * Look up a cached AI result. Only keys the caller explicitly provided are
 * ever present, so freshness semantics remain the caller's contract. Expired
 * entries are removed (never served stale).
 */
export function lookupCache<T>(cacheKey: string, now: Date = new Date()): CacheLookup<T> {
  pruneCache(now.getTime());
  const entry = resultCache.get(cacheKey) as CacheEntry<T> | undefined;
  if (!entry) return { hit: false, value: null };
  if (entry.expiresAt <= now.getTime()) {
    resultCache.delete(cacheKey);
    return { hit: false, value: null };
  }
  return { hit: true, value: entry.value };
}

/** Store a validated AI result under an explicit cache key. TTL from env. */
export function storeCache<T>(input: {
  cacheKey: string;
  value: T;
  inputTokens: number;
  costUsd: number;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  const ttlMs = getCacheTtlSeconds() * 1000;
  pruneCache(now.getTime());
  resultCache.set(input.cacheKey, {
    value: input.value,
    expiresAt: now.getTime() + ttlMs,
    inputTokens: Math.max(0, Math.floor(input.inputTokens)),
    costUsd: Math.max(0, input.costUsd),
  });
  while (resultCache.size > CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

/** Account a cache hit into the snapshot (avoids the input cost of the call). */
export function accountCacheHit<T>(
  snapshot: EfficiencySnapshot,
  entry: Pick<CacheEntry<T>, 'inputTokens' | 'costUsd'>,
): void {
  snapshot.cacheHits += 1;
  snapshot.cacheAvoidedInputTokens += entry.inputTokens;
  snapshot.cacheAvoidedCostUsd =
    Math.round((snapshot.cacheAvoidedCostUsd + entry.costUsd) * 1_000_000) / 1_000_000;
}

/** Account a cache miss (a real generation happened). */
export function accountCacheMiss(snapshot: EfficiencySnapshot): void {
  snapshot.cacheMisses += 1;
}

/** Internal test seam: clear the result cache. */
export function __resetResultCache(): void {
  resultCache.clear();
}

// ---------------------------------------------------------------------------
// Context compression
// ---------------------------------------------------------------------------

/** A single compact context item handed to the prompt builder. */
export interface ContextItem {
  label: string;
  text: string;
  /** Provenance label preserved verbatim into the compressed block. */
  evidenceType: string;
}

export interface CompressedContext {
  /** The compressed context text (labelled, bounded). */
  text: string;
  /** Original total characters supplied. */
  originalChars: number;
  compressedChars: number;
  /** Items dropped entirely (least relevant) by the budget. */
  droppedItems: number;
  truncatedItems: number;
}

/**
 * Compress a list of context items into a compact, labelled block that fits a
 * character budget (roughly 4 chars/token). Priority = order supplied (most
 * important first). Every retained item keeps its provenance label; dropped
 * and truncated items are counted and disclosed, never silently discarded.
 */
export function compressContext(
  items: ContextItem[],
  maxChars: number = getMaxRequestInputTokens() * 2,
): CompressedContext {
  const originalChars = items.reduce((s, i) => s + i.text.length, 0);
  const header = 'COMPRESSED CONTEXT (compact; provenance labels preserved):\n';
  const parts: string[] = [];
  let used = header.length;
  let dropped = 0;
  let truncated = 0;

  for (const item of items) {
    if (item.text.length === 0) {
      dropped += 1;
      continue;
    }
    const label = `[${item.evidenceType}] ${item.label}:`;
    const linePrefix = '- ' + label + ' ';
    const remaining = maxChars - used - linePrefix.length - 1;
    if (remaining <= 40) {
      dropped += 1;
      continue;
    }
    let text = item.text.trim();
    if (text.length > remaining) {
      text = text.slice(0, remaining - 3).trimEnd() + '…';
      truncated += 1;
    }
    const line = linePrefix + text;
    parts.push(line);
    used += line.length + 1;
  }

  return {
    text: header + parts.join('\n'),
    originalChars,
    compressedChars: used,
    droppedItems: dropped,
    truncatedItems: truncated,
  };
}

/** Rough token estimate for a compressed block (~4 chars/token, min 1). */
export function estimateCompressedTokens(block: CompressedContext): number {
  if (block.compressedChars <= 0) return 0;
  return Math.max(1, Math.ceil(block.compressedChars / 4));
}
