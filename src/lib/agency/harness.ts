// ============================================================================
// AGENCY — HARNESS BOUNDARY (Supervisor/Harness boundary, honest states)
// ============================================================================
// The supervisor contract names an optional external Harness adapter ("Agent
// Supervisor / Harness Adapter"). This module is the CLEAN integration
// boundary for that adapter — nothing more. It deliberately:
//
//   - NEVER executes agents, jobs, or AI calls (no execution authority),
//   - NEVER bypasses the Job Runner, halal gates, budgets, authorization, or
//     audit (it can only READ bounded, already-persisted evidence),
//   - reports NOT_CONNECTED until a real harness adapter is registered
//     server-side, exactly like the Ruflo connector's honesty rule,
//   - never fabricates a LIVE/CONNECTED status.
//
// An external evaluation harness that is later wired here receives the same
// read-only evaluation snapshot the internal supervisor derives; it can
// enrich human review but can never mutate execution state.
// ============================================================================

import type { HarnessState } from './types';
import type { AgentRunView } from './runtime';

export interface RegisteredHarnessAdapter {
  /** Non-secret audit label of the external evaluation harness. */
  readonly id: string;
}

export interface HarnessRegistration {
  adapter: RegisteredHarnessAdapter;
  registeredAt: string;
}

let registered: HarnessRegistration | null = null;

/** Register a real harness adapter (server-side only, operator action). */
export function registerHarnessAdapter(adapter: RegisteredHarnessAdapter): { ok: boolean; error?: string } {
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, error: 'A harness adapter object is required.' };
  }
  if (typeof adapter.id !== 'string' || adapter.id.trim().length === 0 || adapter.id.length > 80) {
    return { ok: false, error: 'The harness adapter must carry a non-empty id of at most 80 characters (non-secret audit label).' };
  }
  registered = { adapter: { id: adapter.id.trim() }, registeredAt: new Date().toISOString() };
  return { ok: true };
}

export function getRegisteredHarnessAdapter(): HarnessRegistration | null {
  return registered;
}

/** Unregister (operator disconnect / test teardown). */
export function clearHarnessAdapter(): void {
  registered = null;
}

/** True only while a real adapter is registered. Never fabricated. */
export function isHarnessConnected(): boolean {
  return registered !== null;
}

export interface HarnessEvaluationSnapshot {
  /** Bounded, already-persisted runs (most recent first). Read-only. */
  recentRuns: {
    agentId: string;
    status: string;
    jobType: string;
    safetyVerdict: string | null;
    verification: string | null;
    correlationId: string;
    startedAt: string;
  }[];
  /** Supervisor verdicts observed across the same window (bounded). */
  verdictDistribution: Record<string, number>;
  generatedAt: string;
}

/**
 * Build the read-only evaluation snapshot an external harness would receive.
 * Data comes ONLY from recorded AgentRun rows — nothing is re-executed,
 * nothing is fabricated, and payloads/secrets are never included.
 */
export function buildHarnessSnapshot(runs: AgentRunView[]): HarnessEvaluationSnapshot {
  const verdictDistribution: Record<string, number> = {};
  for (const run of runs) {
    const key = run.status;
    verdictDistribution[key] = (verdictDistribution[key] ?? 0) + 1;
  }
  return {
    recentRuns: runs.slice(0, 50).map((run) => ({
      agentId: run.agentId,
      status: run.status,
      jobType: run.jobType,
      safetyVerdict: run.safetyVerdict,
      verification: run.verification,
      correlationId: run.correlationId,
      startedAt: run.startedAt,
    })),
    verdictDistribution,
    generatedAt: new Date().toISOString(),
  };
}

/** Boundary metadata for status surfaces. Mirrors the Ruflo honesty rule. */
export function describeHarnessBoundary(): { status: HarnessState; note: string } {
  if (!registered) {
    return {
      status: 'NOT_CONNECTED',
      note:
        'Harness integration boundary exists (registerHarnessAdapter) but no external evaluation harness is connected. '
          + 'The internal supervisor remains authoritative; nothing here claims external evaluation is active.',
    };
  }
  return {
    status: 'CONNECTED',
    note: `Harness adapter '${registered.adapter.id}' is registered server-side. It receives read-only evaluation snapshots only; it never executes agents and never bypasses the Job Runner, gates, budgets, or audit.`,
  };
}
