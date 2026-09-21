// Phase 4.5.2 — Job registry facade: read-side access to job activity.
//
// Pure listing/metadata over the JobRun store. No execution happens here —
// the only execution path is runJob()/retryJob() in job-runner.ts, which go
// through the AgentRegistry and its safety gates.

import type { JobExecutionMode, JobStatus, RufloIntegrationStatus } from './types';

export interface JobActivityRow {
  id: string;
  jobType: string;
  status: string;
  correlationId: string;
  opportunityId: string | null;
  agentType: string | null;
  output: string | null;
  error: string | null;
  retryCount: number;
  executionMode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface JobActivityItem {
  id: string;
  jobType: string;
  status: JobStatus;
  agentType: string | null;
  opportunityId: string | null;
  executionMode: JobExecutionMode | null;
  /** Degraded/fallback marker derived from status, never invented. */
  degraded: boolean;
  blocked: boolean;
  humanReview: boolean;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface JobRegistryDb {
  jobRun: {
    findMany(args: {
      where?: { status?: { notIn: string[] } };
      orderBy: { createdAt: 'desc' };
      take: number;
    }): Promise<JobActivityRow[]>;
  };
}

/** Lazy proxy over the real Prisma client (same pattern as src/lib/db.ts). */
const defaultDb = new Proxy({} as JobRegistryDb, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('@/lib/db') as { db: unknown };
    const client = db as unknown as JobRegistryDb;
    const value = Reflect.get(client as object, prop);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

/** Compact, safe activity items for dashboards. No payloads, no secrets. */
export async function getRecentJobActivity(limit = 8): Promise<JobActivityItem[]> {
  const rows = await defaultDb.jobRun.findMany({
    where: { status: { notIn: ['QUEUED'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    jobType: row.jobType,
    status: row.status as JobStatus,
    agentType: row.agentType,
    opportunityId: row.opportunityId,
    executionMode: (row.executionMode as JobExecutionMode | null) ?? null,
    degraded: row.status === 'DEGRADED',
    blocked: row.status === 'BLOCKED',
    humanReview: row.status === 'HUMAN_REVIEW',
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    error: row.error ? String(row.error).slice(0, 200) : null,
  }));
}

export interface RufloIntegrationInfo {
  status: RufloIntegrationStatus;
  /** True only when an adapter is wired to a real orchestrator (never yet). */
  connected: boolean;
  description: string;
  /** The stable entry points a future adapter will call. */
  contract: {
    runJob: string;
    executeWorkflow: string;
  };
}

/**
 * Ruflo integration boundary status. The contract (runJob/executeWorkflow over
 * the job runner) exists and is tested; the adapter is deliberately
 * NOT_CONNECTED — nothing here claims autonomy or background scheduling.
 */
export function describeRufloIntegration(): RufloIntegrationInfo {
  return {
    status: 'RUFLO_READY',
    connected: false,
    description:
      'Job contract and runner are ready for an external orchestrator. Ruflo is not installed or connected; '
        + 'nothing runs autonomously. Publishing, spending, and irreversible actions remain human-gated.',
    contract: {
      runJob: 'runJob(jobType, payload, correlationId?)',
      executeWorkflow: "runJob('OPPORTUNITY_PIPELINE', payload, correlationId?)",
    },
  };
}
