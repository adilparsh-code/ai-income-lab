import { db } from '@/lib/db';
import { getOperationsSummary, type OperationsSummary } from '@/lib/product-factory/operations';
import { describeRufloRuntime } from '@/lib/ruflo/runtime';
import { describeAiCapability } from '@/lib/ai/capability';
import { describeResearchProviderHealth } from '@/lib/research/provider';
import { describePublishingStatus } from '@/lib/publishing/contract';
import { describeVercelConfig } from '@/lib/product-factory/deployment-vercel';
import { listDeadLetters } from './failure-recovery';
import { getLoopTransitions } from './loop-controller';

export type ExternalStatus = 'LIVE' | 'MOCKED' | 'SIMULATED' | 'NOT_CONFIGURED' | 'NOT_CONNECTED' | 'BLOCKED' | 'AWAITING_HUMAN_INPUT' | 'UNAVAILABLE';

export interface Phase8OperationsSummary extends OperationsSummary {
  systemHealth: {
    database: ExternalStatus;
    ai: ExternalStatus;
    research: ExternalStatus;
    ruflo: ExternalStatus;
    publishing: ExternalStatus;
    deployment: ExternalStatus;
  };
  missions: { total: number; queued: number; running: number; humanReview: number; failed: number; deadLetters: number };
  loopActivity: { transitions: number; blocked: number; humanReview: number; awaitingHumanInput: number; latest: Awaited<ReturnType<typeof getLoopTransitions>>[number] | null };
  simulated: { available: boolean; label: 'SIMULATED'; note: string };
  timeline: { id: string; kind: string; status: string; detail: string; at: string }[];
}

function mapResearch(status: string): ExternalStatus { return status === 'AVAILABLE' ? 'LIVE' : status === 'DEGRADED' ? 'UNAVAILABLE' : 'NOT_CONNECTED'; }
function mapRuflo(status: string): ExternalStatus { return status === 'CONNECTED' ? 'LIVE' : status === 'ERROR' ? 'UNAVAILABLE' : status === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'NOT_CONNECTED'; }

export async function getPhase8OperationsSummary(): Promise<Phase8OperationsSummary> {
  const base = await getOperationsSummary();
  const [database, missions, deadLetters, transitions, ruflo, ai, research, publishing, deployment] = await Promise.all([
    db.opportunity.count({ take: 1 }).then(() => 'LIVE' as ExternalStatus).catch(() => 'UNAVAILABLE' as ExternalStatus),
    db.agentMission.groupBy({ by: ['status'], _count: { _all: true } }),
    listDeadLetters(50).catch(() => []),
    db.loopTransition.findMany({ orderBy: { executedAt: 'desc' }, take: 20, select: { id: true, fromStage: true, toStage: true, reason: true, evidence: true, evidenceType: true, correlationId: true, executionStatus: true, executedAt: true } }),
    describeRufloRuntime().catch(() => ({ status: 'NOT_CONFIGURED' as const, detail: 'Runtime status unavailable.' })),
    Promise.resolve(describeAiCapability()),
    Promise.resolve(describeResearchProviderHealth()),
    Promise.resolve(describePublishingStatus()),
    Promise.resolve(describeVercelConfig()),
  ]);
  const counts = new Map(missions.map((m) => [m.status, m._count._all]));
  const statusCount = (status: string) => counts.get(status) ?? 0;
  const latest = transitions[0] ?? null;
  const timeline = transitions.map((t) => ({ id: t.id, kind: t.executionStatus === 'HUMAN_REVIEW' ? 'Human review required' : t.executionStatus === 'BLOCKED' ? 'Execution blocked' : 'Next action generated', status: t.executionStatus, detail: t.reason, at: t.executedAt.toISOString() }));
  return {
    ...base,
    systemHealth: { database, ai: ai.status === 'LIVE' ? 'LIVE' : ai.status === 'MOCKED' ? 'MOCKED' : ai.status === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'UNAVAILABLE', research: mapResearch(research.status), ruflo: mapRuflo(ruflo.status), publishing: publishing.status === 'AVAILABLE' ? 'LIVE' : publishing.status === 'PUBLISHING_READY' ? 'NOT_CONFIGURED' : 'NOT_CONNECTED', deployment: deployment.connected ? 'LIVE' : 'NOT_CONNECTED' },
    missions: { total: missions.reduce((sum, m) => sum + m._count._all, 0), queued: statusCount('QUEUED') + statusCount('READY'), running: statusCount('RUNNING'), humanReview: statusCount('HUMAN_REVIEW'), failed: statusCount('FAILED'), deadLetters: deadLetters.length },
    loopActivity: { transitions: transitions.length, blocked: transitions.filter((t) => t.executionStatus === 'BLOCKED').length, humanReview: transitions.filter((t) => t.executionStatus === 'HUMAN_REVIEW').length, awaitingHumanInput: transitions.filter((t) => t.executionStatus === 'AWAITING_HUMAN_INPUT').length, latest },
    simulated: { available: true, label: 'SIMULATED', note: 'Simulation mode is deterministic and never creates real revenue or external actions.' },
    timeline,
  };
}
