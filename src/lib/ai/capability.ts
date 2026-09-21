// Phase 5.5 — AI provider capability discovery (Part 1).
//
// HONESTY RULE: an environment variable is NOT proof of a working provider.
// The label 'LIVE' is returned only after a real, successful generation round
// trip through the existing provider adapter (server-side only). Absent that
// verification, the honest labels are:
//
//   NOT_CONFIGURED  — no AI_PROVIDER_API_KEY is set server-side.
//   MOCKED          — AI_PROVIDER=mock (the deterministic default).
//   ERROR           — key present but a real verification call failed; the
//                     label carries the typed error category, never the key.
//
// This module never exposes the key, never logs it, and performs no client
// reach. The verify seam uses the REAL Gemini adapter so verification is
// meaningful; tests inject a fetch seam rather than calling the network.

import { resolveProviderId, isRealProvider, isAiProviderError } from './provider';
import { GeminiProvider } from './gemini';

export type AiCapabilityStatus = 'LIVE' | 'MOCKED' | 'NOT_CONFIGURED' | 'ERROR';

export interface AiCapability {
  status: AiCapabilityStatus;
  providerId: 'mock' | 'gemini' | 'openai';
  /** Why the status is what it is (safe, bounded, secret-free). */
  detail: string;
  /** Required configuration the operator must supply to reach LIVE. */
  requiredToActivate: string[];
  /** Present when status === 'ERROR' (typed category — never a message with secrets). */
  lastErrorCategory: string | null;
  /** Model the provider would use (non-secret). */
  model: string | null;
  /** True only when an actual generation round trip has succeeded. */
  verifiedAt: string | null;
}

/** Model used for capability verification (cheap, deterministic-ish). */
const VERIFY_MODEL = 'gemini-2.0-flash-lite';
const VERIFY_TIMEOUT_MS = 8_000;
const VERIFY_PROMPT = 'Reply with the JSON document {"ok":true}. Output only JSON.';
/** Bounded: cache the verification result for this long (ms). */
const VERIFY_TTL_MS = 5 * 60 * 1000;

let cachedVerification: { at: number; ok: boolean } | null = null;

/** Shape of the verification round trip (injected in tests; real in prod). */
export type VerifyGenerate = (apiKey: string) => Promise<void>;

/** Perform one real generation round trip through the real Gemini adapter. */
async function verifyGeminiRoundTrip(apiKey: string): Promise<void> {
  const provider = new GeminiProvider({ apiKey });
  await provider.generate(VERIFY_PROMPT, {
    model: VERIFY_MODEL,
    timeoutMs: VERIFY_TIMEOUT_MS,
    maxOutputTokens: 64,
    temperature: 0,
    jsonSchema: { required: ['ok'] },
    purpose: 'capability.verify',
  });
}

let verifyImpl: VerifyGenerate = verifyGeminiRoundTrip;

/** Test seam: replace the verification round trip (no network in tests). */
export function __setAiCapabilityVerifySeam(fn: VerifyGenerate): void {
  verifyImpl = fn;
}

/** Test seam: restore the real verification round trip. */
export function __resetAiCapabilityVerifySeam(): void {
  verifyImpl = verifyGeminiRoundTrip;
}

/**
 * Capability surface for dashboards/APIs. Cached for VERIFY_TTL_MS so a busy
 * dashboard does not re-verify on every render; a failed verification is not
 * cached (so recovery is detected promptly).
 */
export function describeAiCapability(): AiCapability {
  const providerId = resolveProviderId();
  const base = {
    providerId,
    model: null as string | null,
    verifiedAt: null as string | null,
    lastErrorCategory: null as string | null,
  };

  if (!isRealProvider(providerId)) {
    return {
      ...base,
      status: 'MOCKED',
      detail:
        'AI_PROVIDER is mock: deterministic generation only, no external calls, no cost. '
        + 'Set AI_PROVIDER=gemini plus AI_PROVIDER_API_KEY (server-side) for live AI.',
      requiredToActivate: ['AI_PROVIDER=gemini', 'AI_PROVIDER_API_KEY'],
      model: 'deterministic-mock',
    };
  }

  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return {
      ...base,
      status: 'NOT_CONFIGURED',
      detail: `AI_PROVIDER=${providerId} is selected but the server-side API key is missing. Calls fail closed — no silent mock fallback, no fabricated output.`,
      requiredToActivate: ['AI_PROVIDER_API_KEY'],
      model: null,
    };
  }

  if (cachedVerification && cachedVerification.ok && Date.now() - cachedVerification.at < VERIFY_TTL_MS) {
    return {
      ...base,
      status: 'LIVE',
      detail: 'A real generation round trip through the provider adapter succeeded within the verification window.',
      requiredToActivate: [],
      model: VERIFY_MODEL,
      verifiedAt: new Date(cachedVerification.at).toISOString(),
    };
  }

  return {
    ...base,
    status: 'ERROR',
    detail:
      'AI_PROVIDER=gemini and a server-side key are present, but no successful generation round trip has been '
      + 'verified in this window. The label LIVE requires an actual provider confirmation, not a key check. '
      + 'Trigger an AI task to verify; failures are typed and observable.',
    requiredToActivate: ['A successful generation round trip (run any AI task once)'],
    model: VERIFY_MODEL,
  };
}

/**
 * Server-side verification entry point: performs one REAL minimal generation
 * through the real adapter and caches success. Never exposes the key. Used by
 * the capability API route (POST action "verify") and by ops checks.
 */
export async function verifyAiProvider(): Promise<AiCapability> {
  const providerId = resolveProviderId();
  if (!isRealProvider(providerId)) {
    return describeAiCapability();
  }
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return describeAiCapability();
  }
  try {
    await verifyImpl(apiKey.trim());
    cachedVerification = { at: Date.now(), ok: true };
  } catch (error) {
    cachedVerification = null;
    const category = isAiProviderError(error) ? error.category : 'unknown';
    const capability = describeAiCapability();
    return {
      ...capability,
      status: 'ERROR',
      lastErrorCategory: category,
      detail: `Verification generation failed (${category}). The provider is NOT verified; no LIVE label is issued. No key material is included in this report.`,
    };
  }
  const capability = describeAiCapability();
  return { ...capability, status: 'LIVE', verifiedAt: new Date(cachedVerification!.at).toISOString() };
}

/** Test seam: reset the verification cache (node:test lifecycle). */
export function __resetAiCapabilityCache(): void {
  cachedVerification = null;
}
