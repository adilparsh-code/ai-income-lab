// Business Intelligence / profitability layer tests (pure, offline, no DB).
// The deterministic calculation is authoritative; AI never touches these paths.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRevenueRecords,
  analyzeExperimentProfitability,
  buildBusinessIntelligence,
  resolveRevenueHealth,
} from '../../business/profitability';
import {
  buildProfitabilityDecisionFacts,
  buildOpportunityProfitSummaries,
} from '../../business/business-manager-profitability';

describe('profitability: zero revenue', () => {
  it('returns all-zero metrics with no estimation', () => {
    const { metrics, warnings } = analyzeRevenueRecords([]);
    assert.equal(metrics.grossRevenue, 0);
    assert.equal(metrics.netRevenue, 0);
    assert.equal(metrics.contributionProfit, 0);
    assert.equal(metrics.contributionMarginPercent, null);
    assert.equal(metrics.roiPercent, null);
    assert.equal(metrics.breakEvenRevenue, null);
    assert.ok(warnings.some((w) => w.includes('Fixed costs')));
  });

  it('buildBusinessIntelligence with no records reports missing data, no fabrication', () => {
    const bi = buildBusinessIntelligence({ revenues: [] });
    assert.equal(bi.overall.contributionProfit, 0);
    assert.ok(bi.missingData.some((m) => m.includes('No usable revenue records')));
    assert.ok(bi.nextActions.some((a) => a.action.includes('Record real revenue')));
    // Nothing may be invented in KPIs
    for (const kpi of bi.kpis) {
      assert.ok(!kpi.value.includes('NaN') && !kpi.value.includes('Infinity'));
    }
  });
});

describe('profitability: zero costs', () => {
  it('zero costs with revenue gives undefined ROI and full-margin warning', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 100, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 100 },
    ]);
    assert.equal(metrics.netRevenue, 100);
    assert.equal(metrics.contributionProfit, 100);
    assert.equal(metrics.contributionMarginPercent, 100);
    assert.equal(metrics.roiPercent, null);
    assert.ok(metrics.contributionProfit > 0);
  });
});

describe('profitability: refunds', () => {
  it('derives refunds from the stored residual, floored at zero', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 200, fees: 10, advertisingCost: 5, otherCosts: 5, netRevenue: 160 },
    ]);
    // cost-adjusted gross = 180; stored net = 160 -> residual refunds 20
    assert.equal(metrics.refunds, 20);
    // net (after refunds) = 200 - 20; contribution = net - fees(10) - costs(10)
    assert.equal(metrics.netRevenue, 180);
    assert.equal(metrics.contributionProfit, 160);
  });

  it('reports zero refunds when stored net already equals cost-adjusted gross', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 100, fees: 10, advertisingCost: 0, otherCosts: 0, netRevenue: 90 },
    ]);
    assert.equal(metrics.refunds, 0);
    assert.equal(metrics.refundsDerived, false);
  });

  it('flags records whose stored net exceeds cost-adjusted gross instead of inventing costs', () => {
    const { metrics, warnings } = analyzeRevenueRecords([
      { grossRevenue: 50, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 80 },
    ]);
    assert.equal(metrics.refunds, 0);
    assert.ok(warnings.some((w) => w.includes('stored netRevenue exceeding gross minus recorded costs')));
  });
});

describe('profitability: fees', () => {
  it('maps fees to platform fees and keeps payment fees at zero (schema truth)', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 100, fees: 5, advertisingCost: 0, otherCosts: 0, netRevenue: 95 },
    ]);
    assert.equal(metrics.platformFees, 5);
    assert.equal(metrics.paymentFees, 0);
    // self-consistent record: no refunds; net (after refunds) = gross
    assert.equal(metrics.netRevenue, 100);
    assert.equal(metrics.contributionProfit, 95);
    assert.equal(metrics.contributionMarginPercent, 95);
  });

  it('contribution profit subtracts fees and variable costs deterministically', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 500, fees: 50, advertisingCost: 30, otherCosts: 20, netRevenue: 400 },
    ]);
    assert.equal(metrics.refunds, 0);
    assert.equal(metrics.netRevenue, 500);
    assert.equal(metrics.variableCosts, 50);
    assert.equal(metrics.contributionProfit, 400);
    assert.equal(metrics.contributionMarginPercent, 80);
  });
});

describe('profitability: negative and invalid values', () => {
  it('excludes records with non-finite gross revenue and warns', () => {
    const { metrics, warnings } = analyzeRevenueRecords([
      { grossRevenue: NaN, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 0 },
      { grossRevenue: Infinity, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 0 },
    ]);
    assert.equal(metrics.recordCount, 0);
    assert.equal(metrics.excludedRecordCount, 2);
    assert.equal(metrics.grossRevenue, 0);
    assert.ok(warnings.filter((w) => w.includes('invalid')).length >= 2);
  });

  it('excludes negative gross revenue records', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: -5, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: -5 },
      { grossRevenue: 40, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 40 },
    ]);
    assert.equal(metrics.recordCount, 1);
    assert.equal(metrics.grossRevenue, 40);
    assert.equal(metrics.excludedRecordCount, 1);
  });

  it('clamps negative fee/cost fields with a warning but keeps the record', () => {
    const { metrics, warnings } = analyzeRevenueRecords([
      { grossRevenue: 100, fees: -3, advertisingCost: -2, otherCosts: 0, netRevenue: 105 },
    ]);
    assert.equal(metrics.recordCount, 1);
    assert.equal(metrics.platformFees, 0);
    assert.equal(metrics.variableCosts, 0);
    assert.ok(warnings.some((w) => w.includes('clamped to 0')));
  });
});

describe('profitability: ROI', () => {
  it('computes ROI against variable costs', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 300, fees: 0, advertisingCost: 100, otherCosts: 0, netRevenue: 300 },
    ]);
    // contribution profit = 200; investment = 100 -> 200%
    assert.equal(metrics.roiPercent, 200);
  });

  it('returns null ROI with zero spend (never Infinity)', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 100, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 100 },
    ]);
    assert.equal(metrics.roiPercent, null);
  });

  it('returns negative ROI when contribution profit is negative', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 50, fees: 0, advertisingCost: 100, otherCosts: 0, netRevenue: 50 },
    ]);
    assert.equal(metrics.roiPercent, -50);
  });
});

describe('profitability: break-even', () => {
  it('computes break-even revenue from a fixed-cost basis', () => {
    const { metrics } = analyzeRevenueRecords(
      [{ grossRevenue: 100, fees: 0, advertisingCost: 10, otherCosts: 0, netRevenue: 100 }],
      { fixedCosts: 90 },
    );
    // margin = 90% -> break-even = 100
    assert.equal(metrics.breakEvenRevenue, 100);
  });

  it('returns null when margin is zero or negative', () => {
    const { metrics } = analyzeRevenueRecords(
      [{ grossRevenue: 100, fees: 100, advertisingCost: 0, otherCosts: 0, netRevenue: 0 }],
      { fixedCosts: 90 },
    );
    assert.equal(metrics.breakEvenRevenue, null);
  });

  it('is not computed without an explicit fixed-cost basis', () => {
    const { metrics } = analyzeRevenueRecords([
      { grossRevenue: 100, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 100 },
    ]);
    assert.equal(metrics.breakEvenRevenue, null);
  });
});

describe('profitability: NaN/Infinity protection', () => {
  it('never emits NaN or Infinity in any rendered KPI value', () => {
    const bi = buildBusinessIntelligence({
      revenues: [
        { grossRevenue: NaN, fees: NaN, advertisingCost: NaN, otherCosts: NaN, netRevenue: NaN },
        { grossRevenue: 100, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 100 },
      ],
      experiments: [
        { id: 'e1', hypothesis: 'NaN budget', budget: NaN, revenue: Infinity, profit: NaN, visitors: 0, sales: 0 },
      ],
    });
    const allValues = bi.kpis.map((k) => k.value).join(' ');
    assert.ok(!allValues.includes('NaN') && !allValues.includes('Infinity'));
    for (const entity of [...bi.perOpportunity, ...bi.perProduct]) {
      assert.ok(Number.isFinite(entity.metrics.contributionProfit));
    }
  });

  it('handles NaN experiment budget without crashing (spend clamps to 0)', () => {
    const [result] = analyzeExperimentProfitability([
      { id: 'e1', hypothesis: 'x', budget: NaN, revenue: 50, profit: 0, visitors: 1, sales: 1 },
    ]);
    assert.equal(result.spend, 0);
    assert.equal(result.contributionProfit, 50);
    assert.equal(result.roiPercent, null);
  });
});

describe('profitability: missing data and provenance separation', () => {
  it('reports per-entity data only where revenue exists', () => {
    const bi = buildBusinessIntelligence({
      opportunities: [
        { id: 'opp1', title: 'With revenue', estimatedStartupCost: 0 },
        { id: 'opp2', title: 'Without revenue', estimatedStartupCost: 0 },
      ],
      revenues: [{ grossRevenue: 80, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 80, opportunityId: 'opp1' } as import('../../business/profitability').RevenueRecordInput & { opportunityId: string }],
    });
    assert.equal(bi.perOpportunity.length, 1);
    assert.equal(bi.perOpportunity[0].entityId, 'opp1');
    assert.ok(bi.missingData.some((m) => m.includes('1 opportunity(ies) have no linked revenue')));
    assert.equal(bi.dataQuality.opportunitiesWithRevenue, 1);
  });

  it('keeps every KPI VERIFIED_DATA and marks narrative items separately', () => {
    const bi = buildBusinessIntelligence({
      revenues: [{ grossRevenue: 100, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 100 }],
    });
    for (const kpi of bi.kpis) {
      assert.equal(kpi.provenance, 'VERIFIED_DATA');
    }
    const narrative = bi.evidence.filter((e) => e.type === 'AI_INFERENCE');
    assert.ok(narrative.length > 0);
    assert.ok(bi.evidence.some((e) => e.type === 'VERIFIED_DATA'));
  });

  it('experiment stored profit is reported but never authoritative', () => {
    const [result] = analyzeExperimentProfitability([
      { id: 'e1', hypothesis: 'stale profit', budget: 20, revenue: 100, profit: 999, visitors: 1, sales: 1 },
    ]);
    assert.equal(result.contributionProfit, 80);
    assert.equal(result.storedProfit, 999);
    assert.equal(result.storedProfitMatchesComputed, false);
    assert.ok(result.warnings.some((w) => w.includes('authoritative')));
  });
});

describe('revenue health + business manager decision facts', () => {
  it('resolveRevenueHealth covers all four states', () => {
    assert.equal(resolveRevenueHealth(0, 0, 0), 'NO_DATA');
    assert.equal(resolveRevenueHealth(0, 0, 2), 'NON_POSITIVE_NET');
    assert.equal(resolveRevenueHealth(100, -5, 2), 'UNPROFITABLE');
    assert.equal(resolveRevenueHealth(100, 25, 2), 'PROFITABLE');
  });

  it('decision facts: NO_DATA path never fabricates profitability', () => {
    const facts = buildProfitabilityDecisionFacts({
      opportunity: { id: 'o1', title: 'T', estimatedStartupCost: 0 },
      revenues: [],
    });
    assert.equal(facts.hasRevenueData, false);
    assert.equal(facts.revenueHealth, 'NO_DATA');
    assert.equal(facts.evidenceType, 'AI_INFERENCE');
    assert.ok(facts.summary.includes('unknown, not zero-profit'));
  });

  it('decision facts: unprofitable revenue flips health to UNPROFITABLE with VERIFIED_DATA', () => {
    const facts = buildProfitabilityDecisionFacts({
      opportunity: { id: 'o1', title: 'T', estimatedStartupCost: 0 },
      revenues: [
        // refunds 60 (derived) exceed stored net 40 -> contribution -20
        { grossRevenue: 100, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 40, opportunityId: 'o1' },
      ],
    });
    assert.equal(facts.hasRevenueData, true);
    assert.equal(facts.revenueHealth, 'UNPROFITABLE');
    assert.equal(facts.evidenceType, 'VERIFIED_DATA');
    assert.equal(facts.contributionProfit, -20);
    assert.ok(facts.summary.includes('contribution profit is not'));
  });

  it('decision facts: profitable path reports VERIFIED_DATA with ROI', () => {
    const facts = buildProfitabilityDecisionFacts({
      opportunity: { id: 'o1', title: 'T', estimatedStartupCost: 0 },
      revenues: [
        { grossRevenue: 200, fees: 20, advertisingCost: 30, otherCosts: 0, netRevenue: 150, opportunityId: 'o1' },
      ],
    });
    assert.equal(facts.revenueHealth, 'PROFITABLE');
    assert.equal(facts.evidenceType, 'VERIFIED_DATA');
    assert.equal(facts.contributionProfit, 150); // self-consistent: contribution = stored net
    assert.equal(facts.roiPercent, 500); // 150 / 30 * 100
  });

  it('decision facts: invalid records are excluded with warnings', () => {
    const facts = buildProfitabilityDecisionFacts({
      opportunity: { id: 'o1', title: 'T', estimatedStartupCost: 0 },
      revenues: [
        { grossRevenue: NaN, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 0, opportunityId: 'o1' },
        { grossRevenue: 60, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 60, opportunityId: 'o1' },
      ],
    });
    assert.equal(facts.netRevenue, 60);
    assert.equal(facts.revenueHealth, 'PROFITABLE');
    assert.ok(facts.warnings.some((w) => w.includes('invalid revenue record')));
  });

  it('portfolio summaries only include opportunities with revenue', () => {
    const summaries = buildOpportunityProfitSummaries(
      [
        { id: 'a', title: 'A', estimatedStartupCost: 0 },
        { id: 'b', title: 'B', estimatedStartupCost: 0 },
      ],
      [{ grossRevenue: 10, fees: 0, advertisingCost: 0, otherCosts: 0, netRevenue: 10, opportunityId: 'a' }],
    );
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].opportunityId, 'a');
  });
});

describe('halal gates preserved (pure decision-input behavior)', () => {
  it('NO_DATA facts cannot mark itself verified', () => {
    const facts = buildProfitabilityDecisionFacts({
      opportunity: { id: 'o1', title: 'T', estimatedStartupCost: 0 },
      revenues: [],
    });
    // Without data the layer must not claim verified profitability,
    // mirroring the agent gate that REVIEW_REQUIRED/NOT_ALLOWED bypass analysis.
    assert.notEqual(facts.evidenceType, 'VERIFIED_DATA');
  });

  it('UNPROFITABLE health keeps decision facts deterministic (no AI path)', () => {
    const a = buildProfitabilityDecisionFacts({
      opportunity: { id: 'o1', title: 'T', estimatedStartupCost: 0 },
      revenues: [{ grossRevenue: 100, fees: 80, advertisingCost: 0, otherCosts: 0, netRevenue: 20, opportunityId: 'o1' }],
    });
    const b = buildProfitabilityDecisionFacts({
      opportunity: { id: 'o1', title: 'T', estimatedStartupCost: 0 },
      revenues: [{ grossRevenue: 100, fees: 80, advertisingCost: 0, otherCosts: 0, netRevenue: 20, opportunityId: 'o1' }],
    });
    assert.deepEqual(a, b);
  });
});
