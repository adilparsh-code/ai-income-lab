// ============================================================================
// RUFLO RUNTIME HANDLE + STARTUP WIRING (Ruflo Live Integration Phase)
// ============================================================================
// The server-side adapter that connects a configured Ruflo runtime to the
// existing connector seam. Registration remains a SERVER-SIDE action (never
// HTTP): this module is invoked from Next.js instrumentation at startup and
// is fully idempotent.
//
// What "registered" means here (honest definition):
//   RUFLO_RUNTIME_TOKEN configured AND RUFLO_RUNTIME_ENABLED=true → the handle
//   is registered and the runtime API (dispatch/health/status) is active.
//   Without BOTH, nothing registers and the capability stays NOT_CONFIGURED
//   (or AUTH_REQUIRED if only the token exists) — never a fake CONNECTED.
//
// The handle does three things, none of which bypass any gate:
//   1. labels the runtime in audit events (non-secret id),
//   2. receives bounded completion summaries (notification only — it cannot
//      re-execute, alter results, or trigger side effects),
//   3. is the connection precondition for dispatchWorkflowViaRuflo().
// ============================================================================

import { logger } from '@/lib/server-log';
import { getRufloRuntimeConfig, RUFLO_RUNTIME_TOKEN_ENV } from './runtime';
import { registerRufloOrchestrator, getRegisteredRufloOrchestrator } from './connector';

/**
 * Register the configured Ruflo runtime handle (idempotent). Called from
 * instrumentation.ts on server startup. Returns a safe, non-secret summary.
 */
export function setupRufloRuntime(): {
  registered: boolean;
  reason: string;
  runtimeId: string | null;
} {
  const config = getRufloRuntimeConfig();

  if (!config.token) {
    return {
      registered: false,
      reason: `${RUFLO_RUNTIME_TOKEN_ENV} is not configured — Ruflo runtime stays NOT_CONFIGURED. The workflow boundary remains RUFLO_READY (contracts only).`,
      runtimeId: null,
    };
  }
  const enabled = (process.env.RUFLO_RUNTIME_ENABLED ?? '').trim().toLowerCase();
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') {
    return {
      registered: false,
      reason: `${RUFLO_RUNTIME_TOKEN_ENV} is configured but RUFLO_RUNTIME_ENABLED is not true — the runtime API is disabled (AUTH_REQUIRED posture). No handle was registered.`,
      runtimeId: config.runtimeId,
    };
  }
  if (getRegisteredRufloOrchestrator()) {
    return {
      registered: true,
      reason: `Ruflo runtime handle '${config.runtimeId}' is already registered (idempotent no-op).`,
      runtimeId: config.runtimeId,
    };
  }

  const result = registerRufloOrchestrator({ id: config.runtimeId });
  if (!result.ok) {
    logger.error('Ruflo runtime handle registration failed', { detail: result.error ?? 'unknown' });
    return { registered: false, reason: result.error ?? 'registration failed', runtimeId: null };
  }

  logger.info('Ruflo runtime handle registered', {
    runtimeId: config.runtimeId,
    dispatchTimeoutMs: config.dispatchTimeoutMs,
  });
  return {
    registered: true,
    reason: `Ruflo runtime handle '${config.runtimeId}' registered. Run the authenticated health check to move capability from CONNECTING to CONNECTED.`,
    runtimeId: config.runtimeId,
  };
}
