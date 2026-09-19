// Phase 8 — OAuth / authorization boundary state machine (Rule 11).
//
// A provider-agnostic, server-side authorization ledger for platforms that
// require OAuth (marketplaces, creator platforms, social distribution, etc.).
//
// State machine (explicit, no silent transitions):
//
//   NOT_CONNECTED → AUTHORIZING → CONNECTED → (EXPIRED | REVOKED | ERROR)
//        ↘ (failure) ERROR            ↘ (refresh handled by the adapter)
//
// Safety invariants:
// - Secrets (access/refresh tokens, client secrets) are stored ONLY here,
//   server-side, and NEVER returned by any accessor — callers receive state
//   plus non-secret metadata only.
// - Expired/revoked authorization is never silently reused: `usableFor()`
//   requires state === CONNECTED and, when an expiry is recorded, not passed.
// - Human-requiring actions still go through their own approval token path —
//   this boundary only tracks authorization, not approval.
// - No redirect URIs, state parameters, or code exchange endpoints are
//   implemented here; adapters that need them build on this state machine.

import { db } from '@/lib/db';

/** Minimal structural view of a ledger row (avoids codegen-only types). */
interface AuthorizationRow {
  id: string;
  providerId: string;
  scope: string | null;
  state: string;
  accessTokenCiphertext: string | null;
  refreshTokenCiphertext: string | null;
  expiresAt: Date | null;
  grantedScopes: string;
  metadata: string;
}

export type AuthorizationState =
  | 'NOT_CONNECTED'
  | 'AUTH_REQUIRED'
  | 'AUTHORIZING'
  | 'CONNECTED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'ERROR';

export interface AuthorizationRecordInput {
  /** Provider id, e.g. 'etsy', 'gumroad', 'youtube'. */
  providerId: string;
  /** Optional scope label, e.g. channel or capability. */
  scope?: string | null;
  /** Encrypted-at-rest or otherwise protected token material (server-side). */
  accessTokenCiphertext: string | null;
  refreshTokenCiphertext?: string | null;
  expiresAt?: Date | null;
  grantedScopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface SafeAuthorizationView {
  providerId: string;
  scope: string | null;
  state: AuthorizationState;
  expiresAt: string | null;
  grantedScopes: string[];
  /** True only when state is CONNECTED and the grant has not expired. */
  usable: boolean;
  /** SHA-256 prefix of the access token for correlation — never the token. */
  tokenFingerprint: string | null;
}

function isKnownState(value: string): value is AuthorizationState {
  return ['NOT_CONNECTED', 'AUTH_REQUIRED', 'AUTHORIZING', 'CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR'].includes(value);
}

/**
 * Deterministic state derivation: a CONNECTED grant whose expiry has passed is
 * EXPIRED — it is never reported usable, and no adapter may silently reuse it.
 */
export function deriveCurrentState(record: { state: string; expiresAt: Date | null }, now: Date = new Date()): AuthorizationState {
  const stored = isKnownState(record.state) ? record.state : 'ERROR';
  if (stored === 'CONNECTED' && record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return stored;
}

/** Load or create the single authorization row for (provider, scope). */
async function loadRow(providerId: string, scope: string | null): Promise<AuthorizationRow> {
  const existing = await db.integrationAuthorization.findFirst({
    where: { providerId, scope: scope ?? null },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;
  return db.integrationAuthorization.create({
    data: {
      providerId,
      scope: scope ?? null,
      state: 'NOT_CONNECTED',
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      expiresAt: null,
      grantedScopes: '[]',
      metadata: '{}',
    },
  });
}

/**
 * Persist (or overwrite) the authorization for a provider/scope. Token
 * material is accepted as an opaque string (the caller is responsible for
 * encryption if required); it is never returned or logged by this module.
 */
export async function upsertAuthorization(input: AuthorizationRecordInput): Promise<SafeAuthorizationView> {
  const row = await loadRow(input.providerId, input.scope ?? null);
  const updated = await db.integrationAuthorization.update({
    where: { id: row.id },
    data: {
      state: input.accessTokenCiphertext ? 'CONNECTED' : 'AUTH_REQUIRED',
      accessTokenCiphertext: input.accessTokenCiphertext,
      refreshTokenCiphertext: input.refreshTokenCiphertext ?? null,
      expiresAt: input.expiresAt ?? null,
      grantedScopes: JSON.stringify(input.grantedScopes ?? []),
      metadata: JSON.stringify(input.metadata ?? {}),
      updatedAt: new Date(),
    },
  });
  return toSafeView(updated);
}

/** Record a state transition (e.g. AUTHORIZING started, REVOKED by user). */
export async function markAuthorizationState(
  providerId: string,
  scope: string | null,
  nextState: Exclude<AuthorizationState, 'CONNECTED'>,
): Promise<SafeAuthorizationView> {
  const row = await loadRow(providerId, scope);
  const updated = await db.integrationAuthorization.update({
    where: { id: row.id },
    data: { state: nextState, updatedAt: new Date() },
  });
  return toSafeView(updated);
}

/** Non-secret view for dashboards; usable reflects the deterministic state. */
export async function describeAuthorization(providerId: string, scope: string | null = null): Promise<SafeAuthorizationView> {
  const row = await loadRow(providerId, scope);
  return toSafeView(row);
}

/**
 * The only gate adapters may consult before acting: authorization is usable
 * only when the derived state is CONNECTED. Expired/revoked/error states and
 * missing grants return false — never silently reused.
 */
export async function isAuthorizationUsable(providerId: string, scope: string | null = null): Promise<boolean> {
  const row = await loadRow(providerId, scope);
  return deriveCurrentState(row) === 'CONNECTED' && Boolean(row.accessTokenCiphertext);
}

/** Revoke explicitly (user-driven deauthorization or provider revocation). */
export async function revokeAuthorization(providerId: string, scope: string | null = null): Promise<SafeAuthorizationView> {
  const row = await loadRow(providerId, scope);
  const updated = await db.integrationAuthorization.update({
    where: { id: row.id },
    data: {
      state: 'REVOKED',
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      updatedAt: new Date(),
    },
  });
  return toSafeView(updated);
}

function toSafeView(row: AuthorizationRow): SafeAuthorizationView {
  const state = deriveCurrentState(row);
  let grantedScopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.grantedScopes);
    if (Array.isArray(parsed)) grantedScopes = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    grantedScopes = [];
  }
  let fingerprint: string | null = null;
  if (row.accessTokenCiphertext) {
    // Fingerprint of the ciphertext — correlation without disclosure.
    fingerprint = row.accessTokenCiphertext.slice(0, 12);
  }
  return {
    providerId: row.providerId,
    scope: row.scope,
    state,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    grantedScopes,
    usable: state === 'CONNECTED' && Boolean(row.accessTokenCiphertext),
    tokenFingerprint: fingerprint,
  };
}
