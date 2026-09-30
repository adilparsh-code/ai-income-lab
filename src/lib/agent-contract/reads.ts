// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — bounded reads + truthful health
// ============================================================================
// The minimum read interface a future agent needs. Every projection is a
// hand-picked allow-list of safe fields — never a raw Prisma row dump, never
// internal session tokens, never database credentials, never unnecessary
// personal data.
//
// Health states are computed from REAL facts only (config + DB reachability),
// never manually flipped: NOT_CONFIGURED → READY/DEGRADED is the honest
// progression, and no runtime is ever claimed LIVE without real verification.
// ============================================================================

import { db } from '@/lib/db';
import { agentCredentialStatus } from './credentials';

// ---------------------------------------------------------------------------
// Injectable DB surface (structural; tests inject a fake)
// ---------------------------------------------------------------------------

export interface ReadOpportunityRow {
  id: string;
  title: string;
  category: string;
  businessModel: string;
  targetAudience: string;
  problemSolved: string;
  monetizationMethod: string;
  halalStatus: string;
  status: string;
  overallScore: number;
  confidenceLevel: string;
  evidenceNotes: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReadExperimentRow {
  id: string;
  hypothesis: string;
  decision: string | null;
  visitors: number;
  revenue: number;
  updatedAt: Date;
}

export interface ReadRevenueRow {
  id: string;
  grossRevenue: number;
  netRevenue: number;
  currency: string;
  createdAt: Date;
}

export interface ReadsDb {
  opportunity: {
    findUnique(args: { where: { id: string } }): Promise<ReadOpportunityRow | null>;
  };
  experiment: {
    findMany(args: { where: { opportunityId: string }; orderBy: { updatedAt: 'desc' }; take: number }): Promise<ReadExperimentRow[]>;
  };
  revenue: {
    findMany(args: { where: { opportunityId: string }; orderBy: { createdAt: 'desc' }; take: number }): Promise<ReadRevenueRow[]>;
  };
}

const defaultDb = db as unknown as ReadsDb;

export type ReadProjection =
  | { found: true; data: Record<string, unknown> }
  | { found: false; reason: string };

/**
 * READ_OPPORTUNITY — bounded projection. Deliberately omits risks/evidence
 * internals, scores breakdown, and any operator-side fields.
 */
export async function readOpportunity(opportunityId: string, store: ReadsDb = defaultDb): Promise<ReadProjection> {
  let row: ReadOpportunityRow | null = null;
  try {
    row = await store.opportunity.findUnique({ where: { id: opportunityId } });
  } catch {
    return { found: false, reason: 'Lookup failed.' };
  }
  if (!row) return { found: false, reason: 'not_found' };

  return {
    found: true,
    data: {
      id: row.id,
      title: row.title.slice(0, 300),
      category: row.category.slice(0, 100),
      businessModel: row.businessModel.slice(0, 100),
      targetAudience: row.targetAudience.slice(0, 300),
      problemSolved: row.problemSolved.slice(0, 500),
      monetizationMethod: row.monetizationMethod.slice(0, 100),
      halalStatus: row.halalStatus,
      status: row.status,
      overallScore: row.overallScore,
      confidenceLevel: row.confidenceLevel,
      evidenceNotes: row.evidenceNotes.slice(0, 500),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

/** READ_ANALYTICS — experiment decision history (bounded, aggregated). */
export async function readAnalytics(opportunityId: string, store: ReadsDb = defaultDb): Promise<ReadProjection> {
  try {
    const experiments = await store.experiment.findMany({
      where: { opportunityId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    const decisions = experiments.filter((e) => typeof e.decision === 'string').map((e) => e.decision as string);
    return {
      found: true,
      data: {
        opportunityId,
        experimentCount: experiments.length,
        decisionsOnFile: [...new Set(decisions)],
        scaleDecisions: decisions.filter((d) => d === 'SCALE').length,
        latestExperiments: experiments.slice(0, 10).map((e) => ({
          id: e.id,
          hypothesis: e.hypothesis.slice(0, 300),
          decision: e.decision,
          visitors: e.visitors,
          revenue: e.revenue,
          updatedAt: e.updatedAt.toISOString(),
        })),
        basis: 'RECORDED_DATA_ONLY',
      },
    };
  } catch {
    return { found: false, reason: 'Lookup failed.' };
  }
}

/**
 * READ_REVENUE — aggregate only. Individual payment rows are NOT exposed to
 * external callers (minimum-necessary disclosure).
 */
export async function readRevenue(opportunityId: string, store: ReadsDb = defaultDb): Promise<ReadProjection> {
  try {
    const revenues = await store.revenue.findMany({
      where: { opportunityId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const currency = revenues[0]?.currency ?? 'USD';
    const gross = revenues.reduce((s, r) => s + r.grossRevenue, 0);
    const net = revenues.reduce((s, r) => s + r.netRevenue, 0);
    return {
      found: true,
      data: {
        opportunityId,
        recordCount: revenues.length,
        grossTotal: Math.round(gross * 100) / 100,
        netTotal: Math.round(net * 100) / 100,
        currency,
        basis: 'VERIFIED_RECORDED_ROWS',
      },
    };
  } catch {
    return { found: false, reason: 'Lookup failed.' };
  }
}

// ---------------------------------------------------------------------------
// AgentHealth — truthful, derived, never manually flipped
// ---------------------------------------------------------------------------

export type AgentHealthState = 'READY' | 'DEGRADED' | 'BLOCKED' | 'NOT_CONFIGURED' | 'NOT_CONNECTED';

export interface AgentCapabilityHealth {
  id: string;
  authority: string;
  granted: boolean;
}

export interface AgentHealth {
  status: AgentHealthState;
  /** Contract facts, not marketing. */
  contractVersion: 'v1';
  credentialsConfigured: boolean;
  databaseReachable: boolean;
  capabilities: AgentCapabilityHealth[];
  /** Stable machine-readable reasons; safe for logs and dashboards. */
  reasons: string[];
  timestamp: string;
}

/**
 * Derive health from real facts only:
 * - no credentials configured → NOT_CONFIGURED (nothing works, honestly)
 * - DB unreachable → DEGRADED (auth works, reads/writes will fail)
 * - credentials + DB → READY
 * Runtime-connection claims (e.g. a future live agent runtime) are NEVER
 * fabricated: this endpoint reports THIS system's state, not the caller's.
 */
export async function deriveAgentHealth(granted: readonly string[]): Promise<AgentHealth> {
  const credentials = agentCredentialStatus();
  let databaseReachable = false;
  try {
    await db.$queryRaw`SELECT 1`;
    databaseReachable = true;
  } catch {
    databaseReachable = false;
  }

  let status: AgentHealthState;
  const reasons: string[] = [];
  if (credentials === 'NOT_CONFIGURED') {
    status = 'NOT_CONFIGURED';
    reasons.push('No AGENT_<NAME>_TOKEN credential is configured server-side.');
  } else if (!databaseReachable) {
    status = 'DEGRADED';
    reasons.push('Credential configured but the database is unreachable; reads and dispatches will fail.');
  } else {
    status = 'READY';
    reasons.push('Credential configured and database reachable. All Job Runner gates remain authoritative.');
  }
  if (granted.length === 0 && credentials === 'CONFIGURED') {
    reasons.push('The presenting credential has an empty capability grant; all actions will be refused.');
  }

  return {
    status,
    contractVersion: 'v1',
    credentialsConfigured: credentials === 'CONFIGURED',
    databaseReachable,
    capabilities: [], // populated by the route from the capability catalog
    reasons,
    timestamp: new Date().toISOString(),
  };
}
