// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — server-to-server credential auth
// ============================================================================
// Dedicated credential mechanism for EXTERNAL AI agent runtimes. It reuses
// the repository's existing security primitives (constant-time comparison,
// keyed fingerprinting, durable rate limiting, audit) instead of duplicating
// them, and it is additive: the admin session system, the operator token,
// and the Ruflo runtime token are untouched.
//
// Credential model (environment-based, rotatable, never logged):
//   AGENT_<NAME>_TOKEN         — bearer secret (server-side only)
//   AGENT_<NAME>_ID            — non-secret identity bound to that token
//   AGENT_<NAME>_CAPABILITIES  — comma-separated grant list or `*`
//
// The label <NAME> is the binding key. Rotation = set a new token value in
// the environment; the change takes effect on the next request with no code
// or schema change, and old presentations simply stop matching.
//
// Fail-closed properties:
// - No AGENT_*_TOKEN configured at all → 503 NOT_CONFIGURED, every request
//   refused (the endpoint does not "open up" when unconfigured).
// - Unknown label / wrong token → 401, audited, per-credential throttled.
// - The presented token is never logged, stored, or echoed — only a keyed
//   HMAC fingerprint (credentialFingerprint) is retained for correlation.
// - Authorization is ALWAYS derived server-side: identity and capabilities
//   come from the env binding, never from anything the client sends.
// ============================================================================

import { constantTimeEquals, credentialFingerprint } from '@/lib/security/guard';
import { parseGrant } from './capabilities';
import type { AgentAction } from './contract';

const AGENT_TOKEN_PREFIX = 'AGENT_';
const AGENT_TOKEN_SUFFIX = '_TOKEN';

export interface AgentCredentialConfig {
  /** Binding label, e.g. RESEARCH_LAB (from AGENT_RESEARCH_LAB_TOKEN). */
  label: string;
  /** Bearer secret. Never returned, never logged. */
  token: string;
  /** Non-secret agent identity bound to the token. */
  agentId: string;
  /** Capability allow-list derived from AGENT_<NAME>_CAPABILITIES. */
  grantedCapabilities: AgentAction[];
}

export type CredentialStatus = 'CONFIGURED' | 'NOT_CONFIGURED';

/**
 * Discover configured agent credential bindings from the environment.
 * Scans for AGENT_*_TOKEN keys; each binding requires AGENT_<NAME>_ID.
 * A binding without an id is IGNORED (fail-closed) rather than guessed.
 * The token material is read here but never leaves this module except as an
 * opaque field on the returned record.
 */
export function discoverAgentCredentials(env: Record<string, string | undefined> = process.env): AgentCredentialConfig[] {
  const configs: AgentCredentialConfig[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(AGENT_TOKEN_PREFIX) || !key.endsWith(AGENT_TOKEN_SUFFIX)) continue;
    if (key.length <= AGENT_TOKEN_PREFIX.length + AGENT_TOKEN_SUFFIX.length) continue;
    const label = key.slice(AGENT_TOKEN_PREFIX.length, key.length - AGENT_TOKEN_SUFFIX.length);
    // Only allow-list binding labels: uppercase letters, digits, underscores.
    if (!/^[A-Z0-9_]+$/.test(label)) continue;
    const token = env[key]?.trim();
    if (!token) continue; // empty value → not configured
    const agentId = env[`${AGENT_TOKEN_PREFIX}${label}_ID`]?.trim();
    if (!agentId) continue; // no bound identity → ignore this binding entirely
    const grant = env[`${AGENT_TOKEN_PREFIX}${label}_CAPABILITIES`];
    configs.push({
      label,
      token,
      agentId: agentId.slice(0, 64),
      grantedCapabilities: parseGrant(grant),
    });
  }
  return configs;
}

export function agentCredentialStatus(): CredentialStatus {
  return discoverAgentCredentials().length > 0 ? 'CONFIGURED' : 'NOT_CONFIGURED';
}

export type AgentAuthVerdict =
  | { ok: true; identity: { agentId: string; credentialLabel: string; fingerprint: string; grantedCapabilities: AgentAction[] } }
  | { ok: false; status: 401 | 503; error: string; configured: boolean };

/**
 * Authenticate a server-to-server agent request from its Authorization header.
 * Constant-time comparison against every configured binding; a match yields
 * the SERVER-derived identity. Every refusal is the caller's duty to audit.
 */
export function authenticateAgentRequest(
  authorizationHeader: string | null,
  env: Record<string, string | undefined> = process.env,
): AgentAuthVerdict {
  const configs = discoverAgentCredentials(env);

  if (configs.length === 0) {
    return {
      ok: false,
      status: 503,
      configured: false,
      error: 'Agent API is NOT_CONFIGURED: no AGENT_<NAME>_TOKEN credential is set server-side.',
    };
  }

  const presented = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length).trim()
    : null;
  if (!presented) {
    return { ok: false, status: 401, configured: true, error: 'Unauthorized: a valid agent credential is required.' };
  }

  for (const config of configs) {
    if (constantTimeEquals(config.token, presented)) {
      return {
        ok: true,
        identity: {
          agentId: config.agentId,
          credentialLabel: config.label,
          fingerprint: credentialFingerprint(config.token),
          grantedCapabilities: config.grantedCapabilities,
        },
      };
    }
  }

  return { ok: false, status: 401, configured: true, error: 'Unauthorized: a valid agent credential is required.' };
}
