// Server-only AI generation orchestration.
// Phase 4.2.1: foundation. Phase 4.2.2: real Gemini adapter wired in.
// Default behavior is safe: AI_PROVIDER=mock resolves a deterministic in-process
// provider, so no API key or network is required. Setting AI_PROVIDER=gemini
// with a valid AI_PROVIDER_API_KEY resolves the Gemini adapter; openai is still
// NOT implemented and is an explicit config error — never a silent mock fallback.
//
// Provenance rule: everything produced here is AI_INFERENCE. Callers must never
// classify it as VERIFIED_DATA.

import { requireEnv } from '@/lib/config';
import { logger } from '@/lib/server-log';
import {
  AiErrorCategory,
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderId,
  classifyGenericError,
  isRealProvider,
  resolveProviderId,
} from './provider';
import { clampMaxOutputTokens, clampTemperature, estimateCostUsd, estimateTokens, getDailyBudgetUsd } from './models';
import { buildGeminiProvider } from './gemini';
import { parseAndValidate } from './schemas';

export type { AiGenerateOptions, AiGenerateResult };
export { estimateTokens } from './models';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getTimeoutMs(): number {
  return readPositiveInt('AI_TIMEOUT_MS', 25000);
}

export function getMaxRetries(): number {
  return Math.min(5, readPositiveInt('AI_MAX_RETRIES', 2));
}

/** Deterministic in-process mock provider. No key, no network. */
class MockProvider implements AiProvider {
  readonly id: AiProviderId = 'mock';

  async generate(prompt: string, opts: AiGenerateOptions): Promise<AiGenerateResult> {
    const started = Date.now();
    const document = {
      mock: true,
      purpose: opts.purpose,
      note: 'Mock provider output. Deterministic placeholder for Phase 4.2.1.',
    };
    const text = JSON.stringify(document);
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(text);
    return {
      text,
      parsed: document,
      inputTokens,
      outputTokens,
      model: opts.model,
      provider: 'mock',
      latencyMs: Date.now() - started,
    };
  }
}

const mockProvider = new MockProvider();

/**
 * Resolve the configured provider. Mock works with no key. Real provider ids
 * are validated explicitly: gemini requires a key and returns the adapter;
 * openai is not yet implemented (explicit error). A missing key is a loud
 * configuration error — never a silent fallback to mock.
 */
export function getProvider(): AiProvider {
  const id = resolveProviderId();
  if (id === 'mock') return mockProvider;
  if (id === 'gemini') {
    const apiKey = requireEnv('AI_PROVIDER_API_KEY');
    return buildGeminiProvider(apiKey);
  }
  if (id === 'openai') {
    requireEnv('AI_PROVIDER_API_KEY');
    throw new Error(
      `AI provider "openai" is not enabled yet. Only "mock" and "gemini" are implemented in this phase. ` +
        `Set AI_PROVIDER to "mock" or "gemini" (or set the fallback).`
    );
  }
  throw new Error(`Unknown AI provider "${id}".`);
}

/**
 * Describe how the current environment will execute AI calls, WITHOUT forcing a
 * provider construction (so it never throws on a missing key or performs I/O).
 * Used by agents to label results MOCKED vs LIVE / PLANNED.
 */
export function identifyExecutionMode(): { provider: AiProviderId; isLive: boolean; isMocked: boolean } {
  const provider = resolveProviderId();
  return {
    provider,
    isLive: isRealProvider(provider),
    isMocked: provider === 'mock',
  };
}

/** Enforce a timeout around a promise. */
async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export interface ValidatedGeneration<T> {
  ok: true;
  value: T;
  usage: { provider: string; model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number; latencyMs: number };
  fallbackUsed: boolean;
  attempts: number;
}

export interface FailedGeneration {
  ok: false;
  errors: string[];
  fallbackUsed: true;
  attempts: number;
  /** Provider-agnostic error categories observed (Phase 4.2.2). Empty when unknown. */
  categories?: AiErrorCategory[];
}

export type GenerationOutcome<T> = ValidatedGeneration<T> | FailedGeneration;

/**
 * Full orchestration: budget pre-check, timeout, retries with exponential
 * backoff, one repair attempt, schema validation, fail-closed fallback.
 * Returns metadata callers persist to AgentResult.aiUsage / AgentLog.
 */
export async function generateValidated<T extends Record<string, unknown>>(
  prompt: string,
  purpose: string,
  schema: AiGenerateOptions['jsonSchema'],
  overrides?: Partial<Pick<AiGenerateOptions, 'model' | 'maxOutputTokens' | 'temperature' | 'timeoutMs' | 'cacheKey'>>
): Promise<GenerationOutcome<T>> {
  const started = Date.now();
  const provider = getProvider();
  const timeoutMs = overrides?.timeoutMs ?? getTimeoutMs();
  const maxRetries = getMaxRetries();
  const maxOutputTokens = clampMaxOutputTokens(overrides?.maxOutputTokens ?? 1000);
  const temperature = clampTemperature(overrides?.temperature ?? 0.3);
  const model = overrides?.model ?? 'mock-default';

  // Cost/budget pre-check (estimate from prompt + expected output ceiling).
  const estimatedCost = estimateCostUsd(model, estimateTokens(prompt), maxOutputTokens);
  const budget = getDailyBudgetUsd();
  if (estimatedCost > budget) {
    return {
      ok: false,
      errors: [`Estimated cost $${estimatedCost.toFixed(6)} exceeds daily budget $${budget.toFixed(2)}. Request blocked.`],
      fallbackUsed: true,
      attempts: 0,
    };
  }

  const opts: AiGenerateOptions = { model, maxOutputTokens, temperature, timeoutMs, jsonSchema: schema, purpose };
  if (overrides?.cacheKey) opts.cacheKey = overrides.cacheKey;

  const errors: string[] = [];
  const categories: AiErrorCategory[] = [];
  const maxAttempts = maxRetries + 1;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const result = await withTimeout(provider.generate(prompt, opts), timeoutMs, `AI generation (attempt ${attempt})`);
      const validated = parseAndValidate(result.text, schema);
      if (validated.valid) {
        return {
          ok: true,
          value: validated.value as T,
          usage: {
            provider: result.provider,
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: estimateCostUsd(result.model, result.inputTokens, result.outputTokens),
            latencyMs: Date.now() - started,
          },
          fallbackUsed: false,
          attempts,
        };
      }
      errors.push(`Attempt ${attempt}: schema validation failed: ${validated.errors.join('; ')}`);
      categories.push('invalid_response');
    } catch (error) {
      errors.push(`Attempt ${attempt} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      categories.push(classifyGenericError(error));
    }
    if (attempt < maxAttempts) {
      await sleep(Math.min(4000, 250 * 2 ** (attempt - 1)));
    }
  }

  // One bounded repair attempt after retries are exhausted.
  try {
    const repair = await withTimeout(provider.generate(prompt, opts), timeoutMs, 'AI generation (repair attempt)');
    const revalidated = parseAndValidate(repair.text, schema);
    attempts += 1;
    if (revalidated.valid) {
      return {
        ok: true,
        value: revalidated.value as T,
        usage: {
          provider: repair.provider,
          model: repair.model,
          inputTokens: repair.inputTokens,
          outputTokens: repair.outputTokens,
          estimatedCostUsd: estimateCostUsd(repair.model, repair.inputTokens, repair.outputTokens),
          latencyMs: Date.now() - started,
        },
        fallbackUsed: false,
        attempts,
      };
    }
    errors.push(`Repair attempt: schema validation failed: ${revalidated.errors.join('; ')}`);
    categories.push('invalid_response');
  } catch (repairError) {
    errors.push(`Repair attempt failed: ${repairError instanceof Error ? repairError.message : 'unknown error'}`);
    categories.push(classifyGenericError(repairError));
  }

  // Fail closed: no partial/trusted output. Log server-side only (no secrets).
  logger.warn('AI generation failed closed after retries', { purpose, attempts });
  return { ok: false, errors, fallbackUsed: true, attempts, categories };
}
