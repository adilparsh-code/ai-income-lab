// Phase 4.3 — Prime Agent connector boundary.
//
// Prime Agent supports headless JSON/RPC operation, persistent sessions,
// autonomous bounded runs, and recursive subagents. AI Income Lab does NOT
// embed Prime Agent or execute its shell/runtime from request handlers.
// Instead, a trusted server-side integration may register a handle.
//
// The registered handle is the only Prime Agent dispatch seam. Actual business
// execution is always delegated to the existing workflow runner, so Prime
// Agent cannot bypass halal gates, lifecycle guards, idempotency, budgets,
// publishing approval, or audit trails.

import {
  executeWorkflow,
  type ExecuteWorkflowOptions,
} from '@/lib/ruflo/workflow-runner';
import { isWorkflowType } from '@/lib/ruflo/workflows';
import type {
  HarnessCompletionSummary,
  HarnessWorkflowRequest,
} from './types';

export interface PrimeAgentHandle {
  readonly id: string;
  /** Optional bounded notification after a workflow finishes. */
  onWorkflowCompleted?(summary: HarnessCompletionSummary): void;
}

export interface PrimeAgentRegistration {
  handle: PrimeAgentHandle;
  registeredAt: string;
}

let registered: PrimeAgentRegistration | null = null;

/** Server-side operator action only. Never expose registration over HTTP. */
export function registerPrimeAgent(handle: PrimeAgentHandle): { ok: boolean; error?: string } {
  if (!handle || typeof handle !== 'object') {
    return { ok: false, error: 'A Prime Agent handle object is required.' };
  }

  if (typeof handle.id !== 'string' || handle.id.trim().length === 0) {
    return {
      ok: false,
      error: 'The Prime Agent handle must have a non-empty non-secret id.',
    };
  }

  registered = {
    handle,
    registeredAt: new Date().toISOString(),
  };

  return { ok: true };
}

export function getRegisteredPrimeAgent(): PrimeAgentRegistration | null {
  return registered;
}

export function clearPrimeAgent(): void {
  registered = null;
}

export function isPrimeAgentConnected(): boolean {
  return registered !== null;
}

export function describePrimeAgent(): {
  status: 'READY' | 'NOT_CONNECTED' | 'CONNECTED';
  detail: string;
} {
  if (registered) {
    return {
      status: 'CONNECTED',
      detail:
        'A Prime Agent runtime handle is registered server-side. Workflow execution remains inside the AI Income Lab boundary.',
    };
  }

  return {
    status: 'NOT_CONNECTED',
    detail:
      'Prime Agent integration is contract-ready but no trusted runtime handle is registered.',
  };
}

/**
 * Execute one workflow through the application-owned runner after a Prime
 * Agent runtime has been registered.
 *
 * This function deliberately accepts only the existing workflow contract;
 * it cannot accept arbitrary shell commands, arbitrary code, credentials, or
 * provider-specific execution instructions.
 */
export async function dispatchWorkflowViaPrimeAgent(
  request: HarnessWorkflowRequest,
  options: ExecuteWorkflowOptions = {},
): Promise<
  | { accepted: false; status: 'NOT_CONNECTED' | 'INVALID_WORKFLOW'; reason: string }
  | { accepted: true; execution: Awaited<ReturnType<typeof executeWorkflow>> }
> {
  const registration = getRegisteredPrimeAgent();

  if (!registration) {
    return {
      accepted: false,
      status: 'NOT_CONNECTED',
      reason:
        'No Prime Agent runtime handle is registered. Nothing was executed.',
    };
  }

  if (!isWorkflowType(request.workflowType)) {
    return {
      accepted: false,
      status: 'INVALID_WORKFLOW',
      reason: 'Workflow type is not registered in AI Income Lab.',
    };
  }

  const execution = await executeWorkflow(
    {
      workflowType: request.workflowType,
      objective: request.objective,
      ...(request.opportunityId ? { opportunityId: request.opportunityId } : {}),
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
    },
    options,
  );

  try {
    registration.handle.onWorkflowCompleted?.({
      workflowId: execution.workflowId,
      workflowType: execution.workflowType,
      status: execution.status,
      correlationId: execution.correlationId,
      stepCount: execution.steps.length,
      completedAt: execution.completedAt,
    });
  } catch {
    // Notification failure never changes the authoritative workflow result.
  }

  return { accepted: true, execution };
}
