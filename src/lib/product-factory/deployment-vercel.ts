// Phase 5.4 — Vercel deployment adapter (Part 2).
//
// Implements the Phase 5.3 DeploymentProvider contract for Vercel with token
// safety as the first design constraint:
//
// - The deployment token is read ONLY from server-side env (VERCEL_TOKEN)
//   inside the adapter. It is never accepted as a caller argument, never
//   returned in any result, never logged, never persisted raw. Only the
//   Phase 5.3 SHA-256 approval-token hint is persisted (unchanged).
// - No token configured → the adapter reports DEPLOYMENT_NOT_CONNECTED and
//   every operation returns an honest, side-effect-free record. Production
//   state stays NOT_CONNECTED until the operator supplies a token.
// - Real deployment ids/URLs come ONLY from actual provider responses
//   (parsed from JSON bodies with strict validation). Nothing is invented;
//   when a call cannot be completed the record carries no id/url.
// - Network calls are opt-in via an injectable fetch so tests use mocked
//   provider responses — never fake external calls, never live API in tests.
// - Halal gates: this adapter is only ever reached through factory jobs,
//   which short-circuit NOT_ALLOWED/REVIEW_REQUIRED before any provider call.
//   Defense in depth: deploy() re-refuses NOT_ALLOWED products itself.

import { createHash } from 'node:crypto';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import {
  createUnavailableDeploymentProvider,
  type BuildResult,
  type DeploymentProvider,
  type DeploymentRecord,
  type DeploymentStatus,
  type DeploymentTarget,
} from './build-contract';

// ---------------------------------------------------------------------------
// Credential handling (server-only, redaction-safe)
// ---------------------------------------------------------------------------

/** Environment variable carrying the Vercel deployment token (server-only). */
export const VERCEL_TOKEN_ENV = 'VERCEL_TOKEN';

/** Read the token; never log or return it. Returns null when absent. */
function readToken(): string | null {
  const raw = process.env[VERCEL_TOKEN_ENV];
  if (typeof raw !== 'string' || raw.trim().length < 20) return null;
  return raw.trim();
}

/** Non-secret config metadata that MAY be surfaced/persisted safely. */
export interface SafeDeploymentConfig {
  connected: boolean;
  providerId: 'vercel' | null;
  /** SHA-256 prefix of the token for correlation — never the token. */
  tokenFingerprint: string | null;
  teamIdConfigured: boolean;
  projectIdConfigured: boolean;
  hint: string;
}

export function describeVercelConfig(): SafeDeploymentConfig {
  const token = readToken();
  // Phase 5.5 — deployment-env sync requirement: a deployed product that calls
  // back into AI Income Lab (events/revenue ingestion) needs the PUBLIC app
  // URL plus the OPERATOR_REVENUE_TOKEN mirrored into the deployment env. The
  // token value is never shown — only whether the operator must sync it.
  const missingSync: string[] = [];
  if (!process.env.NEXT_PUBLIC_APP_URL?.trim()) missingSync.push('NEXT_PUBLIC_APP_URL (public app URL for event/revenue callbacks)');
  if (!process.env.OPERATOR_REVENUE_TOKEN?.trim()) missingSync.push('OPERATOR_REVENUE_TOKEN (mirror into the deployment env for revenue ingestion)');
  return {
    connected: token !== null,
    providerId: token ? 'vercel' : null,
    tokenFingerprint: token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : null,
    teamIdConfigured: Boolean(process.env.VERCEL_TEAM_ID?.trim()),
    projectIdConfigured: Boolean(process.env.VERCEL_PROJECT_ID?.trim()),
    hint: token
      ? missingSync.length > 0
        ? `Vercel token configured (server-side only). Deployment still requires a human approval token per request. For the closed revenue loop, also configure: ${missingSync.join('; ')}.`
        : 'Vercel token configured (server-side only). Deployment still requires a human approval token per request. Deployment env sync for the revenue loop is complete.'
      : `No ${VERCEL_TOKEN_ENV} configured; the adapter reports DEPLOYMENT_NOT_CONNECTED and performs no external calls.`,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const VERCEL_API_BASE = 'https://api.vercel.com';

interface VercelFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface VercelAdapterOptions {
  /** Injectable fetch (tests inject mocked provider responses). */
  fetchImpl?: VercelFetch;
  /** Test seam: override token detection (never logs the value). */
  hasToken?: boolean;
  /** Optional free-text scope screened by the deterministic halal tool. */
  halalScreenText?: () => string;
}

interface ProviderDeploymentPayload {
  id?: unknown;
  url?: unknown;
  readyState?: unknown;
  error?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Strictly parse a provider body into a DeploymentRecord (no invention). */
function recordFromProvider(
  payload: ProviderDeploymentPayload | null,
  fallbackStatus: DeploymentStatus,
  errors: string[],
): DeploymentRecord {
  const id = isNonEmptyString(payload?.id) ? payload.id.trim() : null;
  const url = isNonEmptyString(payload?.url)
    ? (payload.url.startsWith('http') ? payload.url : `https://${payload.url}`)
    : null;
  return {
    status: id ? 'DEPLOYED' : fallbackStatus,
    providerId: id ? 'vercel' : null,
    deploymentId: id,
    url,
    version: null,
    errors,
    timestamp: new Date().toISOString(),
  };
}

function unavailableRecord(errors: string[]): DeploymentRecord {
  return {
    status: 'DEPLOYMENT_NOT_CONNECTED',
    providerId: null,
    deploymentId: null,
    url: null,
    version: null,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export class VercelDeploymentAdapter implements DeploymentProvider {
  readonly id = 'vercel';

  private readonly fetchImpl: VercelFetch | null;
  private readonly hasToken: boolean;
  private readonly halalScreenText: () => string;

  constructor(options: VercelAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? null;
    this.hasToken = options.hasToken ?? (readToken() !== null);
    this.halalScreenText = options.halalScreenText ?? (() => '');
  }

  /** Truthful: connected only when a real token exists AND fetch is wired. */
  private connectionErrors(): string[] | null {
    if (!this.hasToken) {
      return [
        `No ${VERCEL_TOKEN_ENV} is configured. The adapter is DEPLOYMENT_NOT_CONNECTED and made no external calls. `
          + 'Provide a server-side token to enable real deployments (they still require a human approval token).',
      ];
    }
    if (!this.fetchImpl) {
      return ['Vercel adapter is configured but no HTTP transport is wired in this environment; '
        + 'performing no external call rather than pretending (NOT_CONNECTED).'];
    }
    return null;
  }

  private async callVercel(
    path: string,
    init: RequestInit,
  ): Promise<{ payload: ProviderDeploymentPayload | null; errors: string[] }> {
    // Gate on the adapter's OWN token knowledge (hasToken seam). The raw token
    // is read only for the Authorization header inside this closure — it is
    // never returned, logged, or persisted.
    if (!this.hasToken || !this.fetchImpl) {
      return { payload: null, errors: this.connectionErrors() ?? ['Adapter unavailable.'] };
    }
    const token = readToken();
    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const separator = path.includes('?') ? '&' : '?';
    const url = `${VERCEL_API_BASE}${path}${separator}${teamId ? `teamId=${encodeURIComponent(teamId)}&` : ''}skipAutoDetectionConfirmation=1`;
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token ?? ''}`,
          'Content-Type': 'application/json',
        },
      });
      const body = (await response.json().catch(() => null)) as ProviderDeploymentPayload | null;
      if (!response.ok) {
        // Never include provider error payloads verbatim (may echo secrets).
        return {
          payload: null,
          errors: [`Vercel API responded ${response.status}; deployment not confirmed.`],
        };
      }
      return { payload: body, errors: [] };
    } catch (error) {
      return {
        payload: null,
        errors: [`Vercel API call failed without a confirmed deployment: ${error instanceof Error ? error.name : 'network error'}.`],
      };
    }
  }

  validate(target: DeploymentTarget): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!isNonEmptyString(target.artifactRef)) errors.push('artifactRef is required.');
    if (!isNonEmptyString(target.target)) errors.push('target is required.');
    const screen = screenForHalalCompliance(this.halalScreenText(), '', 'Digital Products', 'Direct Sales', 'ONE_TIME_PURCHASE');
    if (screen.status === 'NOT_ALLOWED') errors.push('Halal screen returned NOT_ALLOWED for this deployment scope.');
    return { valid: errors.length === 0, errors };
  }

  async build(target: DeploymentTarget): Promise<BuildResult> {
    const errors = this.connectionErrors();
    if (errors) {
      return {
        status: 'UNAVAILABLE',
        artifactRef: null,
        version: null,
        tests: null,
        logSummary: `vercel build skipped: not connected`,
        qualityGates: [],
        generatedAt: new Date().toISOString(),
        sandboxed: true,
        errors,
      };
    }
    // Provider-side build happens as part of deployment creation for Vercel;
    // a standalone build call is not part of its API. Honest no-op descriptor.
    return {
      status: 'SUCCEEDED',
      artifactRef: target.artifactRef,
      version: null,
      tests: null,
      logSummary: 'vercel: provider-side build occurs at deployment creation',
      qualityGates: [],
      generatedAt: new Date().toISOString(),
      sandboxed: true,
      errors: [],
    };
  }

  async deploy(target: DeploymentTarget, humanApprovalToken: string): Promise<DeploymentRecord> {
    // 1. Human approval gate (Phase 5.3 rule, re-checked here).
    if (!humanApprovalToken?.trim()) {
      return {
        status: 'DEPLOYMENT_NOT_CONNECTED',
        providerId: null,
        deploymentId: null,
        url: null,
        version: null,
        errors: ['Deployment requires an explicit human approval token; none was supplied. Nothing was deployed.'],
        timestamp: new Date().toISOString(),
      };
    }

    // 2. Halal defense in depth: refuse NOT_ALLOWED scopes before any call.
    const validation = this.validate(target);
    if (!validation.valid) {
      return {
        ...unavailableRecord(validation.errors),
        status: 'DEPLOYMENT_NOT_CONNECTED',
      };
    }

    // 3. Connectivity/token gate — honest NOT_CONNECTED, zero external calls.
    const notConnected = this.connectionErrors();
    if (notConnected) {
      return unavailableRecord(notConnected);
    }

    // 4. Real provider call (token stays in this closure; result redacted).
    const { payload, errors } = await this.callVercel('/v13/deployments', {
      method: 'POST',
      body: JSON.stringify({
        name: process.env.VERCEL_PROJECT_ID?.trim() || 'ai-income-lab',
        target: 'production',
        meta: { aiIncomeLabArtifact: target.artifactRef },
      }),
    });
    if (!payload) {
      return unavailableRecord(errors);
    }
    return recordFromProvider(payload, 'FAILED', errors);
  }

  async status(deploymentId: string): Promise<DeploymentRecord> {
    const notConnected = this.connectionErrors();
    if (notConnected) return unavailableRecord(notConnected);
    const { payload, errors } = await this.callVercel(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
      method: 'GET',
    });
    if (!payload) return unavailableRecord(errors);
    const record = recordFromProvider(payload, 'FAILED', errors);
    // readyState REFLECTS the provider's own state machine.
    if (isNonEmptyString(payload.readyState)) {
      record.status = payload.readyState === 'READY' ? 'DEPLOYED'
        : payload.readyState === 'ERROR' ? 'FAILED'
          : payload.readyState === 'CANCELED' ? 'ROLLED_BACK'
            : record.status;
    }
    return record;
  }

  async rollback(deploymentId: string, humanApprovalToken: string): Promise<DeploymentRecord> {
    if (!humanApprovalToken?.trim()) {
      return {
        ...unavailableRecord(['Rollback requires an explicit human approval token; nothing was rolled back.']),
      };
    }
    const notConnected = this.connectionErrors();
    if (notConnected) return unavailableRecord(notConnected);
    const { payload, errors } = await this.callVercel(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ target: 'previous' }),
    });
    if (!payload) return unavailableRecord(errors);
    return recordFromProvider(payload, 'FAILED', errors);
  }
}

/** Resolve the deployment provider: Vercel when configured, else unavailable. */
export function resolveVercelAwareDeploymentProvider(options: VercelAdapterOptions = {}): DeploymentProvider {
  // Injected hasToken (tests) wins; otherwise consult real config.
  const connected = options.hasToken ?? describeVercelConfig().connected;
  if (!connected) {
    // Keep the Phase 5.3 unavailable adapter as the honest default.
    return createUnavailableDeploymentProvider();
  }
  return new VercelDeploymentAdapter(options);
}
