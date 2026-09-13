// Server-only model policy + price table (Phase 4.2.1 foundation).
// Pricing below is an ISOLATED ESTIMATE for budget guarding only — it is not
// billing data and makes no claim of permanent accuracy. Update per provider
// pricing pages when enabling real calls. Costs are always estimates.

import type { AgentType } from '@/lib/agents/types';
import type { AiProviderId } from './provider';

export interface ModelPolicy {
  provider: AiProviderId;
  model: string;
  maxOutputTokens: number;
  temperature: number;
}

export type AiPurpose =
  | 'research.findings'
  | 'validation.tests'
  | 'product.concept'
  | 'analytics.narrative'
  | 'business-manager.rationale';

const DEFAULT_POLICIES: Record<AiPurpose, ModelPolicy> = {
  'research.findings': { provider: 'gemini', model: 'gemini-2.5-flash', maxOutputTokens: 1500, temperature: 0.7 },
  'validation.tests': { provider: 'gemini', model: 'gemini-2.5-flash', maxOutputTokens: 1200, temperature: 0.3 },
  'product.concept': { provider: 'gemini', model: 'gemini-2.5-flash', maxOutputTokens: 2000, temperature: 0.5 },
  'analytics.narrative': { provider: 'gemini', model: 'gemini-2.5-flash', maxOutputTokens: 800, temperature: 0.2 },
  'business-manager.rationale': { provider: 'gemini', model: 'gemini-2.5-flash', maxOutputTokens: 1000, temperature: 0.2 },
};

const PURPOSE_ENV_VARS: Record<AiPurpose, string> = {
  'research.findings': 'AI_MODEL_RESEARCH',
  'validation.tests': 'AI_MODEL_VALIDATION',
  'product.concept': 'AI_MODEL_PRODUCT',
  'analytics.narrative': 'AI_MODEL_ANALYTICS_NARRATIVE',
  'business-manager.rationale': 'AI_MODEL_BM_NARRATIVE',
};

/** Per-agent default policy; model name overridable via env without code change. */
export function getModelPolicy(purpose: AiPurpose): ModelPolicy {
  const base = DEFAULT_POLICIES[purpose];
  const override = process.env[PURPOSE_ENV_VARS[purpose]];
  const model = override && override.trim().length > 0 ? override.trim() : base.model;
  return { ...base, model };
}

/** Clamp agent-friendly token limit into a safe range. */
export function clampMaxOutputTokens(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.min(4000, Math.max(100, Math.floor(value)));
}

/** Clamp temperature into [0, 1]. Non-finite input falls back to 0.3. */
export function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.3;
  return Math.min(1, Math.max(0, value));
}

interface PriceEntry {
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Estimated price table (USD per 1M tokens). Indicative planning figures for
 * Flash/mini-class models; verify against provider pricing before enabling
 * real calls. Kept isolated here so updates touch exactly one place.
 */
const PRICE_TABLE: Record<string, PriceEntry> = {
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
};

const FALLBACK_PRICE: PriceEntry = { inputPer1M: 1.0, outputPer1M: 4.0 };

/**
 * Estimate USD cost for a call. Unknown models use a conservative fallback
 * price so the budget guard never under-blocks. Returns 0 for non-finite or
 * negative token counts (defensive: never NaN/Infinity/negative).
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const safeIn = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOut = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const price = PRICE_TABLE[model] ?? FALLBACK_PRICE;
  const cost = (safeIn / 1_000_000) * price.inputPer1M + (safeOut / 1_000_000) * price.outputPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Daily spend cap in USD. Defaults to $2.00; invalid values fall back safely. */
export function getDailyBudgetUsd(): number {
  const raw = process.env.AI_DAILY_BUDGET_USD;
  const parsed = raw ? Number(raw) : 2.0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 2.0;
  return parsed;
}

/** Purpose allow-list per agent for future per-agent kill switches (4.2.2+). */
export const AGENT_PURPOSES: Record<AgentType, AiPurpose[]> = {
  research: ['research.findings'],
  validation: ['validation.tests'],
  product: ['product.concept'],
  analytics: ['analytics.narrative'],
  'business-manager': ['business-manager.rationale'],
};
