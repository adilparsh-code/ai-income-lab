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
import { getRegisteredRufloOrchestrator } from './connector';

export type RufloConnectionStatus = 'RUFLO_READY' | 'NOT_CONNECTED' | 'RUFLO_CONNECTED';

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
 * A real Ruflo integration means a handle is actually registered server-side
 * (via registerRufloOrchestrator). No package was installed merely for
 * appearance; the honest default remains disconnected.
 */
function rufloRuntimeAvailable(): boolean {
  return getRegisteredRufloOrchestrator() !== null;
}

export function describeRufloIntegration(): RufloIntegrationStatus {
  const runtimeAvailable = rufloRuntimeAvailable();
  const boundary = describeWorkflowBoundary();

  if (runtimeAvailable) {
    const registration = getRegisteredRufloOrchestrator()!;
    return {
      status: 'RUFLO_CONNECTED',
      detail: `A Ruflo orchestrator handle (id: ${registration.handle.id}) is registered server-side. ` +
        'All orchestration flows through the AI Income Lab workflow boundary — gates, budgets, and audit trails remain mandatory.',
      unmetRequirements: [],
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

  const unmetRequirements: RufloRequirement[] = [
    {
      id: 'ruflo-runtime',
      description: 'No Ruflo orchestrator handle is registered server-side (registerRufloOrchestrator).',
      satisfied: false,
    },
  ];

  return {
    status: 'NOT_CONNECTED',
    detail: 'Ruflo is RUFLO_READY at the contract level (workflows, jobs, and gates exist and are tested) '
      + 'but NOT_CONNECTED: no orchestrator runtime handle is registered. Nothing in this repository '
      + 'claims live orchestration.',
    unmetRequirements: unmetRequirements.map((r) => r.description),
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
