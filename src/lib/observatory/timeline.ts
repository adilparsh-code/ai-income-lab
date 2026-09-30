// Phase 10.3 — Live Activity / Audit Timeline.
//
// Builds one auditable timeline from EXISTING durable rows. Every entry
// references the table+id it came from (auditRef); nothing is inferred or
// fabricated. Bounded takes per table keep the read cheap.

import { db } from '@/lib/db';
import type { TimelineEntry } from './types';

const PER_TABLE_LIMIT = 30;

export interface TimelineOptions {
  limit?: number;
  /** Optional ISO date lower bound. */
  since?: string;
}

function sinceDate(since?: string): Date | undefined {
  if (!since) return undefined;
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function getObservatoryTimeline(options: TimelineOptions = {}): Promise<TimelineEntry[]> {
  const limit = Math.min(200, Math.max(10, options.limit ?? 60));
  const since = sinceDate(options.since);
  const sinceFilter = since ? { gte: since } : undefined;
  const time = (d: Date) => d.toISOString();

  const [
    agentRuns,
    jobRuns,
    opportunities,
    products,
    deployments,
    decisions,
    learnings,
    revenues,
    productEvents,
    reviews,
    securityEvents,
    handoffs,
  ] = await Promise.all([
    db.agentRun.findMany({ where: sinceFilter ? { startedAt: sinceFilter } : undefined, orderBy: { startedAt: 'desc' }, take: PER_TABLE_LIMIT }),
    db.jobRun.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT }),
    db.opportunity.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, title: true, status: true, halalStatus: true, createdAt: true } }),
    db.product.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, name: true, status: true, createdAt: true, updatedAt: true } }),
    db.productDeployment.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, productId: true, status: true, providerId: true, url: true, createdAt: true } }),
    db.growthDecision.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, opportunityId: true, experimentId: true, decision: true, reason: true, decidedBy: true, evidenceType: true, createdAt: true } }),
    db.learningEntry.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, hypothesis: true, result: true, evidenceType: true, createdAt: true } }),
    db.revenue.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, revenueSource: true, grossRevenue: true, netRevenue: true, currency: true, productId: true, opportunityId: true, createdAt: true } }),
    db.productEvent.findMany({ where: sinceFilter ? { occurredAt: sinceFilter } : undefined, orderBy: { occurredAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, productId: true, eventType: true, occurredAt: true, source: true } }),
    db.humanReview.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, category: true, title: true, status: true, requestedBy: true, createdAt: true, decidedAt: true } }),
    db.securityEvent.findMany({ where: sinceFilter ? { createdAt: sinceFilter } : undefined, orderBy: { createdAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, kind: true, surface: true, outcome: true, createdAt: true } }),
    db.opportunityHandoff.findMany({ where: sinceFilter ? { receivedAt: sinceFilter } : undefined, orderBy: { receivedAt: 'desc' }, take: PER_TABLE_LIMIT, select: { id: true, idempotencyKey: true, eventType: true, status: true, eligibility: true, jobRunId: true, receivedAt: true } }),
  ]);

  const entries: TimelineEntry[] = [];

  for (const r of agentRuns) {
    entries.push({
      at: time(r.startedAt),
      source: 'AGENT_RUN',
      action: `Agent ${r.agentId} run ${r.status} at stage ${r.stage} (jobType ${r.jobType})${r.safetyVerdict ? `; safety ${r.safetyVerdict}` : ''}`,
      entityKind: 'AgentRun',
      entityId: r.id,
      agentId: r.agentId,
      stage: r.stage,
      result: r.status,
      correlationId: r.correlationId,
      auditRef: `AgentRun:${r.id}`,
    });
  }

  for (const j of jobRuns) {
    entries.push({
      at: time(j.createdAt),
      source: 'JOB_RUN',
      action: `Job ${j.jobType} ${j.status}${j.error ? `; error recorded (detail bounded, no secrets)` : ''}`,
      entityKind: 'JobRun',
      entityId: j.id,
      agentId: j.agentType ?? null,
      stage: null,
      result: j.status,
      correlationId: j.correlationId,
      auditRef: `JobRun:${j.id}`,
    });
  }

  for (const o of opportunities) {
    entries.push({
      at: time(o.createdAt),
      source: 'OPPORTUNITY',
      action: `Opportunity "${o.title.slice(0, 80)}" recorded with halal status ${o.halalStatus} (status ${o.status})`,
      entityKind: 'Opportunity',
      entityId: o.id,
      agentId: null,
      stage: null,
      result: o.status,
      correlationId: null,
      auditRef: `Opportunity:${o.id}`,
    });
  }

  for (const p of products) {
    entries.push({
      at: time(p.createdAt),
      source: 'PRODUCT',
      action: `Product "${p.name.slice(0, 80)}" created (status ${p.status})`,
      entityKind: 'Product',
      entityId: p.id,
      agentId: null,
      stage: null,
      result: p.status,
      correlationId: null,
      auditRef: `Product:${p.id}`,
    });
  }

  for (const d of deployments) {
    entries.push({
      at: time(d.createdAt),
      source: 'PRODUCT_DEPLOYMENT',
      action: `Deployment for product ${d.productId} is ${d.status}${d.providerId ? ` via ${d.providerId}` : ''}${d.url ? `; URL recorded` : ''}`,
      entityKind: 'ProductDeployment',
      entityId: d.id,
      agentId: null,
      stage: null,
      result: d.status,
      correlationId: d.id,
      auditRef: `ProductDeployment:${d.id}`,
    });
  }

  for (const g of decisions) {
    entries.push({
      at: time(g.createdAt),
      source: 'GROWTH_DECISION',
      action: `Growth decision ${g.decision} by ${g.decidedBy} (${g.evidenceType}): ${g.reason.slice(0, 100)}`,
      entityKind: 'GrowthDecision',
      entityId: g.id,
      agentId: g.decidedBy === 'human' ? null : g.decidedBy,
      stage: null,
      result: g.decision,
      correlationId: g.id,
      auditRef: `GrowthDecision:${g.id}`,
    });
  }

  for (const l of learnings) {
    entries.push({
      at: time(l.createdAt),
      source: 'LEARNING_ENTRY',
      action: `Learning entry ${l.result} (${l.evidenceType}): ${l.hypothesis.slice(0, 100)}`,
      entityKind: 'LearningEntry',
      entityId: l.id,
      agentId: null,
      stage: null,
      result: l.result,
      correlationId: null,
      auditRef: `LearningEntry:${l.id}`,
    });
  }

  for (const rev of revenues) {
    entries.push({
      at: time(rev.createdAt),
      source: 'REVENUE',
      action: `Revenue recorded from ${rev.revenueSource}: gross ${rev.grossRevenue} ${rev.currency}${rev.productId ? `; product ${rev.productId}` : '; UNATTRIBUTED to product'}${rev.opportunityId ? `, opportunity ${rev.opportunityId}` : ''}`,
      entityKind: 'Revenue',
      entityId: rev.id,
      agentId: null,
      stage: null,
      result: 'RECORDED',
      correlationId: null,
      auditRef: `Revenue:${rev.id}`,
    });
  }

  for (const e of productEvents) {
    entries.push({
      at: time(e.occurredAt),
      source: 'PRODUCT_EVENT',
      action: `${e.eventType} event on product ${e.productId} (source ${e.source})`,
      entityKind: 'ProductEvent',
      entityId: e.id,
      agentId: null,
      stage: null,
      result: e.eventType,
      correlationId: null,
      auditRef: `ProductEvent:${e.id}`,
    });
  }

  for (const h of reviews) {
    entries.push({
      at: time(h.decidedAt ?? h.createdAt),
      source: 'HUMAN_REVIEW',
      action: `Human review [${h.category}] "${h.title.slice(0, 80)}" requested by ${h.requestedBy} — ${h.status}`,
      entityKind: 'HumanReview',
      entityId: h.id,
      agentId: h.requestedBy === 'system' ? null : h.requestedBy,
      stage: null,
      result: h.status,
      correlationId: h.id,
      auditRef: `HumanReview:${h.id}`,
    });
  }

  for (const s of securityEvents) {
    entries.push({
      at: time(s.createdAt),
      source: 'SECURITY_EVENT',
      action: `Security event ${s.kind} on ${s.surface}: ${s.outcome}`,
      entityKind: 'SecurityEvent',
      entityId: s.id,
      agentId: null,
      stage: null,
      result: s.outcome,
      correlationId: null,
      auditRef: `SecurityEvent:${s.id}`,
    });
  }

  for (const h of handoffs) {
    entries.push({
      at: time(h.receivedAt),
      source: 'HANDOFF',
      action: `Handoff ${h.eventType} ${h.status} (eligibility ${h.eligibility})${h.jobRunId ? `; dispatched JobRun ${h.jobRunId}` : ''}`,
      entityKind: 'OpportunityHandoff',
      entityId: h.id,
      agentId: null,
      stage: null,
      result: h.status,
      correlationId: h.idempotencyKey,
      auditRef: `OpportunityHandoff:${h.id}`,
    });
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.auditRef.localeCompare(b.auditRef)));
  return entries.slice(0, limit);
}
