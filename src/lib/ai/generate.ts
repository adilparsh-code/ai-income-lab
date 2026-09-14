// Server-only AI generation orchestration (Phase 4.2.1 foundation).
// Default behavior is safe: AI_PROVIDER=mock resolves a deterministic in-process
// provider, so no API key or network is required. Real providers (gemini/openai)
// adapters are NOT implemented yet — requesting them is an explicit config error,
// never a silent mock fallback.
//
// Provenance rule: everything produced here is AI_INFERENCE. Callers must never
// classify it as VERIFIED_DATA.

import { requireEnv } from '@/lib/config';
import { logger } from '@/lib/server-log';
import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderId,
  isRealProvider,
  resolveProviderId,
} from './provider';
import { clampMaxOutputTokens, clampTemperature, estimateCostUsd, getDailyBudgetUsd } from './models';
import { parseAndValidate } from './schemas';

export type { AiGenerateOptions, AiGenerateResult };

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

/** Rough token estimate (~4 chars/token) for budget guarding. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

const mockProvider = new MockProvider();

/**
 * Resolve the configured provider. Mock works with no key. Real provider ids
 * are rejected until adapters land (Phase 4.2.2+); a missing key is an
 * explicit error via requireEnv — never a silent fallback to mock.
 */
export function getProvider(): AiProvider {
  const id = resolveProviderId();
  if (id === 'mock') return mockProvider;
  if (isRealProvider(id)) {
    requireEnv('AI_PROVIDER_API_KEY');
    throw new Error(
      `AI provider "${id}" is not enabled yet. Adapters land in Phase 4.2.2+. ` +
        `Set AI_PROVIDER="mock" (default) until then.`
    );
  }
  throw new Error(`Unknown AI provider "${id}".`);
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
    } catch (error) {
      errors.push(`Attempt ${attempt} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
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
  } catch (repairError) {
    errors.push(`Repair attempt failed: ${repairError instanceof Error ? repairError.message : 'unknown error'}`);
  }

  // Fail closed: no partial/trusted output. Log server-side only (no secrets).
  logger.warn('AI generation failed closed after retries', { purpose, attempts });
  return { ok: false, errors, fallbackUsed: true, attempts };
}
