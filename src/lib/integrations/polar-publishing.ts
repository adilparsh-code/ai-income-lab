// Phase 8 — Polar publishing adapter (Rule 5).
//
// Implements the EXISTING PublishingProvider contract
// (src/lib/publishing/contract.ts) for the DIGITAL_PRODUCT channel via the
// Polar merchant-of-record API (https://api.polar.sh/v1). No SDK dependency —
// plain fetch with strict response verification.
//
// Rule 2 (no fake LIVE): publish() claims "published" only when the provider
// returned a real product id AND a follow-up GET confirmed the product exists.
// Adapter configured ≠ LIVE; a verified provider round-trip is required.
//
// Credentials: POLAR_ACCESS_TOKEN is read ONLY from server-side env, never
// logged, never returned; only a SHA-256 prefix fingerprint is ever surfaced.
// Publication additionally requires the human approval token (enforced by the
// existing boundary and re-checked here), so no autonomous publishing exists.

import { createHash } from 'node:crypto';
import type {
  PublishingProvider,
  PublishingDraft,
  PublishingValidationResult,
  PublishAttempt,
  PublishingHealth,
  PublishableProductSpec,
} from '@/lib/publishing/contract';
import { validateSpecLocally } from '@/lib/publishing/contract';

// ---------------------------------------------------------------------------
// Configuration (server-side only)
// ---------------------------------------------------------------------------

export const POLAR_ACCESS_TOKEN_ENV = 'POLAR_ACCESS_TOKEN';
export const POLAR_ORG_ID_ENV = 'POLAR_ORG_ID';
const POLAR_API_BASE = 'https://api.polar.sh/v1';
/** Polar fixed prices are integer minor units (cents). */
const MAX_PRICE_CENTS = 1_000_000; // $10,000 guard

function readToken(): string | null {
  const raw = process.env[POLAR_ACCESS_TOKEN_ENV];
  if (typeof raw !== 'string' || raw.trim().length < 10) return null;
  return raw.trim();
}

function tokenFingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export interface SafePolarConfig {
  connected: boolean;
  /** SHA-256 prefix of the token — never the token itself. */
  tokenFingerprint: string | null;
  orgIdConfigured: boolean;
  hint: string;
}

export function describePolarConfig(): SafePolarConfig {
  const token = readToken();
  const orgConfigured = Boolean(process.env[POLAR_ORG_ID_ENV]?.trim());
  return {
    connected: token !== null,
    tokenFingerprint: token ? tokenFingerprintOf(token) : null,
    orgIdConfigured: orgConfigured,
    hint: token
      ? 'Polar access token configured (server-side only). Publication still requires a human approval token per request.'
      : 'No POLAR_ACCESS_TOKEN configured; the adapter reports AUTH_REQUIRED and performs no external calls.',
  };
}

// ---------------------------------------------------------------------------
// Provider idempotency: deterministic per (spec identity) → same draft + key
// ---------------------------------------------------------------------------

function specFingerprint(spec: PublishableProductSpec): string {
  const material = JSON.stringify({
    t: spec.productType,
    n: spec.name.trim().toLowerCase(),
    m: spec.monetizationModel,
    p: spec.pricingHypothesis.trim(),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function extractPriceCents(hypothesis: string): number | null {
  const match = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(hypothesis ?? '');
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

// ---------------------------------------------------------------------------
// Strict provider-payload verification
// ---------------------------------------------------------------------------

interface PolarProductPayload {
  id?: unknown;
  name?: unknown;
}

function verifiedProductFields(payload: unknown): { id: string; name: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as PolarProductPayload;
  if (typeof p.id !== 'string' || p.id.length === 0) return null;
  if (typeof p.name !== 'string') return null;
  return { id: p.id, name: p.name };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PolarPublishingAdapter implements PublishingProvider {
  readonly id = 'polar';
  readonly channel = 'DIGITAL_PRODUCT' as const;

  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly orgId: string | null;

  constructor(options: { fetchImpl?: typeof fetch; apiBase?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = options.apiBase ?? POLAR_API_BASE;
    this.orgId = process.env[POLAR_ORG_ID_ENV]?.trim() || null;
  }

  static isConfigured(): boolean {
    return readToken() !== null;
  }

  validate(spec: PublishableProductSpec): PublishingValidationResult {
    const local = validateSpecLocally(spec);
    const errors = [...local.errors];
    const warnings = [...local.warnings];
    const priceCents = extractPriceCents(spec.pricingHypothesis);
    if (priceCents === null) {
      warnings.push('No parseable price in the pricing hypothesis; the adapter will draft at a $9.99 hypothesis price.');
    } else if (priceCents <= 0) {
      errors.push('Parsed price must be positive.');
    } else if (priceCents > MAX_PRICE_CENTS) {
      errors.push(`Parsed price exceeds the adapter guard of $${(MAX_PRICE_CENTS / 100).toFixed(0)}.`);
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  draft(spec: PublishableProductSpec): PublishingDraft {
    const fingerprint = specFingerprint(spec);
    const priceCents = extractPriceCents(spec.pricingHypothesis) ?? 999;
    return {
      providerId: this.id,
      channel: this.channel,
      isLive: false,
      createdAt: new Date().toISOString(),
      payload: {
        name: spec.name.slice(0, 190),
        description: `Problem: ${spec.problem.slice(0, 300)} | Value: ${spec.valueProposition.slice(0, 300)} | Provenance: ${spec.evidenceProvenance}`,
        metadata: {
          source: 'ai-income-lab',
          specFingerprint: fingerprint,
          productType: spec.productType,
          monetizationModel: spec.monetizationModel,
          evidenceProvenance: spec.evidenceProvenance,
        },
        ...(this.orgId ? { organization_id: this.orgId } : {}),
        prices: [{ amount_type: 'fixed', price_amount: priceCents, price_currency: 'usd' }],
      },
    };
  }

  /**
   * Real provider round-trip: POST /v1/products/ then VERIFY with a GET of the
   * created product. "published" is claimed only when both succeed and the id
   * matches. Any failure is reported honestly with nothing fabricated.
   */
  async publish(draft: PublishingDraft, humanApprovalToken: string): Promise<PublishAttempt> {
    if (!humanApprovalToken || humanApprovalToken.trim().length === 0) {
      return { published: false, status: 'NOT_AUTHORIZED', reason: 'Explicit human approval token is required. Nothing was published.' };
    }
    if (!PolarPublishingAdapter.isConfigured()) {
      return {
        published: false,
        status: 'NOT_AUTHORIZED',
        reason: 'POLAR_ACCESS_TOKEN is not configured (AUTH_REQUIRED). Nothing was published.',
      };
    }
    if (draft.providerId !== this.id || draft.channel !== this.channel || draft.isLive !== false) {
      return { published: false, status: 'NOT_AUTHORIZED', reason: 'Draft was not produced by this adapter; refusing.' };
    }
    const payload = draft.payload as { name?: unknown; prices?: unknown; metadata?: unknown };
    if (typeof payload.name !== 'string' || payload.name.trim().length === 0 || !Array.isArray(payload.prices)) {
      return { published: false, status: 'NOT_AUTHORIZED', reason: 'Draft payload failed adapter re-validation; nothing was sent.' };
    }

    const token = readToken();
    if (!token) {
      return { published: false, status: 'NOT_AUTHORIZED', reason: 'Credential unavailable at publish time; refusing.' };
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    try {
      const created = await this.fetchImpl(`${this.apiBase}/products/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!created.ok) {
        const detail = (await created.text().catch(() => '')).slice(0, 200);
        return {
          published: false,
          status: 'PUBLISHING_UNAVAILABLE',
          reason: `Polar product creation failed (HTTP ${created.status}). Nothing was published. ${detail}`.trim(),
        };
      }
      const createdPayload = verifiedProductFields(await created.json().catch(() => null));
      if (!createdPayload) {
        return {
          published: false,
          status: 'PUBLISHING_UNAVAILABLE',
          reason: 'Polar returned an unparseable product payload; refusing to claim publication.',
        };
      }

      // Verification round-trip — publication is confirmed only when the
      // provider answers GET for the created product id.
      const confirmed = await this.fetchImpl(`${this.apiBase}/products/${encodeURIComponent(createdPayload.id)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!confirmed.ok) {
        return {
          published: false,
          status: 'PUBLISHING_UNAVAILABLE',
          reason: `Polar product created (id ${createdPayload.id}) but the verification round-trip failed (HTTP ${confirmed.status}); publication is NOT confirmed.`,
        };
      }
      const confirmedPayload = verifiedProductFields(await confirmed.json().catch(() => null));
      if (!confirmedPayload || confirmedPayload.id !== createdPayload.id) {
        return {
          published: false,
          status: 'PUBLISHING_UNAVAILABLE',
          reason: 'Polar verification returned a mismatched product; publication is NOT confirmed.',
        };
      }

      return {
        published: true,
        status: 'PUBLISHED',
        reason: 'Verified publication: product created and confirmed via a provider round-trip.',
        publicationId: createdPayload.id,
        publicationUrl: `https://polar.sh/products/${createdPayload.id}`,
      } as PublishAttempt & { publicationId: string; publicationUrl: string };
    } catch {
      return {
        published: false,
        status: 'PUBLISHING_UNAVAILABLE',
        reason: 'Polar API is unreachable; nothing was published and nothing was fabricated.',
      };
    }
  }

  async status(reference: string): Promise<PublishingHealth & { reference: string }> {
    const unavailable = (hint: string): PublishingHealth & { reference: string } => ({
      providerId: this.id,
      channel: this.channel,
      status: 'PUBLISHING_UNAVAILABLE',
      hint,
      reference,
    });
    const token = readToken();
    if (!token) return unavailable('POLAR_ACCESS_TOKEN not configured.');
    try {
      const res = await this.fetchImpl(`${this.apiBase}/products/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (res.status === 404) return unavailable('Product not found at the provider.');
      if (!res.ok) return unavailable(`Provider returned HTTP ${res.status}.`);
      const payload = verifiedProductFields(await res.json().catch(() => null));
      if (!payload) return unavailable('Unparseable provider response.');
      return {
        providerId: this.id,
        channel: this.channel,
        status: 'AVAILABLE',
        hint: `Verified: product "${payload.name}" exists at the provider.`,
        reference,
      };
    } catch {
      return unavailable('Network error during status round-trip.');
    }
  }
}
