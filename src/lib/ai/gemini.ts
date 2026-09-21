// Server-only Gemini provider adapter (Phase 4.2.2).
//
// Implements the GENERIC AiProvider interface from ./provider. Direct HTTP/fetch
// only — NO LangChain, NO Vercel AI SDK, minimal dependencies.
//
// Provider-agnostic by construction: this module is NOT imported by the
// Research Agent. It is resolved by the orchestrator (generate.ts) via
// getProvider() the same way mock and future providers are.
//
// Provenance: everything returned here is raw model output. Callers MUST treat
// it as AI_INFERENCE. An AI call can never produce VERIFIED_DATA.
//
// SECURITY: the API key is read from the environment (AI_PROVIDER_API_KEY),
// accepted in the constructor, and sent server-side only. It is never logged,
// never included in results/errors, and never exposed to the client.

import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderError,
  AiProviderId,
} from './provider';
import { estimateTokens } from './models';
import { parseJsonDocument } from './schemas';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Minimal typed view of the Gemini generateContent success payload. */
export interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GeminiProviderOptions {
  apiKey: string;
  /* Test seam: override fetch to simulate responses without network access. */
  fetchImpl?: FetchLike;
}

export class GeminiProvider implements AiProvider {
  readonly id: AiProviderId = 'gemini';
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new AiProviderError('Gemini API key is missing.', {
        category: 'authentication',
      });
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async generate(prompt: string, opts: AiGenerateOptions): Promise<AiGenerateResult> {
    const started = Date.now();
    const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: opts.temperature,
            maxOutputTokens: opts.maxOutputTokens,
            responseMimeType: 'application/json',
          },
        }),
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AiProviderError(`Gemini request timed out after ${opts.timeoutMs}ms.`, {
          category: 'timeout',
          retryable: true,
        });
      }
      if (error instanceof TypeError) {
        throw new AiProviderError('Gemini request failed at the network layer.', {
          category: 'network',
          retryable: true,
        });
      }
      throw error;
    }
    clearTimeout(timer);
const raw = await res.text();
    const body = parseBody(raw, res);
    if (!res.ok) {
      throw this.classifyHttpError(res.status, body);
    }

    const text = extractGeminiText(body);
    if (!text) {
      throw new AiProviderError('Gemini returned a successful response with no content.', {
        category: 'invalid_response',
      });
    }

    const parsedDocument = parseJsonDocument(text);
    const parsedInput = parsedDocument.ok ? parsedDocument.value : undefined;

    const inputTokens = body.usageMetadata?.promptTokenCount ?? estimateTokens(prompt);
    const outputTokens = body.usageMetadata?.candidatesTokenCount ?? estimateTokens(text);

    return {
      text,
      parsed: parsedInput,
      inputTokens,
      outputTokens,
      model: opts.model,
      provider: 'gemini',
      latencyMs: Date.now() - started,
    };
  }

  private classifyHttpError(status: number, body: GeminiGenerateResponse): AiProviderError {
    const apiMessage = body.error?.message;
    const combined = apiMessage
      ? `Gemini request failed (HTTP ${status}): ${apiMessage}`
      : `Gemini request failed with HTTP status ${status}.`;
    const lower = (apiMessage ?? '').toLowerCase();
    const lowerStatus = String(body.error?.status ?? '').toLowerCase();

    switch (status) {
      case 400: {
        if (/quota|insufficient|exceed/.test(lower) || /quota/.test(lowerStatus)) {
          return new AiProviderError(combined, { category: 'quota', status, retryable: true });
        }
        // 400 with a well-formed body usually means the model refused to answer.
        return new AiProviderError(combined, { category: 'invalid_response', status });
      }
      case 401:
      case 403:
        return new AiProviderError('Gemini authentication failed. Check the AI_PROVIDER_API_KEY.', {
          category: 'authentication',
          status,
        });
      case 429: {
        if (/quota/.test(lower) || /resource has been exhausted/.test(lower)) {
          return new AiProviderError(combined, { category: 'quota', status, retryable: true });
        }
        return new AiProviderError(combined, { category: 'rate_limit', status, retryable: true });
      }
      case 404:
        return new AiProviderError('Gemini model not found or unavailable for the configured account.', {
          category: 'provider_unavailable',
          status,
        });
      case 500:
      case 502:
      case 503:
      case 504:
        return new AiProviderError(combined, { category: 'provider_unavailable', status, retryable: true });
      default:
        return new AiProviderError(combined, { category: 'http', status, retryable: status >= 500 });
    }
  }
}

function parseBody(raw: string, res: Response): GeminiGenerateResponse {
  if (!raw || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as GeminiGenerateResponse;
  } catch {
    return {
      error: {
        code: res.status,
        message: 'Provider returned a non-JSON body.',
      },
    };
  }
}

function extractGeminiText(body: GeminiGenerateResponse): string {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  return parts.map((part) => part.text ?? '').join('').trim();
}

/** Construct a configured Gemini adapter from an API key (server-side only). */
export function buildGeminiProvider(apiKey: string): GeminiProvider {
  return new GeminiProvider({ apiKey });
}