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
  RETRYABLE_CATEGORIES,
  classifyGenericError,
  isRealProvider,
  resolveProviderId,
} from './provider';
import { clampMaxOutputTokens, clampTemperature, estimateCostUsd, estimateTokens, getDailyBudgetUsd, getModelPolicyOrDefault, type AiPurpose } from './models';
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

export function identifyExecutionMode(): { provider: AiProviderId; isLive: boolean; isMocked: boolean } {
  const provider = resolveProviderId();
  return { provider, isLive: isRealProvider(provider), isMocked: provider === 'mock' };
}

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

/** Build sanitized usage metadata; never NaN/Infinity, never key material. */
function buildUsage(
  result: { provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number },
  started: number
): { provider: string; model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number; latencyMs: number } {
  const inputTokens = Number.isFinite(result.inputTokens) && result.inputTokens >= 0 ? Math.floor(result.inputTokens) : 0;
  const outputTokens = Number.isFinite(result.outputTokens) && result.outputTokens >= 0 ? Math.floor(result.outputTokens) : 0;
  return {
    provider: result.provider,
    model: result.model,
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimateCostUsd(result.model, inputTokens, outputTokens),
    latencyMs: Math.max(0, Date.now() - started),
  };
}

/**
 * Summarize an error for logs/results WITHOUT leaking env values or key
 * material. Provider messages may echo configuration; strip anything that
 * looks like a key/token before it reaches the error list.
 */
function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactKeyMaterial(message).slice(0, 300);
}

const KEY_LIKE_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_\-]{10,}/g,
  /sk-[A-Za-z0-9_\-]{10,}/g,
  /key=[A-Za-z0-9_\-]{10,}/gi,
  /(?:api[_-]?key|token|password|secret)\s*[=:]\s*["']?[A-Za-z0-9_\-./:@]{8,}/gi,
];

function redactKeyMaterial(text: string): string {
  let output = text;
  for (const pattern of KEY_LIKE_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
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
  categories?: AiErrorCategory[];
}

export type GenerationOutcome<T> = ValidatedGeneration<T> | FailedGeneration;

export async function generateValidated<T extends Record<string, unknown>>(
  prompt: string,
  purpose: string,
  schema: AiGenerateOptions['jsonSchema'],
  overrides?: Partial<Pick<AiGenerateOptions, 'model' | 'maxOutputTokens' | 'temperature' | 'timeoutMs' | 'cacheKey'>>
): Promise<GenerationOutcome<T>> {
  const started = Date.now();
  const provider = getProvider();
  // Model selection follows the PURPOSE-SPECIFIC model policy. Callers may
  // override, but when they do not, the policy for this purpose decides the
  // model — never a hardcoded default buried in the call site. Unknown purpose
  // labels resolve to a conservative generic policy instead of crashing.
  const policy = getModelPolicyOrDefault(purpose);
  const timeoutMs = overrides?.timeoutMs ?? getTimeoutMs();
  const maxRetries = getMaxRetries();
  const maxOutputTokens = clampMaxOutputTokens(overrides?.maxOutputTokens ?? policy.maxOutputTokens);
  const temperature = clampTemperature(overrides?.temperature ?? policy.temperature);
  const model = overrides?.model ?? policy.model;

  const estimatedCostRaw = estimateCostUsd(model, estimateTokens(prompt), maxOutputTokens);
  const estimatedCost = Number.isFinite(estimatedCostRaw) && estimatedCostRaw >= 0 ? estimatedCostRaw : 0;
  const budget = getDailyBudgetUsd();
  if (estimatedCost > budget) {
    return { ok: false, errors: [`Estimated cost $${estimatedCost.toFixed(6)} exceeds daily budget $${budget.toFixed(2)}. Request blocked.`], fallbackUsed: true, attempts: 0 };
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
          usage: buildUsage(result, started),
          fallbackUsed: false,
          attempts,
        };
      }
      errors.push(`Attempt ${attempt}: schema validation failed: ${validated.errors.join('; ')}`);
      categories.push('invalid_response');
    } catch (error) {
      errors.push(`Attempt ${attempt} failed: ${summarizeError(error)}`);
      categories.push(classifyGenericError(error));
      // Bounded retry: only retry error categories that are actually retryable.
      // Malformed/invalid responses and auth failures cannot improve on retry;
      // fail closed immediately instead of burning budget on hopeless retries.
      if (!RETRYABLE_CATEGORIES.has(categories[categories.length - 1])) break;
    }
    if (attempt < maxAttempts) await sleep(Math.min(4000, 250 * 2 ** (attempt - 1)));
  }

  try {
    const repair = await withTimeout(provider.generate(prompt, opts), timeoutMs, 'AI generation (repair attempt)');
    const revalidated = parseAndValidate(repair.text, schema);
    attempts += 1;
    if (revalidated.valid) {
      return {
        ok: true,
        value: revalidated.value as T,
        usage: buildUsage(repair, started),
        fallbackUsed: false,
        attempts,
      };
    }
    errors.push(`Repair attempt: schema validation failed: ${revalidated.errors.join('; ')}`);
    categories.push('invalid_response');
  } catch (repairError) {
    errors.push(`Repair attempt failed: ${summarizeError(repairError)}`);
    categories.push(classifyGenericError(repairError));
  }

  logger.warn('AI generation failed closed after retries', { purpose, attempts });
  return { ok: false, errors, fallbackUsed: true, attempts, categories };
}
