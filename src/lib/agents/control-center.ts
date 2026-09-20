// Phase 6 — Server loader for the Intelligent Agent Control Center.
//
// Selects the highest-priority actionable opportunity (same deterministic
// policy family as the dashboard's next-best-action) and assembles its shared
// agent context + deterministic intelligence view. Everything shown in the UI
// comes from stored records; nothing is fabricated. Failures degrade to null —
// never a fabricated intelligence view.

import { db } from '@/lib/db';
import { buildAgentContext } from './agent-context';
import { buildIntelligenceView, type IntelligenceView } from './intelligence';
import { getExecutionMode } from './agent-ai';
import { isRufloConnected } from '@/lib/ruflo/connector';

export interface ControlCenterView {
  opportunity: {
    id: string;
    title: string;
    status: string;
    halalStatus: string;
    overallScore: number;
  } | null;
  currentStage: string;
  nextStep: {
    action: string;
    agent: string | null;
    reason: string;
    humanApprovalRequired: boolean;
    requiresAi: boolean;
  } | null;
  evidenceStrength: { strength: string; basis: string } | null;
  conflicts: {
    hasConflict: boolean;
    description: string | null;
    safeAction: string;
    positions: { agent: string; signal: string; evidenceType: string }[];
  } | null;
  missingEvidence: string[];
  businessMemory: { label: string; text: string; evidenceType: string }[];
  handoffCount: number;
  provenance: { verified: number; userEntered: number; aiInference: number; mocked: number };
  humanReview: { required: boolean; reason: string | null };
  ruflo: { status: 'RUFLO_READY' | 'RUFLO_CONNECTED'; connected: boolean; note: string };
  aiProvider: { provider: string; isLive: boolean; capabilityStatus: string };
  latestDecision: { decision: string; action: string; recordedAt: string } | null;
  assembledAt: string;
}

/** Stage label derived deterministically from recorded state. */
function stageFromContext(view: IntelligenceView): string {
  switch (view.routing.action) {
    case 'RESEARCH':
      return 'Research';
    case 'VALIDATE':
    case 'RUN_EXPERIMENT':
      return 'Validation';
    case 'BUILD_PRODUCT':
      return 'Product';
    case 'CONNECT_PUBLISHING':
      return 'Publishing (not connected)';
    case 'ANALYZE':
    case 'REVIEW_REVENUE':
      return 'Analytics';
    case 'COLLECT_DATA':
      return 'Data Collection';
    case 'HUMAN_REVIEW':
      return 'Human Review';
    case 'BLOCKED':
      return 'Blocked';
    case 'NO_ACTION':
      return 'Idle';
  }
}

export async function getControlCenterView(): Promise<ControlCenterView | null> {
  try {
    const opportunity = await db.opportunity.findFirst({
      where: {
        status: { notIn: ['REJECTED', 'PAUSED'] },
        halalStatus: { not: 'NOT_ALLOWED' },
      },
      orderBy: { overallScore: 'desc' },
    });

    const mode = getExecutionMode();
    const ruflo = {
      status: (isRufloConnected() ? 'RUFLO_CONNECTED' : 'RUFLO_READY') as 'RUFLO_READY' | 'RUFLO_CONNECTED',
      connected: isRufloConnected(),
      note: isRufloConnected()
        ? 'A Ruflo orchestrator handle is registered server-side.'
        : 'Job contract ready; no Ruflo orchestrator is connected. Nothing runs autonomously.',
    };

    if (!opportunity) {
      return {
        opportunity: null,
        currentStage: 'Idle',
        nextStep: null,
        evidenceStrength: null,
        conflicts: null,
        missingEvidence: [],
        businessMemory: [],
        handoffCount: 0,
        provenance: { verified: 0, userEntered: 0, aiInference: 0, mocked: 0 },
        humanReview: { required: false, reason: null },
        ruflo,
        aiProvider: { provider: mode.provider, isLive: mode.isLive, capabilityStatus: mode.capabilityStatus },
        latestDecision: null,
        assembledAt: new Date().toISOString(),
      };
    }

    const ctx = await buildAgentContext(opportunity.id);
    const view = buildIntelligenceView(ctx);

    const latestDecision = ctx.previousDecisions[0] ?? null;

    return {
      opportunity: {
        id: opportunity.id,
        title: opportunity.title,
        status: opportunity.status,
        halalStatus: opportunity.halalStatus,
        overallScore: opportunity.overallScore,
      },
      currentStage: stageFromContext(view),
      nextStep: view.nextStep,
      evidenceStrength: {
        strength: ctx.evidenceStrength.strength,
        basis: ctx.evidenceStrength.basis,
      },
      conflicts: {
        hasConflict: view.conflicts.hasConflict,
        description: view.conflicts.conflictDescription,
        safeAction: view.conflicts.safeAction,
        positions: view.conflicts.considered.map((p) => ({
          agent: p.agent,
          signal: p.signal,
          evidenceType: p.evidenceType,
        })),
      },
      missingEvidence: ctx.missingEvidence,
      businessMemory: ctx.businessMemory.slice(0, 6),
      handoffCount: ctx.handoffs.length,
      provenance: ctx.provenance,
      humanReview: {
        required: view.nextStep.humanApprovalRequired || ctx.humanReviewState.required,
        reason: ctx.humanReviewState.reason ?? (view.nextStep.humanApprovalRequired ? 'Conflict resolution requires human review.' : null),
      },
      ruflo,
      aiProvider: { provider: mode.provider, isLive: mode.isLive, capabilityStatus: mode.capabilityStatus },
      latestDecision: latestDecision
        ? { decision: latestDecision.decision, action: latestDecision.action, recordedAt: latestDecision.recordedAt }
        : null,
      assembledAt: ctx.assembledAt,
    };
  } catch (error) {
    console.error('Control-center assembly failed:', error);
    return null;
  }
}
