// Phase 5.4 — Ruflo integration capability discovery (Part 8).
//
// Ruflo remains RUFLO_READY / NOT_CONNECTED: no Ruflo package, credential, or
// runtime exists in this environment, and none was installed merely for
// appearance. This module is the single honest capability surface a future
// integration (or a human operator) can query to see exactly what exists,
// what is missing, and what the existing job system still enforces even after
// Ruflo connects.
//
// The AI Income Lab job system remains authoritative for idempotency,
// correlation IDs, bounded retries, halal gates, lifecycle guards, and
// auditability. Ruflo would orchestrate THROUGH these, never around them.

import { describeWorkflowBoundary } from './workflow-runner';

export type RufloConnectionStatus = 'RUFLO_READY' | 'NOT_CONNECTED';

export interface RufloRequirement {
  id: string;
  description: string;
  satisfied: boolean;
}

export interface RufloIntegrationStatus {
  status: RufloConnectionStatus;
  /** Human-readable explanation of why the status is what it is. */
  detail: string;
  /** Concrete unmet requirements — empty when actually connected. */
  unmetRequirements: string[];
  /** What the boundary can accept today (workflow/job contracts). */
  availableContracts: string[];
  /** Invariants that persist even after a real Ruflo connection. */
  invariantsPreserved: string[];
}

/**
 * Detect a real Ruflo runtime. Absent an actual package/credential, this is
 * deterministically false — we do not pretend.
 */
function rufloRuntimeAvailable(): boolean {
  // A real integration would check for the Ruflo runtime/credential here
  // (e.g. an injected orchestrator handle or server-side credential). No such
  // dependency exists in this repository, so the honest answer is false.
  return false;
}

export function describeRufloIntegration(): RufloIntegrationStatus {
  const runtimeAvailable = rufloRuntimeAvailable();
  const boundary = describeWorkflowBoundary();

  const unmetRequirements: RufloRequirement[] = [
    {
      id: 'ruflo-runtime',
      description: 'Ruflo orchestrator runtime/package is not installed in this repository.',
      satisfied: runtimeAvailable,
    },
    {
      id: 'ruflo-credential',
      description: 'No Ruflo credential or endpoint is configured (server-side only, if added later).',
      satisfied: false,
    },
  ];

  const allSatisfied = unmetRequirements.every((r) => r.satisfied);

  return {
    status: allSatisfied ? 'RUFLO_READY' : 'NOT_CONNECTED',
    detail: allSatisfied
      ? 'Ruflo runtime and credentials detected; orchestration may proceed through the workflow boundary.'
      : 'Ruflo is RUFLO_READY at the contract level (workflows, jobs, and gates exist and are tested) '
        + 'but NOT_CONNECTED: no Ruflo runtime or credential exists. Nothing in this repository '
        + 'claims live orchestration.',
    unmetRequirements: unmetRequirements.filter((r) => !r.satisfied).map((r) => r.description),
    availableContracts: boundary.contract,
    invariantsPreserved: [
      'Idempotency and correlation IDs owned by the AI Income Lab job runner.',
      'Bounded retries — never infinite, never for deterministic failures.',
      'Halal gates: NOT_ALLOWED blocks before execution; REVIEW_REQUIRED requires human review.',
      'Lifecycle guards on every product/state transition.',
      'AI cost controls (dedup, cache, token budgets, model routing, treasury).',
      'Audit logging via AgentLog/JobRun/WorkflowRun.',
    ],
  };
}
