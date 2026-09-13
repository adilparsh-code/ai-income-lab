import { db } from '@/lib/db';
import { BaseAgent } from './base-agent';
import {
  AgentRequest, AgentResult, AgentStatus, EvidenceType,
  BusinessManagerRequest, BusinessManagerResult, BusinessManagerScope,
  ActionType, DecisionState, NextBestAction, EvidenceItem,
} from './types';
import { v4 as uuidv4 } from 'uuid';

const VALID_SCOPES: BusinessManagerScope[] = [
  'OPPORTUNITY_SELECTION', 'VALIDATION_DECISION', 'PRODUCT_DECISION',
  'EXPERIMENT_DECISION', 'REVENUE_IMPROVEMENT', 'FULL_BUSINESS_REVIEW',
];

const VALID_ACTIONS: ActionType[] = [
  'RESEARCH', 'VALIDATE', 'BUILD_PRODUCT', 'RUN_EXPERIMENT',
  'ANALYZE', 'IMPROVE_PRODUCT', 'REVIEW_REVENUE', 'COLLECT_DATA',
  'HUMAN_REVIEW', 'NO_ACTION',
];

export class BusinessManagerAgent extends BaseAgent {
  constructor() {
    super({
      id: 'business-manager-agent',
      type: 'business-manager',
      name: 'Business Manager',
      description: 'Orchestrates research, validation, product, and analytics insights to produce a transparent, evidence-aware Next Best Action for your business.',
      purpose: 'Coordinate evidence from across AI Income Lab to recommend exactly one primary next-best-action, with transparent rationale, alternative explanations, and strict halal safety gates. Never autonomous. Never fabricates business facts.',
      currentCapability: 'Live orchestration implemented. Reads real database records for opportunities, experiments, products, and revenue. Produces evidence-aware decisions with halal safety gates. All recommendations require human approval.',
      status: 'MOCKED',
      evidencePolicy: 'Decisions are based on real database state (VERIFIED_DATA). Recommendations, interpretations, and next-best-actions are AI_INFERENCE. Research/validation/product agent outputs referenced are AI_INFERENCE/MOCKED. All actions require human approval.',
      safeExecutionState: true,
      icon: 'Crown',
    });
  }

  private validateBusinessManagerRequest(input: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const req = input as Partial<BusinessManagerRequest>;

    if (!req.objective || typeof req.objective !== 'string' || req.objective.trim().length === 0) {
      errors.push('Valid objective is required');
    }
    if (!req.decisionScope || !VALID_SCOPES.includes(req.decisionScope as BusinessManagerScope)) {
      errors.push('decisionScope must be one of: ' + VALID_SCOPES.join(', '));
    }
    if (req.opportunityId && typeof req.opportunityId !== 'string') {
      errors.push('opportunityId must be a string if provided');
    }
    if (req.productId && typeof req.productId !== 'string') {
      errors.push('productId must be a string if provided');
    }
    if (req.experimentId && typeof req.experimentId !== 'string') {
      errors.push('experimentId must be a string if provided');
    }
    if (req.riskTolerance && !['LOW', 'MEDIUM', 'HIGH'].includes(req.riskTolerance)) {
      errors.push('riskTolerance must be LOW, MEDIUM, or HIGH if provided');
    }
    if (req.preferredActionType && !VALID_ACTIONS.includes(req.preferredActionType as ActionType)) {
      errors.push('Invalid preferredActionType provided');
    }
    if (req.halalRequirements && !Array.isArray(req.halalRequirements)) {
      errors.push('halalRequirements must be an array if provided');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const startTime = Date.now();
    const bmRequest = request.input as unknown as BusinessManagerRequest;

    // 1. Input Validation
    const validation = this.validateBusinessManagerRequest(bmRequest);
    if (!validation.valid) {
      const errorMessage = 'Invalid business manager request: ' + validation.errors.join(', ');
      const result: AgentResult = {
        success: false, output: {},
        reasoning: errorMessage,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 2. Load Real Database Data
    let opportunities: Awaited<ReturnType<typeof db.opportunity.findMany>> = [];
    let experiments: Awaited<ReturnType<typeof db.experiment.findMany>> = [];
    let products: Awaited<ReturnType<typeof db.product.findMany>> = [];
    let revenues: Awaited<ReturnType<typeof db.revenue.findMany>> = [];
    let selectedOpportunity: typeof opportunities[number] | null = null;
    let notAllowed = false;
    let humanReviewRequired = false;

    try {
      const results = await Promise.all([
        db.opportunity.findMany(),
        db.experiment.findMany(),
        db.product.findMany(),
        db.revenue.findMany(),
      ]);
      opportunities = results[0];
      experiments = results[1];
      products = results[2];
      revenues = results[3];
    } catch (dbError) {
      console.error('Database error details:', dbError);
      const errorMessage = 'Database error while loading business data';
      const result: AgentResult = {
        success: false, output: {},
        reasoning: errorMessage,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 3. Resolve Scoped Entity
    if (bmRequest.opportunityId) {
      const found = opportunities.find(o => o.id === bmRequest.opportunityId);
      if (!found) {
        const errorMessage = 'Opportunity with ID "' + bmRequest.opportunityId + '" not found';
        const result: AgentResult = { success: false, output: {}, reasoning: errorMessage, evidenceType: 'AI_INFERENCE' as EvidenceType, error: errorMessage, executionTime: Date.now() - startTime };
        await this.logExecution(request.action, request.input, result);
        return result;
      }
      selectedOpportunity = found;
      if (found.halalStatus === 'NOT_ALLOWED') notAllowed = true;
      if (found.halalStatus === 'REVIEW_REQUIRED') humanReviewRequired = true;
    } else if (bmRequest.productId) {
      const prod = products.find(p => p.id === bmRequest.productId);
      if (prod && prod.opportunityId) {
        selectedOpportunity = opportunities.find(o => o.id === prod.opportunityId) || null;
      }
    } else if (bmRequest.experimentId) {
      const exp = experiments.find(e => e.id === bmRequest.experimentId);
      if (exp && exp.opportunityId) {
        selectedOpportunity = opportunities.find(o => o.id === exp.opportunityId) || null;
      }
    }

    // 4. OPPORTUNITY SELECTION (when no specific opportunity provided)
    if (!selectedOpportunity && ['OPPORTUNITY_SELECTION', 'FULL_BUSINESS_REVIEW'].includes(bmRequest.decisionScope)) {
      const eligibleOpps = opportunities.filter(o =>
        o.halalStatus !== 'NOT_ALLOWED' &&
        !['REJECTED', 'PAUSED'].includes(o.status)
      );
      if (eligibleOpps.length > 0) {
        eligibleOpps.sort((a, b) => b.overallScore - a.overallScore);
        selectedOpportunity = eligibleOpps[0];
        if (selectedOpportunity.halalStatus === 'REVIEW_REQUIRED') humanReviewRequired = true;
      } else {
        const reviewOpps = opportunities.filter(o => o.halalStatus === 'REVIEW_REQUIRED' && !['REJECTED', 'PAUSED'].includes(o.status));
        if (reviewOpps.length > 0) {
          reviewOpps.sort((a, b) => b.overallScore - a.overallScore);
          selectedOpportunity = reviewOpps[0];
          humanReviewRequired = true;
        }
      }
    }

    // 5. EVIDENCE ASSESSMENT
    const oppId = selectedOpportunity?.id;
    const oppExperiments = experiments.filter(e => e.opportunityId === oppId);
    const oppProducts = products.filter(p => p.opportunityId === oppId);
    const oppRevenues = revenues.filter(r => r.opportunityId === oppId);
    const productRevenues = oppProducts.length > 0
      ? revenues.filter(r => oppProducts.some(p => p.id === r.productId))
      : [];

    // Evidence flags based on REAL database state
    const hasOpportunity = !!selectedOpportunity;
    const hasExperimentData = oppExperiments.some(e => e.visitors > 0 || e.sales > 0 || e.revenue > 0 || !!e.decision);
    const hasCompletedExperiment = oppExperiments.some(e => ['SCALE', 'KILL'].includes(e.decision || ''));
    const hasPositiveExperiment = oppExperiments.some(e => e.decision === 'SCALE');
    const hasProduct = oppProducts.length > 0;
    const hasPublishedProduct = oppProducts.some(p => ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status));
    const hasRevenue = oppRevenues.length > 0 || productRevenues.length > 0;
    const totalNetRevenue = [...oppRevenues, ...productRevenues].reduce((s, r) => s + r.netRevenue, 0);
    const hasProfitData = oppProducts.some(p => p.cost > 0);
    const isResearching = selectedOpportunity?.status === 'RESEARCHING';
    const isValidating = selectedOpportunity?.status === 'VALIDATING';
    const isValidated = selectedOpportunity?.status === 'VALIDATED';

    // 6. RESEARCH / VALIDATION / PRODUCT / ANALYTICS SUMMARIES
    const researchSummary = isResearching
      ? 'Opportunity is currently in RESEARCHING status. Research Agent can provide AI-generated market analysis (AI_INFERENCE).'
      : hasOpportunity
        ? 'Opportunity exists' + (isResearching ? ' and is being researched' : '. No active research status detected. Research Agent output would be AI_INFERENCE.')
        : 'No opportunity selected. Research Agent requires an opportunity to analyze.';

    const validationSummary = hasExperimentData
      ? 'Experiment data exists: ' + oppExperiments.length + ' experiment(s) with real metrics. ' + (hasCompletedExperiment ? 'At least one completed experiment.' : 'No completed experiments yet.')
      : hasOpportunity
        ? 'No experiment data found for this opportunity. Validation Agent can design tests but real-world evidence is missing.'
        : 'No opportunity selected for validation assessment.';

    const productSummary = hasProduct
      ? oppProducts.length + ' product(s) linked to opportunity. ' + (hasPublishedProduct ? 'At least one published/earning product exists.' : 'No published products yet.')
      : hasOpportunity
        ? 'No products exist for this opportunity. Product Agent can generate a product concept (AI_INFERENCE).'
        : 'No opportunity selected for product assessment.';

    const analyticsSummary = hasRevenue
      ? 'Revenue data exists: $' + totalNetRevenue.toFixed(2) + ' net revenue from ' + (oppRevenues.length + productRevenues.length) + ' record(s). ' + (hasProfitData ? 'Cost data available for profitability analysis.' : 'Cost data unavailable; profitability cannot be determined.')
      : hasOpportunity
        ? 'No revenue data for this opportunity. Record revenue entries to enable financial analysis.'
        : 'No opportunity selected for analytics.';

    // 7. MISSING INFORMATION
    const missingInformation: string[] = [];
    if (!hasOpportunity) missingInformation.push('No opportunity selected or found.');
    if (hasOpportunity && !isResearching && !isValidating && !isValidated) missingInformation.push('No research evidence on file.');
    if (hasOpportunity && !hasExperimentData) missingInformation.push('No real-world validation experiment data.');
    if (hasOpportunity && !hasProduct) missingInformation.push('No product created.');
    if (hasOpportunity && !hasRevenue) missingInformation.push('No revenue data recorded.');
    if (hasProduct && !hasProfitData) missingInformation.push('Product cost data missing; profitability unknown.');

    // 8. DECISION ENGINE
    let decision: DecisionState = 'NO_ACTION';
    let primaryAction: ActionType = 'NO_ACTION';
    let primaryReason = '';
    let primaryEvidence = '';
    let primaryPurpose = '';
    let executionEligible = false;
    const blockers: string[] = [];
    const alternativeActionsConsidered: { action: ActionType; reasonRejected: string; evidenceType: EvidenceType }[] = [];

    // HARD GATE: NOT_ALLOWED
    if (notAllowed) {
      decision = 'BLOCKED';
      primaryAction = 'NO_ACTION';
      primaryReason = 'This opportunity is NOT_ALLOWED under halal compliance. No execution recommendation can be made.';
      primaryEvidence = 'Opportunity halalStatus is NOT_ALLOWED in database.';
      primaryPurpose = 'None - opportunity is blocked.';
      blockers.push('NOT_ALLOWED: Opportunity is halal-blocked.');
      alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'Opportunity is NOT_ALLOWED', evidenceType: 'VERIFIED_DATA' });
      alternativeActionsConsidered.push({ action: 'RUN_EXPERIMENT', reasonRejected: 'Opportunity is NOT_ALLOWED', evidenceType: 'VERIFIED_DATA' });
      alternativeActionsConsidered.push({ action: 'RESEARCH', reasonRejected: 'Opportunity is NOT_ALLOWED', evidenceType: 'VERIFIED_DATA' });
    }
    // HARD GATE: REVIEW_REQUIRED
    else if (humanReviewRequired) {
      decision = 'HUMAN_REVIEW';
      primaryAction = 'HUMAN_REVIEW';
      primaryReason = 'This opportunity requires human review for halal compliance before any action can be recommended.';
      primaryEvidence = 'Opportunity halalStatus is REVIEW_REQUIRED in database.';
      primaryPurpose = 'Obtain human halal compliance review before proceeding.';
      blockers.push('REVIEW_REQUIRED: Human review needed.');
      alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'REVIEW_REQUIRED must be resolved first', evidenceType: 'VERIFIED_DATA' });
      alternativeActionsConsidered.push({ action: 'RUN_EXPERIMENT', reasonRejected: 'REVIEW_REQUIRED must be resolved first', evidenceType: 'VERIFIED_DATA' });
    }
    // No opportunity found
    else if (!hasOpportunity) {
      decision = 'COLLECT_MORE_DATA';
      primaryAction = 'RESEARCH';
      primaryReason = 'No opportunity is available to review. An opportunity must exist before business decisions can be made.';
      primaryEvidence = 'Zero opportunities in database or none match criteria.';
      primaryPurpose = 'Identify or create a business opportunity to analyze.';
      blockers.push('No opportunity available.');
      alternativeActionsConsidered.push({ action: 'ANALYZE', reasonRejected: 'No opportunity to analyze', evidenceType: 'VERIFIED_DATA' });
    }
    // Decision based on evidence chain
    else {
      if (!isResearching && !isValidating && !isValidated && !hasExperimentData) {
        // No research, no validation
        decision = 'VALIDATE_FIRST';
        primaryAction = bmRequest.decisionScope === 'PRODUCT_DECISION' ? 'VALIDATE' : 'RESEARCH';
        primaryReason = 'Opportunity exists but has no research or validation evidence. Real-world evidence is needed before product or execution decisions.';
        primaryEvidence = 'Opportunity status: ' + (selectedOpportunity?.status || 'IDEA') + '. No experiment data on file.';
        primaryPurpose = primaryAction === 'RESEARCH' ? 'Gather market intelligence to inform opportunity assessment.' : 'Design and run a validation experiment to test real demand.';
        alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'No validation evidence exists', evidenceType: 'AI_INFERENCE' });
        alternativeActionsConsidered.push({ action: 'ANALYZE', reasonRejected: 'Insufficient data for meaningful analysis', evidenceType: 'AI_INFERENCE' });
      } else if (!hasExperimentData && (isResearching || isValidating)) {
        // Research/validation in progress but no data yet
        decision = 'VALIDATE_FIRST';
        primaryAction = 'RUN_EXPERIMENT';
        primaryReason = 'Research or validation is underway but no real experiment data exists yet. A validation experiment is needed.';
        primaryEvidence = 'Status: ' + (selectedOpportunity?.status || 'unknown') + '. Zero experiments with metrics on file.';
        primaryPurpose = 'Generate real-world demand and conversion data.';
        alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'Validation evidence insufficient', evidenceType: 'AI_INFERENCE' });
      } else if (hasExperimentData && !hasCompletedExperiment) {
        // Has experiment data but not completed
        decision = 'IMPROVE';
        primaryAction = 'RUN_EXPERIMENT';
        primaryReason = 'Experiment data exists but no experiment has reached a final decision (SCALE/KILL). Continue or complete the experiment.';
        primaryEvidence = oppExperiments.length + ' experiment(s) with data, none with final decision.';
        primaryPurpose = 'Complete validation by reaching a data-driven experiment decision.';
        alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'Experiment not yet complete', evidenceType: 'VERIFIED_DATA' });
      } else if (hasCompletedExperiment && !hasPositiveExperiment && !hasProduct) {
        // Completed experiment but not positive, no product
        decision = 'IMPROVE';
        primaryAction = 'COLLECT_DATA';
        primaryReason = 'Experiment completed without SCALE decision. More data or iteration needed before building.';
        primaryEvidence = 'Best experiment decision: ' + (oppExperiments.find(e => e.decision)?.decision || 'none') + '.';
        primaryPurpose = 'Understand why validation did not succeed and determine next steps.';
        alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'Validation did not pass', evidenceType: 'VERIFIED_DATA' });
      } else if ((hasPositiveExperiment || isValidated) && !hasProduct) {
        // Validated but no product
        decision = 'PROCEED';
        primaryAction = 'BUILD_PRODUCT';
        primaryReason = 'Opportunity has sufficient validation evidence but no product exists. Ready to build.';
        primaryEvidence = hasPositiveExperiment ? 'Experiment SCALE decision recorded.' : 'Opportunity status is VALIDATED.';
        primaryPurpose = 'Convert validated opportunity into a product.';
        executionEligible = true;
        alternativeActionsConsidered.push({ action: 'RUN_EXPERIMENT', reasonRejected: 'Already validated', evidenceType: 'VERIFIED_DATA' });
      } else if (hasProduct && !hasPublishedProduct) {
        // Product exists but not published
        decision = 'IMPROVE';
        primaryAction = 'IMPROVE_PRODUCT';
        primaryReason = 'Product exists but is not yet published/earning. Improve and prepare for launch.';
        primaryEvidence = oppProducts.length + ' product(s), none in PUBLISHED/EARNING status.';
        primaryPurpose = 'Complete and publish the product.';
        executionEligible = true;
        alternativeActionsConsidered.push({ action: 'RUN_EXPERIMENT', reasonRejected: 'Product already exists', evidenceType: 'VERIFIED_DATA' });
      } else if (hasPublishedProduct && !hasRevenue) {
        // Published but no revenue
        decision = 'IMPROVE';
        primaryAction = 'IMPROVE_PRODUCT';
        primaryReason = 'Product is published but generating no revenue. Improve offer, distribution, or discovery.';
        primaryEvidence: primaryEvidence = 'Product published but $0.00 net revenue recorded.';
        primaryPurpose = 'Increase product revenue through improvements.';
        executionEligible = true;
        alternativeActionsConsidered.push({ action: 'REVIEW_REVENUE', reasonRejected: 'No revenue to review yet', evidenceType: 'VERIFIED_DATA' });
      } else if (hasRevenue && totalNetRevenue <= 0) {
        // Revenue exists but net is zero or negative
        decision = 'IMPROVE';
        primaryAction = 'REVIEW_REVENUE';
        primaryReason = 'Revenue exists but net revenue is $' + totalNetRevenue.toFixed(2) + '. Review fees, costs, and pricing.';
        primaryEvidence = 'Net revenue: $' + totalNetRevenue.toFixed(2) + ' from ' + (oppRevenues.length + productRevenues.length) + ' records.';
        primaryPurpose = 'Improve unit economics.';
        executionEligible = true;
      } else if (hasRevenue && totalNetRevenue > 0) {
        // Positive net revenue
        decision = 'PROCEED';
        primaryAction = 'ANALYZE';
        primaryReason = 'Positive net revenue of $' + totalNetRevenue.toFixed(2) + ' recorded. Analyze performance to optimize and scale.';
        primaryEvidence = 'Net revenue: $' + totalNetRevenue.toFixed(2) + '. Product published and earning.';
        primaryPurpose = 'Optimize and scale what is working.';
        executionEligible = true;
        alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'Already have a revenue-generating product', evidenceType: 'VERIFIED_DATA' });
      } else {
        decision = 'COLLECT_MORE_DATA';
        primaryAction = 'COLLECT_DATA';
        primaryReason = 'Insufficient evidence to make a confident recommendation.';
        primaryEvidence = 'Database state does not match a clear decision path.';
        primaryPurpose = 'Gather more data to enable evidence-based decisions.';
      }
    }

    // 9. BUILD NEXT BEST ACTION
    const nextBestAction: NextBestAction = {
      action: primaryAction,
      reason: primaryReason,
      evidence: primaryEvidence,
      evidenceType: 'AI_INFERENCE' as EvidenceType,
      priority: 1,
      expectedPurpose: primaryPurpose,
      blockers,
      humanApprovalRequired: true,
      executionEligible: executionEligible && !notAllowed && !humanReviewRequired,
    };

    // 10. RISKS AND ASSUMPTIONS
    const risks: string[] = [];
    if (notAllowed) risks.push('NOT_ALLOWED: Opportunity is halal-blocked.');
    if (humanReviewRequired) risks.push('REVIEW_REQUIRED: Human review needed before proceeding.');
    if (!hasOpportunity) risks.push('No opportunity available for decision.');
    if (hasOpportunity && !hasExperimentData) risks.push('No real-world validation data. Decisions are based on limited evidence.');
    if (hasProduct && !hasProfitData) risks.push('Product cost data missing. Profitability cannot be determined.');
    if (hasRevenue && totalNetRevenue <= 0) risks.push('Net revenue is not positive.');
    if (risks.length === 0) risks.push('No critical risks identified from available data.');

    const assumptions: string[] = [
      'Decision is based on actual database records only.',
      'Research/validation/product agent outputs referenced are AI_INFERENCE or MOCKED unless verified by real data.',
      'Revenue figures are recorded values, not inferred or projected. Revenue is not profit.',
      'This recommendation requires human approval before any execution.',
    ];

    // 11. EVIDENCE
    const evidence: EvidenceItem[] = [
      { id: uuidv4(), type: 'USER_ENTERED' as EvidenceType, content: 'Objective: ' + bmRequest.objective, source: 'User input' },
      { id: uuidv4(), type: 'USER_ENTERED' as EvidenceType, content: 'Decision scope: ' + bmRequest.decisionScope, source: 'User input' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Opportunities in database: ' + opportunities.length, source: 'Prisma db.opportunity' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Experiments in database: ' + experiments.length, source: 'Prisma db.experiment' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Products in database: ' + products.length, source: 'Prisma db.product' },
      { id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Revenue records in database: ' + revenues.length, source: 'Prisma db.revenue' },
    ];
    if (selectedOpportunity) {
      evidence.push({ id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Selected opportunity: "' + selectedOpportunity.title + '" (score: ' + selectedOpportunity.overallScore + ', status: ' + selectedOpportunity.status + ', halal: ' + selectedOpportunity.halalStatus + ')', source: 'Prisma db.opportunity' });
    }
    evidence.push({ id: uuidv4(), type: 'AI_INFERENCE' as EvidenceType, content: 'Next-best-action and decision rationale are AI-generated inferences.', source: 'Business Manager Agent' });

    // 12. RECOMMENDATION
    let recommendation: string;
    if (notAllowed) {
      recommendation = 'BLOCKED: This opportunity is NOT_ALLOWED. No execution recommendation. Consider other opportunities.';
    } else if (humanReviewRequired) {
      recommendation = 'HUMAN REVIEW REQUIRED: ' + selectedOpportunity?.title + ' needs halal review. Action: ' + primaryAction.replace(/_/g, ' ') + '.';
    } else if (!hasOpportunity) {
      recommendation = 'No opportunity available. Create or select an opportunity first.';
    } else {
      recommendation = 'Next Best Action: ' + primaryAction.replace(/_/g, ' ') + '. ' + primaryReason;
    }

    const confidence = !hasOpportunity ? 0.1 : notAllowed ? 0.9 : humanReviewRequired ? 0.5 : hasRevenue && totalNetRevenue > 0 ? 0.8 : hasExperimentData ? 0.6 : 0.4;

    const finalResult: BusinessManagerResult = {
      decision,
      decisionRationale: primaryReason,
      nextBestAction,
      alternativeActionsConsidered,
      confidence,
      opportunityContext: selectedOpportunity ? {
        id: selectedOpportunity.id,
        title: selectedOpportunity.title,
        overallScore: selectedOpportunity.overallScore,
        status: selectedOpportunity.status,
        halalStatus: selectedOpportunity.halalStatus,
      } : undefined,
      researchSummary,
      researchEvidenceType: 'AI_INFERENCE' as EvidenceType,
      validationSummary,
      validationEvidenceType: hasExperimentData ? 'VERIFIED_DATA' as EvidenceType : 'AI_INFERENCE' as EvidenceType,
      productSummary,
      productEvidenceType: hasProduct ? 'VERIFIED_DATA' as EvidenceType : 'AI_INFERENCE' as EvidenceType,
      analyticsSummary,
      analyticsEvidenceType: hasRevenue ? 'VERIFIED_DATA' as EvidenceType : 'AI_INFERENCE' as EvidenceType,
      evidence,
      assumptions,
      risks,
      blockers,
      missingInformation,
      halalStatus: selectedOpportunity?.halalStatus || 'UNKNOWN',
      humanReviewRequired: notAllowed ? false : humanReviewRequired,
      executionEligible: executionEligible && !notAllowed && !humanReviewRequired,
      recommendation,
      capabilityStatus: this.status as AgentStatus,
    };

    // 13. AGENTLOG
    try {
      const agentLog = await db.agentLog.create({
        data: {
          agentType: this.type,
          action: request.action,
          input: JSON.stringify(request.input),
          output: JSON.stringify(finalResult),
          reasoning: 'Business Manager decision: ' + decision + ', action: ' + primaryAction,
          evidenceType: 'AI_INFERENCE',
        },
      });
      finalResult.agentLogId = agentLog.id;
    } catch (logError) {
      console.error('Failed to log Business Manager execution: ' + logError);
    }

    return {
      success: true,
      output: finalResult,
      reasoning: 'Business Manager completed review. Decision: ' + decision + '. Next Best Action: ' + primaryAction + '.',
      evidenceType: 'AI_INFERENCE' as EvidenceType,
      executionTime: Date.now() - startTime,
    };
  }
}
