// Ruflo dashboard status → label mapping (Phase 1 reconciliation).
//
// PURE module: no DB, no network, no secrets. It turns the status computed by
// `describeRufloRuntime()` (runtime.ts) into the wording shown on the admin
// dashboard.
//
// Why this exists: two different facts are easy to conflate.
//   1. A runtime HANDLE is registered server-side (instrumentation.ts does this
//      at startup when RUFLO_RUNTIME_TOKEN + RUFLO_RUNTIME_ENABLED are set).
//   2. A real runtime HEALTH VERIFICATION has succeeded (recorded durably in the
//      SecurityEvent trail; see verifyRufloRuntime()).
// Only (1) AND (2) together is CONNECTED. Registered-but-unverified is
// CONNECTING and must never be presented as connected.

import type { RufloRuntimeStatus } from './runtime';

export type RufloDashboardState = RufloRuntimeStatus | 'UNAVAILABLE';
export type RufloDashboardTone = 'good' | 'warn' | 'muted';

export interface RufloDashboardStatus {
  state: RufloDashboardState;
  /** Short badge text. Starts with "RUFLO CONNECTED" only for verified CONNECTED. */
  label: string;
  tone: RufloDashboardTone;
  /** True only when a registered handle AND a successful health check exist. */
  healthVerified: boolean;
  /** One honest sentence explaining the state. */
  note: string;
}

const KNOWN_STATES: readonly RufloRuntimeStatus[] = [
  'NOT_CONFIGURED',
  'AUTH_REQUIRED',
  'CONNECTING',
  'CONNECTED',
  'ERROR',
];

/** Check whether a value is one of the recognized Ruflo runtime states. */
function isRuntimeStatus(value: unknown): value is RufloRuntimeStatus {
  return typeof value === 'string' && (KNOWN_STATES as readonly string[]).includes(value);
}

/**
 * Map the runtime capability status to dashboard wording. Unknown, missing or
 * unreadable status (for example the status query threw) maps to UNAVAILABLE,
 * never to a connected-looking label.
 */
export function describeRufloDashboardStatus(status: string | null | undefined): RufloDashboardStatus {
  if (!isRuntimeStatus(status)) {
    return {
      state: 'UNAVAILABLE',
      label: 'RUFLO STATUS UNAVAILABLE',
      tone: 'muted',
      healthVerified: false,
      note: 'The Ruflo runtime status could not be read. Nothing is assumed to be connected.',
    };
  }

  switch (status) {
    case 'CONNECTED':
      return {
        state: status,
        label: 'RUFLO CONNECTED · LAST HEALTH CHECK PASSED',
        tone: 'good',
        healthVerified: true,
        note: 'A runtime handle is registered and a runtime health check passed within the last 10 minutes. All gates stay enforced by AI Income Lab.',
      };
    case 'CONNECTING':
      return {
        state: status,
        label: 'HANDLE REGISTERED · NOT VERIFIED',
        tone: 'warn',
        healthVerified: false,
        note: 'A runtime handle is registered but there is no successful health check within the last 10 minutes (none recorded yet, or the last one is stale). Run the authenticated health check (POST /api/ruflo/runtime).',
      };
    case 'ERROR':
      return {
        state: status,
        label: 'RUFLO HEALTH CHECK FAILED',
        tone: 'warn',
        healthVerified: false,
        note: 'The last runtime health check failed. The runtime is not verified healthy.',
      };
    case 'AUTH_REQUIRED':
      return {
        state: status,
        label: 'TOKEN SET · NO HANDLE REGISTERED',
        tone: 'muted',
        healthVerified: false,
        note: 'A runtime token is configured but no handle is registered in this process (RUFLO_RUNTIME_ENABLED is not true, or registration failed). Dispatch is refused.',
      };
    case 'NOT_CONFIGURED':
      return {
        state: status,
        label: 'RUFLO READY · NOT CONNECTED',
        tone: 'muted',
        healthVerified: false,
        note: 'Workflow contracts are ready for an external orchestrator; no runtime is configured.',
      };
  }
}
