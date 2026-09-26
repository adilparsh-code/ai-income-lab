// Phase 9 — Outcome Attribution + Growth Analytics (deterministic).
//
// All calculations run over RECORDED evidence only: ProductEvent rows for the
// funnel, verified Revenue rows for money, GrowthExperiment rows for lift.
// Zero-data situations return explicit nulls / INSUFFICIENT_DATA labels —
// never invented numbers.

import {
  MIN_RELATIVE_LIFT,
  MIN_VISITORS_FOR_COMPARISON,
  type ExperimentMetric,
} from './types';

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export interface AttributionWindow {
  start: Date;
  end: Date;
}

export interface AttributionRow {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  sessionId: string | null;
  eventType: string;
  amountUsd: number | null;
  occurredAt: Date;
  experimentId: string | null;
}

export interface ChannelAttribution {
  key: string;
  source: string;
  medium: string;
  campaign: string;
  visitors: number;
  ctaClicks: number;
  purchases: number;
  revenueUsd: number;
  conversionRate: number | null; // null when visitors < MIN_VISITORS_FOR_COMPARISON
}

function channelKey(row: AttributionRow): string {
  return [row.utmSource ?? '(none)', row.utmMedium ?? '(none)', row.utmCampaign ?? '(none)'].join('|');
}

/**
 * Attribute visitors/clicks/purchases/revenue to traffic channels from
 * recorded events only. Deterministic: same rows ⇒ same output, keys sorted.
 */
export function attributeChannels(rows: AttributionRow[]): ChannelAttribution[] {
  const byChannel = new Map<string, ChannelAttribution>();
  const visitorSessions = new Map<string, Set<string>>();

  for (const row of rows) {
    const key = channelKey(row);
    let entry = byChannel.get(key);
    if (!entry) {
      const [source, medium, campaign] = key.split('|');
      entry = { key, source, medium, campaign, visitors: 0, ctaClicks: 0, purchases: 0, revenueUsd: 0, conversionRate: null };
      byChannel.set(key, entry);
      visitorSessions.set(key, new Set());
    }
    if (row.eventType === 'VISITOR') {
      if (row.sessionId) visitorSessions.get(key)!.add(row.sessionId);
    } else if (row.eventType === 'CTA_CLICK') {
      entry.ctaClicks += 1;
    } else if (row.eventType === 'PURCHASE') {
      entry.purchases += 1;
      entry.revenueUsd += row.amountUsd ?? 0;
    }
  }

  const result: ChannelAttribution[] = [];
  for (const [key, entry] of byChannel) {
    const visitors = visitorSessions.get(key)!.size;
    result.push({
      ...entry,
      visitors,
      conversionRate: visitors >= MIN_VISITORS_FOR_COMPARISON ? entry.purchases / visitors : null,
    });
  }
  return result.sort((a, b) => b.revenueUsd - a.revenueUsd || b.visitors - a.visitors || a.key.localeCompare(b.key));
}

/**
 * Assign credit for a conversion to the experiment that drove the event, when
 * the event row carries an experimentId. Events without one stay unattributed
 * (null) — never force-assigned.
 */
export function attributeExperiment(rows: AttributionRow[]): {
  attributed: { experimentId: string; conversions: number; revenueUsd: number }[];
  unattributedConversions: number;
} {
  const byExperiment = new Map<string, { conversions: number; revenueUsd: number }>();
  let unattributed = 0;
  for (const row of rows) {
    if (row.eventType !== 'PURCHASE') continue;
    if (row.experimentId && row.experimentId.trim().length > 0) {
      const entry = byExperiment.get(row.experimentId) ?? { conversions: 0, revenueUsd: 0 };
      entry.conversions += 1;
      entry.revenueUsd += row.amountUsd ?? 0;
      byExperiment.set(row.experimentId, entry);
    } else {
      unattributed += 1;
    }
  }
  return {
    attributed: [...byExperiment.entries()]
      .map(([experimentId, v]) => ({ experimentId, ...v }))
      .sort((a, b) => b.revenueUsd - a.revenueUsd || a.experimentId.localeCompare(b.experimentId)),
    unattributedConversions: unattributed,
  };
}

// ---------------------------------------------------------------------------
// Analytics (deterministic funnel + experiment evaluation)
// ---------------------------------------------------------------------------

export interface FunnelStage {
  stage: string;
  count: number;
  rateFromVisitors: number | null; // null when visitors below threshold
}

export interface FunnelAnalytics {
  visitors: number;
  stages: FunnelStage[];
  overallConversionRate: number | null;
  revenuePerVisitorUsd: number | null;
  evidenceStatus: 'SUPPORTED' | 'INSUFFICIENT_DATA';
  explanation: string;
}

const FUNNEL_ORDER = ['VISITOR', 'PRODUCT_VIEW', 'CTA_CLICK', 'CHECKOUT_STARTED', 'PURCHASE'] as const;

export function computeFunnelAnalytics(rows: AttributionRow[]): FunnelAnalytics {
  const counts = new Map<string, number>();
  for (const stage of FUNNEL_ORDER) counts.set(stage, 0);
  let grossRevenue = 0;
  const visitorSessions = new Set<string>();

  for (const row of rows) {
    if (counts.has(row.eventType)) counts.set(row.eventType, (counts.get(row.eventType) ?? 0) + 1);
    if (row.eventType === 'VISITOR' && row.sessionId) visitorSessions.add(row.sessionId);
    if (row.eventType === 'PURCHASE') grossRevenue += row.amountUsd ?? 0;
  }

  const visitors = visitorSessions.size;
  const supported = visitors >= MIN_VISITORS_FOR_COMPARISON;
  const purchases = counts.get('PURCHASE') ?? 0;

  const stages: FunnelStage[] = FUNNEL_ORDER.map((stage) => ({
    stage,
    count: counts.get(stage) ?? 0,
    rateFromVisitors: supported && stage === 'VISITOR' ? 1 : supported ? (counts.get(stage) ?? 0) / visitors : null,
  }));

  return {
    visitors,
    stages,
    overallConversionRate: supported ? purchases / visitors : null,
    revenuePerVisitorUsd: supported && purchases >= 5 ? grossRevenue / visitors : null,
    evidenceStatus: supported ? 'SUPPORTED' : 'INSUFFICIENT_DATA',
    explanation: supported
      ? `${visitors} recorded unique visitors — rates are SUPPORTED.`
      : `Only ${visitors} recorded unique visitors (< ${MIN_VISITORS_FOR_COMPARISON}) — rates withheld as INSUFFICIENT_DATA rather than estimated.`,
  };
}

export interface ExperimentEvaluation {
  metric: ExperimentMetric;
  baselineValue: number;
  measuredValue: number | null; // null when data is insufficient
  relativeLift: number | null;
  significant: boolean; // deterministic thresholds; no p-value theater
  result: 'VALIDATED' | 'INVALIDATED' | 'INCONCLUSIVE';
  explanation: string;
}

function measuredFor(metric: ExperimentMetric, variantVisitors: number, variantConversions: number, variantValueUsd: number): number | null {
  if (variantVisitors < MIN_VISITORS_FOR_COMPARISON) return null;
  switch (metric) {
    case 'CONVERSION_RATE':
      return variantConversions / variantVisitors;
    case 'CTR':
      return variantConversions / variantVisitors; // click-through measured as conversion-of-CTA events
    case 'REVENUE_PER_VISITOR':
      return variantValueUsd / variantVisitors;
    case 'SIGNUPS':
      return variantConversions / variantVisitors;
    case 'REVENUE':
      return variantValueUsd;
  }
}

/** Deterministic A/B evaluation. No data ⇒ INCONCLUSIVE, never fabricated. */
export function evaluateExperiment(parts: {
  metric: ExperimentMetric;
  baselineValue: number;
  variantVisitors: number;
  variantConversions: number;
  variantValueUsd: number;
}): ExperimentEvaluation {
  const measured = measuredFor(parts.metric, parts.variantVisitors, parts.variantConversions, parts.variantValueUsd);
  if (measured === null) {
    return {
      metric: parts.metric,
      baselineValue: parts.baselineValue,
      measuredValue: null,
      relativeLift: null,
      significant: false,
      result: 'INCONCLUSIVE',
      explanation: `Only ${parts.variantVisitors} variant visitors (< ${MIN_VISITORS_FOR_COMPARISON}) — no lift claim is made.`,
    };
  }
  const baseline = parts.baselineValue;
  const relativeLift = baseline > 0 ? (measured - baseline) / baseline : measured > 0 ? 1 : 0;
  const significant = relativeLift >= MIN_RELATIVE_LIFT;
  return {
    metric: parts.metric,
    baselineValue: baseline,
    measuredValue: measured,
    relativeLift,
    significant,
    result: significant ? 'VALIDATED' : measured < baseline ? 'INVALIDATED' : 'INCONCLUSIVE',
    explanation:
      `Measured ${measured.toFixed(4)} vs baseline ${baseline.toFixed(4)} (relative lift ${(relativeLift * 100).toFixed(1)}%). ` +
      (significant ? 'Lift meets the deterministic threshold; hypothesis VALIDATED.' : 'Lift below threshold; no validated win.'),
  };
}
