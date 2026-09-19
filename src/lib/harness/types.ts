// Phase 4.3 — dual harness contracts.
//
// Ruflo and Prime Agent are external orchestration runtimes. This module keeps
// their integration provider-neutral and prevents either harness from becoming
// a second business-logic engine.
//
// AI Income Lab remains authoritative for workflow execution, halal gates,
// lifecycle transitions, idempotency, budgets, auditability, and publishing
// approval. Harnesses may coordinate work, but they cannot bypass those rules.

export type HarnessId = 'ruflo' | 'prime-agent';

export type HarnessConnectionStatus =
  | 'READY'
  | 'NOT_CONNECTED'
  | 'CONNECTED';

export interface HarnessCompletionSummary {
  workflowId: string;
  workflowType: string;
  status: string;
  correlationId: string;
  stepCount: number;
  completedAt: string;
}

export interface HarnessWorkflowRequest {
  workflowType: string;
  objective: string;
  opportunityId?: string;
  correlationId?: string;
}

export interface HarnessRegistration {
  id: string;
  registeredAt: string;
}

export interface HarnessCapability {
  id: HarnessId;
  name: string;
  status: HarnessConnectionStatus;
  detail: string;
  externalRuntimeRequired: boolean;
  preservesApplicationGates: boolean;
}
