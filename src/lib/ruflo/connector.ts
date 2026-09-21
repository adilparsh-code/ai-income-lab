// Phase 5.5 — Ruflo connector (Part 4).
//
// The actual integration seam for a Ruflo orchestrator runtime. Ruflo NEVER
// executes agents, AI calls, or provider operations directly: the ONLY path
// is `dispatchWorkflowViaRuflo()` → the EXISTING `executeWorkflow()` → the
// EXISTING `runJob()` pipeline, where halal gates, human-review stops,
// lifecycle guards, idempotency, correlation IDs, bounded retries, AI budget
// controls, and audit logging live. A registered handle is a NOTIFICATION
// target and a dispatch entry point — never a bypass.
//
// Honesty: `RUFLO_CONNECTED` is reported only while a handle is actually
// registered (i.e. a real runtime was wired server-side by the operator or
// an integration). No package is installed here just for appearance; with no
// handle the status stays RUFLO_READY / NOT_CONNECTED.

import { executeWorkflow, type ExecuteWorkflowInput, type ExecuteWorkflowOptions } from './workflow-runner';

export interface RufloWorkflowRequest {
  workflowType: ExecuteWorkflowInput['workflowType'];
  objective: string;
  opportunityId?: string;
  correlationId?: string;
}

/**
 * Phase 5.5 — deterministic learning-loop enrichment: when the workflow was
 * a product launch, its PRODUCT_ANALYZE summary (AI-free growth
 * classification from recorded data) is forwarded so the orchestrator's
 * Business-Manager layer can learn from actual outcomes. Present only when
 * a real step summary exists — never fabricated.
 */
export interface RufloProductAnalysis {
  evidenceState?: string;
  recommendedAction?: string;
  dataStatus?: string;
  recordedVisitors?: number;
  visitorEvidenceStatus?: string;
}

/**
 * What a real Ruflo runtime provides when wired server-side. `id` is a
 * non-secret label used for audit; hooks are optional and receive bounded,
 * secret-free summaries only.
 */
export interface RufloOrchestratorHandle {
  readonly id: string;
  /** Optional: Ruflo-side notification of a completed (or stopped) workflow. */
  onWorkflowCompleted?(summary: {
    workflowId: string;
    workflowType: string;
    status: string;
    correlationId: string;
    stepCount: number;
    completedAt: string;
    /** Deterministic product analysis when a PRODUCT_ANALYZE step ran. */
    productAnalysis?: RufloProductAnalysis;
  }): void;
}

export interface RufloRegistration {
  handle: RufloOrchestratorHandle;
  registeredAt: string;
}

let registered: RufloRegistration | null = null;

/** Register a real Ruflo runtime handle (server-side only). */
export function registerRufloOrchestrator(handle: RufloOrchestratorHandle): { ok: boolean; error?: string } {
  if (!handle || typeof handle !== 'object') {
    return { ok: false, error: 'A Ruflo orchestrator handle object is required.' };
  }
  if (typeof handle.id !== 'string' || handle.id.trim().length === 0) {
    return { ok: false, error: 'The Ruflo orchestrator handle must carry a non-empty id (non-secret audit label).' };
  }
  registered = { handle, registeredAt: new Date().toISOString() };
  return { ok: true };
}

export function getRegisteredRufloOrchestrator(): RufloRegistration | null {
  return registered;
}

/** Unregister (operator disconnect / test teardown). */
export function clearRufloOrchestrator(): void {
  registered = null;
}

/** True only while a real handle is registered. */
export function isRufloConnected(): boolean {
  return registered !== null;
}

/**
 * Dispatch a workflow on behalf of a Ruflo orchestrator. Execution ALWAYS
 * happens inside the existing workflow runner — the same gates as any
 * internal caller. When a handle is registered, a bounded completion summary
 * is forwarded to it afterwards. Without a handle, the result is an honest
 * NOT_CONNECTED refusal: nothing executes, nothing is fabricated.
 */
export async function dispatchWorkflowViaRuflo(
  request: RufloWorkflowRequest,
  options: ExecuteWorkflowOptions = {},
): Promise<
  | { accepted: false; status: 'NOT_CONNECTED'; reason: string }
  | { accepted: true; execution: Awaited<ReturnType<typeof executeWorkflow>> }
> {
  const registration = getRegisteredRufloOrchestrator();
  if (!registration) {
    return {
      accepted: false,
      status: 'NOT_CONNECTED',
      reason:
        'No Ruflo orchestrator handle is registered. Nothing was executed. '
        + 'Register a runtime handle server-side to enable orchestration through the workflow boundary.',
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

  // Notification only — the handle never re-executes or alters the result.
  // Learning-loop enrichment: surface the deterministic product analysis if a
  // PRODUCT_ANALYZE step actually produced one (real step output, no invention).
  const analyzeSummary = execution.steps.find((s) => s.jobType === 'PRODUCT_ANALYZE')?.summary as
    | { evidenceState?: unknown; recommendedAction?: unknown; dataStatus?: unknown; recordedVisitors?: unknown; visitorEvidenceStatus?: unknown }
    | null
    | undefined;
  const productAnalysis: RufloProductAnalysis | undefined = analyzeSummary
    ? {
        ...(typeof analyzeSummary.evidenceState === 'string' ? { evidenceState: analyzeSummary.evidenceState } : {}),
        ...(typeof analyzeSummary.recommendedAction === 'string' ? { recommendedAction: analyzeSummary.recommendedAction } : {}),
        ...(typeof analyzeSummary.dataStatus === 'string' ? { dataStatus: analyzeSummary.dataStatus } : {}),
        ...(typeof analyzeSummary.recordedVisitors === 'number' ? { recordedVisitors: analyzeSummary.recordedVisitors } : {}),
        ...(typeof analyzeSummary.visitorEvidenceStatus === 'string' ? { visitorEvidenceStatus: analyzeSummary.visitorEvidenceStatus } : {}),
      }
    : undefined;

  try {
    registration.handle.onWorkflowCompleted?.({
      workflowId: execution.workflowId,
      workflowType: execution.workflowType,
      status: execution.status,
      correlationId: execution.correlationId,
      stepCount: execution.steps.length,
      completedAt: execution.completedAt,
      ...(productAnalysis && Object.keys(productAnalysis).length > 0 ? { productAnalysis } : {}),
    });
  } catch {
    // A broken notification channel must never corrupt the workflow result.
  }

  return { accepted: true, execution };
}
