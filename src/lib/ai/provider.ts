// Server-only AI provider abstraction (Phase 4.2.1 foundation).
// IMPORTANT: Do NOT import this module (or anything under src/lib/ai/) from
// client components ("use client"). Provider keys live server-side only.
//
// Provenance rule: provider output must ALWAYS be classified as AI_INFERENCE.
// There is no code path here that can produce VERIFIED_DATA.

export type AiProviderId = 'mock' | 'gemini' | 'openai';

export interface AiJsonSchema {
  required?: string[];
  properties?: Record<string, 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'object' | 'object[]'>;
}

export interface AiGenerateOptions {
  model: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  jsonSchema: AiJsonSchema;
  /** Optional caller-supplied idempotency/dedup hint. Not a cache store. */
  cacheKey?: string;
  /** Attribution label, e.g. 'research.findings'. Used for logging/usage. */
  purpose: string;
}

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiGenerateResult {
  /** Raw model text (expected to be a JSON document). */
  text: string;
  /** Parsed JSON value. Shape is validated separately in schemas.ts. */
  parsed: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: AiProviderId;
  latencyMs: number;
}

export interface AiProvider {
  readonly id: AiProviderId;
  generate(prompt: string, opts: AiGenerateOptions): Promise<AiGenerateResult>;
}

const VALID_PROVIDER_IDS: AiProviderId[] = ['mock', 'gemini', 'openai'];

function readProviderId(): AiProviderId {
  const raw = (process.env.AI_PROVIDER || 'mock').trim().toLowerCase();
  if (raw.length === 0) return 'mock';
  if ((VALID_PROVIDER_IDS as string[]).includes(raw)) return raw as AiProviderId;
  throw new Error(
    `Invalid AI_PROVIDER "${raw}". Must be one of: ${VALID_PROVIDER_IDS.join(', ')}.`
  );
}

/**
 * Resolve which provider to use. Defaults to 'mock' (no key required).
 * Real providers are validated explicitly at call time in generate.ts —
 * a missing key is a loud configuration error, never a silent mock fallback.
 */
export function resolveProviderId(): AiProviderId {
  return readProviderId();
}

/** True when real network AI calls are intended (key still required). */
export function isRealProvider(id: AiProviderId): boolean {
  return id === 'gemini' || id === 'openai';
}
