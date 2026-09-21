// Phase 5.2 — Durable agent memory (derived, provenance-preserving).
//
// Bridges the Phase 4.5.3 memory foundation (pure, in-memory shapes) to the
// EXISTING durable stores. Design decision: the database ALREADY holds the
// durable business memory — AgentLog (research/validation/executions),
// Experiment (results/decisions), BusinessDecision-adjacent records (BM logs),
// Product/Revenue (outcomes). Rather than adding a parallel memory table and
// a second source of truth, this module DERIVES bounded MemoryEntry views
// from those records on demand:
//
//   AgentLog.success research  → AI_INFERENCE / VERIFIED_DATA facts
//   Experiment rows            → EXPERIMENT_RESULTS / FAILED_HYPOTHESES
//   BM AgentLog decisions      → BUSINESS_DECISIONS
//   SCALE decisions (human)    → SUCCESSFUL_PATTERNS
//
// Guarantees:
// - Every entry carries provenance (evidence type + source record id) and a
//   timestamp — provenance can never be upgraded by this module.
// - Retrieval is bounded (limit) and scope-filtered: no whole-history dumps.
// - Deterministic: no AI, no network; identical DB state → identical memory.
// - Unrestricted conversational memory remains structurally impossible:
//   only the seven fixed categories exist, content is clamped, and prompt
//   payloads are never included.

import { db } from '@/lib/db';
import {
  createMemoryEntry,
  retrieveMemory,
  memoryToContextItems,
  type MemoryCategory,
  type MemoryEntry,
} from './coordination';

export { memoryToContextItems };

const MAX_CONTENT = 600;

function clamp(value: string, max = MAX_CONTENT): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Build durable memory for an opportunity scope from REAL records.
 * Pure read: creates nothing, mutates nothing; failures degrade to fewer
 * entries (never fabricated ones).
 */
export async function buildOpportunityMemory(
  opportunityId: string,
  options: { limit?: number } = {},
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  const scope = `opportunity:${opportunityId}`;

  const [researchLogs, validationLogs, bmLogs, experiments] = await Promise.all([
    db.agentLog.findMany({
      where: { agentType: 'research', input: { contains: opportunityId }, success: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, output: true, evidenceType: true, createdAt: true },
    }),
    db.agentLog.findMany({
      where: { agentType: 'validation', input: { contains: opportunityId }, success: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, output: true, createdAt: true },
    }),
    db.agentLog.findMany({
      where: { agentType: 'business-manager', input: { contains: opportunityId } },
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { id: true, output: true, createdAt: true },
    }),
    db.experiment.findMany({
      where: { opportunityId },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { id: true, hypothesis: true, decision: true, revenue: true, budget: true, visitors: true, updatedAt: true },
    }),
  ]);

  // Research memories (provenance from the log's own evidenceType; AI output
  // can never upgrade it — we trust only the stored VERIFIED_DATA marker).
  for (const log of researchLogs) {
    entries.push(createMemoryEntry({
      id: `research:${log.id}`,
      category: log.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED_FACTS' : 'AI_INFERENCE',
      scope,
      content: clamp(`Research execution recorded (${log.evidenceType}).`),
      evidenceType: log.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED_DATA' : 'AI_INFERENCE',
      provenance: `AgentLog:${log.id}`,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  // Validation memories (decisions only — bounded, no payloads).
  for (const log of validationLogs) {
    let decision = 'unknown';
    try {
      const output = JSON.parse(log.output) as { recommendation?: string };
      if (typeof output.recommendation === 'string') decision = output.recommendation;
    } catch {
      // Unreadable output: record provenance without inventing a decision.
    }
    entries.push(createMemoryEntry({
      id: `validation:${log.id}`,
      category: 'AI_INFERENCE',
      scope,
      content: clamp(`Validation decision: ${decision}.`),
      evidenceType: 'AI_INFERENCE',
      provenance: `AgentLog:${log.id}`,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  // Business decisions from Business Manager executions.
  for (const log of bmLogs) {
    let decision = 'unknown';
    try {
      const output = JSON.parse(log.output) as { decision?: string; nextBestAction?: { action?: string } };
      if (typeof output.decision === 'string') decision = output.decision;
      if (typeof output.nextBestAction?.action === 'string') decision += ` → ${output.nextBestAction.action}`;
    } catch {
      // Ignore unreadable historical payloads.
    }
    entries.push(createMemoryEntry({
      id: `bm:${log.id}`,
      category: 'BUSINESS_DECISIONS',
      scope,
      content: clamp(`Business Manager decision: ${decision}.`),
      evidenceType: 'AI_INFERENCE',
      provenance: `AgentLog:${log.id}`,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  // Experiment results — human decisions drive the category.
  for (const experiment of experiments) {
    if (experiment.decision === 'SCALE') {
      entries.push(createMemoryEntry({
        id: `experiment-success:${experiment.id}`,
        category: 'SUCCESSFUL_PATTERNS',
        scope,
        content: clamp(`Experiment "${experiment.hypothesis.slice(0, 120)}" reached SCALE (human decision, revenue $${experiment.revenue.toFixed(2)}).`),
        evidenceType: 'VERIFIED_DATA',
        provenance: `Experiment:${experiment.id}`,
        createdAt: experiment.updatedAt.toISOString(),
      }));
    } else if (experiment.decision === 'KILL' || experiment.decision === 'PAUSE') {
      entries.push(createMemoryEntry({
        id: `experiment-fail:${experiment.id}`,
        category: 'FAILED_HYPOTHESES',
        scope,
        content: clamp(`Experiment "${experiment.hypothesis.slice(0, 120)}" reached ${experiment.decision} (human decision).`),
        evidenceType: 'VERIFIED_DATA',
        provenance: `Experiment:${experiment.id}`,
        createdAt: experiment.updatedAt.toISOString(),
      }));
    } else {
      entries.push(createMemoryEntry({
        id: `experiment:${experiment.id}`,
        category: 'EXPERIMENT_RESULTS',
        scope,
        content: clamp(`Experiment "${experiment.hypothesis.slice(0, 120)}": ${experiment.visitors} visitor(s), revenue $${experiment.revenue.toFixed(2)}, no final decision yet.`),
        evidenceType: 'VERIFIED_DATA',
        provenance: `Experiment:${experiment.id}`,
        createdAt: experiment.updatedAt.toISOString(),
      }));
    }
  }

  // Bounded, relevance-ranked retrieval over the derived entries.
  return retrieveMemory(entries, { scope, limit: options.limit ?? 10 });
}

/**
 * Compact context items for prompt builders (bounded, provenance-labelled).
 * Callers pass this into compressContext() — never raw history.
 */
export async function getOpportunityMemoryContext(
  opportunityId: string,
  options: { limit?: number } = {},
): Promise<{ label: string; text: string; evidenceType: string }[]> {
  const entries = await buildOpportunityMemory(opportunityId, options);
  return memoryToContextItems(entries);
}

/**
 * Phase 5.5 — Business-Manager memory view: the opportunity memory EXTENDED
 * with recorded product outcomes and deterministic growth classifications,
 * so the Business Manager can learn from what actually happened.
 *
 * Derived from REAL rows only (Product, Revenue, JobRun PRODUCT_ANALYZE
 * outputs). Provenance and evidence types are preserved exactly as stored;
 * a product with no recorded revenue yields an honest "no recorded revenue"
 * entry — never a fabricated learning signal. Retrieval stays bounded.
 */
export async function buildOpportunityBusinessMemory(
  opportunityId: string,
  options: { limit?: number } = {},
): Promise<MemoryEntry[]> {
  const base = await buildOpportunityMemory(opportunityId, { limit: options.limit });
  const entries: MemoryEntry[] = [...base];
  const scope = `opportunity:${opportunityId}`;

  const [products, analyzeRuns] = await Promise.all([
    db.product.findMany({
      where: { opportunityId },
      orderBy: { updatedAt: 'desc' },
      take: 3,
      select: { id: true, name: true, status: true, updatedAt: true },
    }),
    db.jobRun.findMany({
      where: { jobType: 'PRODUCT_ANALYZE', status: 'SUCCEEDED', input: { contains: opportunityId } },
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { id: true, output: true, createdAt: true },
    }),
  ]);

  // Recorded product outcomes — VERIFIED_DATA because status and revenue are
  // stored DB state, not inference.
  for (const product of products) {
    const revenueRows = await db.revenue.aggregate({
      where: { productId: product.id },
      _sum: { grossRevenue: true, netRevenue: true },
      _count: { id: true },
    });
    const gross = revenueRows._sum.grossRevenue ?? 0;
    const net = revenueRows._sum.netRevenue ?? 0;
    const count = revenueRows._count.id;
    const hasRevenue = count > 0;

    entries.push(createMemoryEntry({
      id: `product-outcome:${product.id}`,
      category: hasRevenue ? 'SUCCESSFUL_PATTERNS' : 'EXPERIMENT_RESULTS',
      scope,
      content: clamp(
        `Product "${product.name}" is ${product.status} with ${count} recorded revenue row(s)` +
          (hasRevenue ? ` (gross $${gross.toFixed(2)}, net $${net.toFixed(2)}).` : ' — no recorded revenue yet.'),
      ),
      evidenceType: 'VERIFIED_DATA',
      provenance: `Product:${product.id}`,
      createdAt: product.updatedAt.toISOString(),
    }));
  }

  // Deterministic growth classifications (PRODUCT_ANALYZE is AI-free, so its
  // decisions are recorded business decisions, not AI inference).
  for (const run of analyzeRuns) {
    let state = 'unknown';
    let action = 'unknown';
    try {
      const output = JSON.parse(run.output ?? '{}') as {
        summary?: { evidenceState?: string; recommendedAction?: string };
      };
      if (typeof output.summary?.evidenceState === 'string') state = output.summary.evidenceState;
      if (typeof output.summary?.recommendedAction === 'string') action = output.summary.recommendedAction;
    } catch {
      // Unreadable output: keep provenance without inventing a decision.
    }
    entries.push(createMemoryEntry({
      id: `growth-decision:${run.id}`,
      category: 'BUSINESS_DECISIONS',
      scope,
      content: clamp(`Deterministic growth classification: ${state}; recommended action: ${action}.`),
      evidenceType: 'VERIFIED_DATA',
      provenance: `JobRun:${run.id}`,
      createdAt: run.createdAt.toISOString(),
    }));
  }

  return retrieveMemory(entries, { scope, limit: options.limit ?? 12 });
}

/** Memory categories exposed for surfaces (re-export for convenience). */
export const MEMORY_CATEGORY_LIST: readonly MemoryCategory[] = [
  'VERIFIED_FACTS',
  'USER_ENTERED',
  'AI_INFERENCE',
  'EXPERIMENT_RESULTS',
  'BUSINESS_DECISIONS',
  'FAILED_HYPOTHESES',
  'SUCCESSFUL_PATTERNS',
];
