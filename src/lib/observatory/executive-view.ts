// Phase 10.12 / 10.13 — Executive "What is the AI doing now?" view and the
// deterministic "What should I do next?" panel.
//
// Both are pure compositions over the other observatory read models. Every
// answer traces to persisted rows; unknown states are labelled, not filled.

import { db } from '@/lib/db';
import { getAgentObservations } from './agent-overview';
import { getLearningObservations } from './learning';
import { getPnlObservatory } from './pnl';
import { getPublishingRows } from './safety-map';
import type { DataQuality, ExecutiveNow, NextAction, NextActionsView } from './types';

export async function getExecutiveNow(): Promise<ExecutiveNow> {
  const [{ agents, paused }, learning, pnl, publishing] = await Promise.all([
    getAgentObservations(),
    getLearningObservations(8),
    getPnlObservatory(),
    getPublishingRows(8),
  ]);

  const active = agents
    .filter((a) => a.currentRun)
    .map((a) => ({
      agentId: a.agentId,
      jobType: a.currentRun!.jobType,
      stage: a.currentRun!.stage,
      correlationId: a.currentRun!.correlationId,
      startedAt: a.currentRun!.startedAt,
    }));

  const research = agents
    .filter((a) => a.currentRun?.jobType === 'RESEARCH' || a.lastRun?.jobType === 'RESEARCH')
    .slice(0, 4)
    .map((a) => ({
      label: `${a.agentId}: ${a.currentRun ? `running stage ${a.currentRun.stage}` : `last run ${a.lastRun?.status ?? 'unknown'}`}`,
      detail: a.currentRun?.correlationId ?? a.lastRun?.correlationId ?? 'no correlation recorded',
      entityRef: a.currentRun?.id ?? a.lastRun?.id ?? null,
    }));

  const build = agents
    .filter((a) => a.currentRun?.jobType === 'PRODUCT' || a.lastRun?.jobType === 'PRODUCT')
    .slice(0, 4)
    .map((a) => ({
      label: `${a.agentId}: ${a.currentRun ? `building (stage ${a.currentRun.stage})` : `last build run ${a.lastRun?.status ?? 'unknown'}`}`,
      detail: a.currentRun?.correlationId ?? a.lastRun?.correlationId ?? 'no correlation recorded',
      entityRef: a.currentRun?.id ?? a.lastRun?.id ?? null,
    }));

  const publish = publishing.rows
    .filter((r) => r.publishState !== 'NOT_PUBLISHED_NO_DEPLOYMENT_RECORD' || r.status === 'PUBLISHED')
    .slice(0, 5)
    .map((r) => ({
      label: `${r.productName}: ${r.publishState}`,
      detail: r.destination ? `destination ${r.destination}` : 'no destination recorded',
      state: r.publishState,
      entityRef: r.productId,
    }));

  const trafficSources = new Map<string, number>();
  for (const row of pnl.bySource) trafficSources.set(row.key, row.entries);

  const revenueTop = pnl.bySource.slice(0, 4).map((row) => ({
    label: `${row.key}: gross ${row.grossRevenueUsd}`,
    amountUsd: row.grossRevenueUsd,
    quality: (pnl.totals.grossRevenueUsd.label) as DataQuality,
    entityRef: null,
  }));

  return {
    active,
    research,
    build,
    publish,
    traffic: [...trafficSources.entries()].slice(0, 4).map(([source, entries]) => ({
      source,
      visitors: entries,
      label: `${entries} recorded revenue row(s) via ${source}`,
      quality: 'REAL' as DataQuality,
    })),
    conversion: pnl.bySource.slice(0, 4).map((row) => ({
      label: `${row.key}: ${row.entries} recorded row(s); per-product purchase counts live in ProductEvent`,
      conversions: row.entries,
      quality: 'REAL' as DataQuality,
      entityRef: null,
    })),
    revenue: revenueTop.length > 0 ? revenueTop : [{ label: 'No revenue rows recorded', amountUsd: 0, quality: 'UNKNOWN', entityRef: null }],
    learning: learning.entries.slice(0, 5).map((l) => ({
      label: l.hypothesis.slice(0, 120),
      epistemicState: l.epistemicState,
      confidence: l.confidence,
      ref: `LearningEntry:${l.id}`,
    })),
    risks: buildRisks(agents, pnl, paused),
    next: { label: 'See the next-action panel', reason: 'Composed deterministically in getNextActions().', ref: null, humanApprovalRequired: false },
  };
}

function buildRisks(
  agents: Awaited<ReturnType<typeof getAgentObservations>>['agents'],
  pnl: Awaited<ReturnType<typeof getPnlObservatory>>,
  paused: boolean,
): ExecutiveNow['risks'] {
  const risks: ExecutiveNow['risks'] = [];
  if (paused) risks.push({ severity: 'HIGH', label: 'Agency is PAUSED — all execution held.', ref: 'AgencyControl:autonomy' });
  for (const a of agents) {
    if (a.runs.humanReview > 0) risks.push({ severity: 'HIGH', label: `${a.agentId} has ${a.runs.humanReview} run(s) in HUMAN_REVIEW.`, ref: `AgentRun:${a.lastRun?.id ?? ''}` });
    if (a.runs.blocked > 0) risks.push({ severity: 'MEDIUM', label: `${a.agentId} has ${a.runs.blocked} blocked run(s).`, ref: `AgentRun:${a.lastRun?.id ?? ''}` });
    if (a.healthState === 'FAILED' || a.healthState === 'BLOCKED') risks.push({ severity: 'MEDIUM', label: `${a.agentId} health is ${a.healthState}.`, ref: `AgentHealth:${a.agentId}` });
  }
  for (const row of pnl.byProduct) {
    if (row.entries > 0 && row.netRevenueUsd < 0) {
      risks.push({ severity: 'MEDIUM', label: `Product ${row.key} has negative tracked contribution (${row.netRevenueUsd}).`, ref: `Product:${row.key}` });
    }
  }
  return risks.slice(0, 8);
}

export async function getNextActions(): Promise<NextActionsView> {
  const actions: NextAction[] = [];
  const [{ agents, paused }, learning, pnl, publishing, reviews] = await Promise.all([
    getAgentObservations(),
    getLearningObservations(10),
    getPnlObservatory(),
    getPublishingRows(10),
    db.humanReview.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 5, select: { id: true, category: true, title: true } }),
  ]);

  for (const r of reviews) {
    actions.push({
      priority: 0,
      category: 'HUMAN_REVIEW',
      label: `Review pending ${r.category.toLowerCase()}: ${r.title.slice(0, 80)}`,
      reason: 'A HumanReview row is PENDING; governed actions wait on this decision.',
      ref: `HumanReview:${r.id}`,
      humanApprovalRequired: true,
    });
  }

  if (paused) {
    actions.push({
      priority: 1,
      category: 'GOVERNANCE',
      label: 'Agency is paused — resume or keep held deliberately.',
      reason: 'AgencyControl.paused is true; all governed execution is held.',
      ref: 'AgencyControl:autonomy',
      humanApprovalRequired: true,
    });
  }

  for (const a of agents) {
    if (a.runs.humanReview > 0) {
      actions.push({
        priority: 2,
        category: 'AGENT_REVIEW',
        label: `Review ${a.agentId} run in HUMAN_REVIEW (${a.runs.humanReview}).`,
        reason: 'AgentRun status HUMAN_REVIEW blocks the pipeline until decided.',
        ref: a.lastRun ? `AgentRun:${a.lastRun.id}` : null,
        humanApprovalRequired: true,
      });
    }
    if (a.runs.failed > 0) {
      actions.push({
        priority: 4,
        category: 'OPS',
        label: `Investigate ${a.runs.failed} failed run(s) for ${a.agentId}.`,
        reason: 'FailureRecord/recovery paths exist; failed runs may need retries or rollback.',
        ref: a.lastRun ? `AgentRun:${a.lastRun.id}` : null,
        humanApprovalRequired: false,
      });
    }
  }

  for (const row of publishing.rows) {
    if (row.publishState === 'DEPLOYMENT_NOT_CONNECTED') {
      actions.push({
        priority: 5,
        category: 'CONFIG',
        label: `Product "${row.productName.slice(0, 60)}" cannot deploy: deployment provider not connected.`,
        reason: 'Latest ProductDeployment row is DEPLOYMENT_NOT_CONNECTED; no publication is possible.',
        ref: `Product:${row.productId}`,
        humanApprovalRequired: false,
      });
      break; // one representative action is enough
    }
  }

  if (publishing.providerState.state === 'NOT_CONNECTED') {
    actions.push({
      priority: 6,
      category: 'CONFIG',
      label: 'Connect a publishing provider (currently NOT_CONNECTED).',
      reason: publishing.providerState.detail,
      ref: null,
      humanApprovalRequired: false,
    });
  }

  for (const row of pnl.byProduct) {
    if (row.entries > 0 && row.netRevenueUsd < 0) {
      actions.push({
        priority: 3,
        category: 'FINANCE',
        label: `Investigate negative contribution on product ${row.key} (${row.netRevenueUsd}).`,
        reason: 'Tracked costs exceed net revenue on recorded rows.',
        ref: `Product:${row.key}`,
        humanApprovalRequired: false,
      });
    }
  }

  const hypothesisCount = learning.counts.HYPOTHESIS + learning.counts.UNVERIFIED;
  if (hypothesisCount > 0) {
    actions.push({
      priority: 7,
      category: 'LEARNING',
      label: `Review ${hypothesisCount} learning entr(ies) not yet evidence-validated.`,
      reason: 'Hypotheses and unverified entries must not drive decisions without evidence.',
      ref: learning.entries[0] ? `LearningEntry:${learning.entries[0].id}` : null,
      humanApprovalRequired: false,
    });
  }

  if (pnl.unallocatedEntries > 0) {
    actions.push({
      priority: 8,
      category: 'DATA_QUALITY',
      label: `Attribute ${pnl.unallocatedEntries} revenue row(s) lacking product/opportunity links.`,
      reason: 'Unallocated revenue cannot be traced to a source; attribution is currently UNATTRIBUTED.',
      ref: null,
      humanApprovalRequired: false,
    });
  }

  actions.push({
    priority: 9,
    category: 'INTEGRATION',
    label: 'AIAgent HIGH-1 integration is NOT_CONFIGURED (receiver ready, no verified sender).',
    reason: 'Endpoint /api/handoff/receive exists; first authenticated delivery has not occurred.',
    ref: null,
    humanApprovalRequired: false,
  });

  actions.sort((a, b) => a.priority - b.priority || a.category.localeCompare(b.category));
  return {
    generatedAt: new Date().toISOString(),
    actions: actions.slice(0, 12),
    paused,
  };
}
