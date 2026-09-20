import { db } from '@/lib/db';
import { BaseAgent } from './base-agent';
import { buildAgentContext } from './agent-context';
import { buildIntelligenceView, type IntelligenceView } from './intelligence';
import { buildProfitabilityDecisionFacts, type ProfitabilityDecisionFacts } from '@/lib/business/business-manager-profitability';
import {
  resolveProductPipelineState,
  selectRoutingPipelineState,
  type ProductPipelineState,
} from '@/lib/product-factory/pipeline';
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
  'RESEARCH', 'VALIDATE', 'BUILD_PRODUCT', 'CONNECT_PUBLISHING', 'RUN_EXPERIMENT',
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
    // Phase 6 — shared agent context + deterministic intelligence view.
    // Built only when a concrete opportunity is resolved; failures degrade to
    // absent intelligence (never fabricated, never blocks the decision tree).
    let intelligence: IntelligenceView | null = null;
    let contextMemory: { label: string; text: string; evidenceType: string }[] = [];
    let contextHandoffCount = 0;
    let contextMissingEvidence: string[] = [];
    let contextProvenance = { verified: 0, userEntered: 0, aiInference: 0, mocked: 0 };
    let contextPreviousDecisions: { decision: string; action: string; recordedAt: string; sourceRef: string }[] = [];
    let contextAssembledAt: string | null = null;
    let contextHumanReviewState: { required: boolean; reason: string | null } = { required: false, reason: null };
    let contextEvidenceStrength: { strength: string; basis: string } | null = null;

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

    // 3.5 AGENT COORDINATION (consume existing agents' last executions from AgentLog)
    const agentTypesToCoordinate = ['research', 'validation', 'product', 'analytics'];
    const agentLastExecutions: { agentType: string; summary: string; evidenceType: EvidenceType; executedAt: Date | null }[] = [];
    try {
      const recentLogs = await db.agentLog.findMany({
        where: { agentType: { in: agentTypesToCoordinate } },
        orderBy: { createdAt: 'desc' },
        take: 40,
      });
      for (const agentType of agentTypesToCoordinate) {
        const last = recentLogs.find(l => l.agentType === agentType);
        agentLastExecutions.push({
          agentType,
          // SECURITY: upstream reasoning text is untrusted data — strip control
          // characters that could forge prompt line structure before it is
          // embedded in any downstream AI prompt.
          summary: last
            ? 'Last ' + agentType + ' execution recorded: ' + (last.reasoning || '(no reasoning text)').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').slice(0, 200) + '. Output is ' + (last.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED_DATA from real records' : 'AI_INFERENCE (not independently verified)') + '.'
            : 'No recorded ' + agentType + ' agent execution yet. Its capability has not been used for this context.',
          evidenceType: last && last.evidenceType === 'VERIFIED_DATA' ? 'VERIFIED_DATA' as EvidenceType : 'AI_INFERENCE' as EvidenceType,
          executedAt: last ? last.createdAt : null,
        });
      }
    } catch (coordError) {
      console.error('Agent coordination lookup failed:', coordError);
      for (const agentType of agentTypesToCoordinate) {
        agentLastExecutions.push({ agentType, summary: 'No recorded ' + agentType + ' agent execution available (lookup failed).', evidenceType: 'AI_INFERENCE' as EvidenceType, executedAt: null });
      }
    }

    // 3.6 SHARED AGENT CONTEXT (Phase 6) — assemble the intelligent-layer view
    // from real records. The decision tree below stays authoritative; this
    // context enriches evidence, memory, conflicts, and the routing rationale.
    // Failures degrade to absent intelligence (never fabricated, never block).
    if (selectedOpportunity) {
      try {
        const ctx = await buildAgentContext(selectedOpportunity.id);
        const view = buildIntelligenceView(ctx);
        intelligence = view;
        contextMemory = ctx.businessMemory;
        contextHandoffCount = ctx.handoffs.length;
        contextMissingEvidence = ctx.missingEvidence;
        contextProvenance = ctx.provenance;
        contextPreviousDecisions = ctx.previousDecisions;
        contextAssembledAt = ctx.assembledAt;
        contextEvidenceStrength = { strength: ctx.evidenceStrength.strength, basis: ctx.evidenceStrength.basis };
        contextHumanReviewState = {
          required: ctx.humanReviewState.required,
          reason: ctx.humanReviewState.reason,
        };
        // The context's human-review state must reinforce (never relax) the
        // agent's own halal flags.
        if (ctx.humanReviewState.required && !notAllowed) humanReviewRequired = true;
      } catch (contextError) {
        console.error('Agent context assembly failed:', contextError);
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
    // Combined, deduplicated revenue set linked to this opportunity (directly or via its products)
    const combinedRevenues = Array.from(
      new Map<string, typeof revenues[number]>(
        [...oppRevenues, ...productRevenues].map(r => [r.id, r])
      ).values()
    );

    // Evidence flags based on REAL database state
    const hasOpportunity = !!selectedOpportunity;
    const hasExperimentData = oppExperiments.some(e => e.visitors > 0 || e.sales > 0 || e.revenue > 0 || !!e.decision);
    const hasCompletedExperiment = oppExperiments.some(e => ['SCALE', 'KILL'].includes(e.decision || ''));
    const hasPositiveExperiment = oppExperiments.some(e => e.decision === 'SCALE');
    const hasProduct = oppProducts.length > 0;
    const hasPublishedProduct = oppProducts.some(p => ['PUBLISHED', 'EARNING', 'IMPROVING'].includes(p.status));

    // Phase B — durable product-pipeline state (VERIFIED_DATA from the
    // ProductSpecification rows). The decision engine branches on the REAL
    // pipeline stage, never on a guess; lookup failure degrades to absent
    // pipeline state (NOT_STARTED semantics are NOT fabricated for specs
    // that could not be read).
    let latestSpecByProduct = new Map<string, { status: string; version: number }>();
    let pipelineStateLookupFailed = false;
    if (oppProducts.length > 0) {
      try {
        const specRows = await db.productSpecification.findMany({
          where: { productId: { in: oppProducts.map(p => p.id) } },
          orderBy: { version: 'desc' },
          select: { productId: true, status: true, version: true },
        });
        for (const row of specRows) {
          if (!latestSpecByProduct.has(row.productId)) {
            latestSpecByProduct.set(row.productId, { status: row.status, version: row.version });
          }
        }
      } catch (specError) {
        console.error('Product pipeline state lookup failed:', specError);
        pipelineStateLookupFailed = true;
      }
    }
    const pipelineStates: ProductPipelineState[] = pipelineStateLookupFailed
      ? []
      : oppProducts.map(p => resolveProductPipelineState({
          productStatus: p.status,
          latestSpecStatus: latestSpecByProduct.get(p.id)?.status ?? null,
        }));
    const pipelineState = selectRoutingPipelineState(pipelineStates);
    const hasRevenue = combinedRevenues.length > 0;
    const totalNetRevenue = combinedRevenues.reduce((s, r) => s + r.netRevenue, 0);
    const hasProfitData = oppProducts.some(p => p.cost > 0);
    const isResearching = selectedOpportunity?.status === 'RESEARCHING';
    const isValidating = selectedOpportunity?.status === 'VALIDATING';
    const isValidated = selectedOpportunity?.status === 'VALIDATED';

    // 5.5 VERIFIED PROFITABILITY (deterministic business-intelligence layer)
    // The decision engine branches on revenueHealth for revenue-bearing paths.
    // Financial numbers here are computed deterministically from stored
    // records; the engine never lets AI invent or alter them.
    let profitabilityFacts: ProfitabilityDecisionFacts | null = null;
    if (selectedOpportunity) {
      try {
        profitabilityFacts = buildProfitabilityDecisionFacts({
          opportunity: {
            id: selectedOpportunity.id,
            title: selectedOpportunity.title,
            estimatedStartupCost: selectedOpportunity.estimatedStartupCost,
          },
          revenues: combinedRevenues,
        });
      } catch (profitabilityError) {
        console.error('Profitability decision-fact computation failed:', profitabilityError);
        profitabilityFacts = null;
      }
    }

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
      ? oppProducts.length + ' product(s) linked to opportunity. ' + (hasPublishedProduct ? 'At least one published/earning product exists.' : 'No published products yet. ')
        + (pipelineStateLookupFailed
          ? 'Product pipeline state could not be read (lookup failed); nothing was assumed.'
          : 'Product creation pipeline state: ' + pipelineState + ' (from ProductSpecification records).')
      : hasOpportunity
        ? 'No products exist for this opportunity. Product Agent can generate a product concept (AI_INFERENCE).'
        : 'No opportunity selected for product assessment.';

    const analyticsSummary = hasRevenue
      ? 'Revenue data exists: $' + totalNetRevenue.toFixed(2) + ' net revenue from ' + combinedRevenues.length + ' record(s). ' + (hasProfitData ? 'Cost data available for profitability analysis.' : 'Cost data unavailable; profitability cannot be determined.')
      : hasOpportunity
        ? 'No revenue data for this opportunity. Record revenue entries to enable financial analysis.'
        : 'No opportunity selected for analytics.';

    // Verified profitability summary (deterministic, VERIFIED_DATA when data exists)
    const profitabilitySummary = profitabilityFacts
      ? profitabilityFacts.summary
      : hasOpportunity
        ? 'No verified profitability analysis is available for this opportunity (no linked revenue records).'
        : 'No opportunity selected for profitability analysis.';
    const profitabilityEvidenceType: EvidenceType = profitabilityFacts?.evidenceType === 'VERIFIED_DATA'
      ? 'VERIFIED_DATA'
      : 'AI_INFERENCE';

    // 7. MISSING INFORMATION
    const missingInformation: string[] = [];
    if (!hasOpportunity) missingInformation.push('No opportunity selected or found.');
    if (hasOpportunity && !isResearching && !isValidating && !isValidated) missingInformation.push('No research evidence on file.');
    if (hasOpportunity && !hasExperimentData) missingInformation.push('No real-world validation experiment data.');
    if (hasOpportunity && !hasProduct) missingInformation.push('No product created.');
    if (hasOpportunity && !hasRevenue) missingInformation.push('No revenue data recorded.');
    if (hasProduct && !hasProfitData) missingInformation.push('Product cost data missing; profitability unknown.');
    if (hasProduct && !pipelineStateLookupFailed && pipelineState === 'NOT_STARTED') {
      missingInformation.push('No Phase B product specification on file; run the product creation pipeline.');
    }

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
        // Phase B — the product-pipeline state decides what "improve" means:
        //   READY_FOR_PUBLISHING → the creation pipeline is DONE; the next
        //     step is the publishing capability (NOT_CONFIGURED, human-gated).
        //     Never autonomous: executionEligible stays false.
        //   BLOCKED / SAFETY_FAILED → the safety gate refused this product;
        //     a qualified human must review before any further product work.
        //   IN_PROGRESS / QUALITY_FAILED → resume the deterministic creation
        //     pipeline through the Job Runner (PRODUCT_CREATE with the
        //     opportunityId creates the next spec version).
        //   NOT_STARTED → legacy product without a Phase B spec; improve it.
        if (pipelineState === 'READY_FOR_PUBLISHING') {
          decision = 'PROCEED';
          primaryAction = 'CONNECT_PUBLISHING';
          primaryReason = 'The product creation pipeline completed all stages (specification → generation → content/assets → quality → safety → landing → package) and the package is READY_FOR_PUBLISHING. No publishing capability is connected (NOT_CONFIGURED); connect an authorized provider and obtain explicit human approval before anything is published.';
          primaryEvidence = 'Latest product specification status READY_FOR_PUBLISHING; product lifecycle status ' + (oppProducts[0]?.status || 'unknown') + '.';
          primaryPurpose = 'Connect an authorized publishing provider and record explicit human approval before any publication.';
          executionEligible = false; // external, irreversible, human-gated
          alternativeActionsConsidered.push({ action: 'IMPROVE_PRODUCT', reasonRejected: 'Creation pipeline is complete; the next step is the publishing capability, not more generation', evidenceType: 'VERIFIED_DATA' });
          alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'Package already READY_FOR_PUBLISHING; re-running would duplicate a finished product', evidenceType: 'VERIFIED_DATA' });
        } else if (pipelineState === 'BLOCKED' || pipelineState === 'SAFETY_FAILED') {
          decision = 'HUMAN_REVIEW';
          primaryAction = 'HUMAN_REVIEW';
          primaryReason = 'A product was stopped by the halal/safety gate (pipeline state: ' + pipelineState + '). A qualified human must review before any further product work; no autonomous execution.';
          primaryEvidence = 'Product pipeline state ' + pipelineState + ' (ProductSpecification/Product records).';
          primaryPurpose = 'Human review of the safety-gated product before any further work.';
          blockers.push('SAFETY_GATE: Product pipeline state ' + pipelineState + ' requires human review.');
          alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'The safety gate stopped this product; human review comes first', evidenceType: 'VERIFIED_DATA' });
          alternativeActionsConsidered.push({ action: 'IMPROVE_PRODUCT', reasonRejected: 'Product work must not resume before human review clears the safety gate', evidenceType: 'VERIFIED_DATA' });
        } else if (pipelineState === 'IN_PROGRESS' || pipelineState === 'QUALITY_FAILED') {
          const latestSpec = latestSpecByProduct.get(oppProducts[0]!.id) ?? null;
          decision = 'PROCEED';
          primaryAction = 'BUILD_PRODUCT';
          primaryReason = 'A product specification exists but the creation pipeline has not completed (pipeline state: ' + pipelineState + (latestSpec ? ', latest spec v' + latestSpec.version + ' status ' + latestSpec.status : '') + '). Re-running the deterministic pipeline resumes with a new version through the Job Runner; the quality gate will re-verify.';
          primaryEvidence = 'Product pipeline state ' + pipelineState + (latestSpec ? '; latest spec v' + latestSpec.version + ' (' + latestSpec.status + ')' : '') + '; product lifecycle ' + (oppProducts[0]?.status || 'unknown') + '.';
          primaryPurpose = 'Resume the deterministic product creation pipeline (specification → generation → content/assets → quality → safety → landing → package → READY_FOR_PUBLISHING).';
          executionEligible = true;
          alternativeActionsConsidered.push({ action: 'IMPROVE_PRODUCT', reasonRejected: 'The creation pipeline has not completed; resume the pipeline instead', evidenceType: 'VERIFIED_DATA' });
        } else {
          // NOT_STARTED (or state unreadable): legacy product without a
          // Phase B specification.
          decision = 'IMPROVE';
          primaryAction = 'IMPROVE_PRODUCT';
          primaryReason = 'Product exists but is not yet published/earning. Improve and prepare for launch.';
          primaryEvidence = oppProducts.length + ' product(s), none in PUBLISHED/EARNING status.';
          primaryPurpose = 'Complete and publish the product.';
          executionEligible = true;
          alternativeActionsConsidered.push({ action: 'RUN_EXPERIMENT', reasonRejected: 'Product already exists', evidenceType: 'VERIFIED_DATA' });
        }
      } else if (hasPublishedProduct && !hasRevenue) {
        // Published but no revenue
        decision = 'IMPROVE';
        primaryAction = 'IMPROVE_PRODUCT';
        primaryReason = 'Product is published but generating no revenue. Improve offer, distribution, or discovery.';
        primaryEvidence = 'Product published but $0.00 net revenue recorded.';
        primaryPurpose = 'Increase product revenue through improvements.';
        executionEligible = true;
        alternativeActionsConsidered.push({ action: 'REVIEW_REVENUE', reasonRejected: 'No revenue to review yet', evidenceType: 'VERIFIED_DATA' });
      } else if (hasRevenue && totalNetRevenue <= 0) {
        // Revenue exists but net is zero or negative
        decision = 'IMPROVE';
        primaryAction = 'REVIEW_REVENUE';
        primaryReason = 'Revenue exists but net revenue is $' + totalNetRevenue.toFixed(2) + '. Review fees, costs, and pricing.';
        primaryEvidence = 'Net revenue: $' + totalNetRevenue.toFixed(2) + ' from ' + combinedRevenues.length + ' records.';
        primaryPurpose = 'Improve unit economics.';
        executionEligible = true;
      } else if (hasRevenue && totalNetRevenue > 0) {
        // Positive net revenue — refine with deterministic profitability.
        // VERIFIED_DATA: unprofitable contribution economics divert from
        // scale-up to cost review BEFORE any growth recommendation.
        if (profitabilityFacts?.revenueHealth === 'UNPROFITABLE') {
          decision = 'IMPROVE';
          primaryAction = 'REVIEW_REVENUE';
          primaryReason =
            'Net revenue is positive ($' + totalNetRevenue.toFixed(2) + ') but contribution profit is $' +
            profitabilityFacts.contributionProfit.toFixed(2) +
            ' after fees and variable costs. Review fees, costs, and pricing before scaling.';
          primaryEvidence = profitabilityFacts.summary;
          primaryPurpose = 'Make unit economics contribution-positive before scaling.';
          executionEligible = true;
        } else {
          decision = 'PROCEED';
          primaryAction = 'ANALYZE';
          primaryReason = 'Positive net revenue of $' + totalNetRevenue.toFixed(2) + ' recorded' +
            (profitabilityFacts
              ? ' with verified contribution profit of $' + profitabilityFacts.contributionProfit.toFixed(2)
              : '') + '. Analyze performance to optimize and scale.';
          primaryEvidence = profitabilityFacts?.summary ?? ('Net revenue: $' + totalNetRevenue.toFixed(2) + '. Product published and earning.');
          primaryPurpose = 'Optimize and scale what is working.';
          executionEligible = true;
          alternativeActionsConsidered.push({ action: 'BUILD_PRODUCT', reasonRejected: 'Already have a revenue-generating product', evidenceType: 'VERIFIED_DATA' });
        }
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
    if (profitabilityFacts?.revenueHealth === 'UNPROFITABLE') {
      risks.push('Contribution profit is not positive after fees and variable costs; scaling now would amplify losses.');
    }
    if (risks.length === 0) risks.push('No critical risks identified from available data.');

    const assumptions: string[] = [
      'Decision is based on actual database records only.',
      'Research/validation/product agent outputs referenced are AI_INFERENCE or MOCKED unless verified by real data.',
      'Revenue figures are recorded values, not inferred or projected. Revenue is not profit.',
      'Profitability figures come from the deterministic business-intelligence layer; AI does not alter them.',
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
    if (profitabilityFacts) {
      evidence.push({
        id: uuidv4(),
        type: profitabilityFacts.evidenceType,
        content: profitabilityFacts.summary,
        source: 'Business Intelligence layer (deterministic)',
      });
      for (const warning of profitabilityFacts.warnings) {
        evidence.push({ id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Profitability data quality: ' + warning, source: 'Business Intelligence layer (deterministic)' });
      }
    }

    // Agent coordination context (orchestrated agent outputs, provenance preserved)
    for (const coord of agentLastExecutions) {
      evidence.push({ id: uuidv4(), type: coord.evidenceType, content: 'Agent coordination [' + coord.agentType + ']: ' + coord.summary, source: 'AgentLog (existing agent architecture)' });
    }

    // Phase B — durable product-pipeline state as VERIFIED_DATA evidence.
    for (const [productId, spec] of Array.from(latestSpecByProduct.entries()).slice(0, 3)) {
      const product = oppProducts.find(p => p.id === productId);
      evidence.push({
        id: uuidv4(),
        type: 'VERIFIED_DATA' as EvidenceType,
        content: 'Product pipeline [' + (product?.name ?? productId) + ']: latest spec v' + spec.version + ' status ' + spec.status
          + '; product lifecycle ' + (product?.status ?? 'unknown') + '.',
        source: 'Prisma db.productSpecification',
      });
    }

    // Phase 6 — intelligent-layer evidence: shared context, memory, handoffs,
    // conflicts, and the deterministic routing decision. All items carry the
    // provenance they were recorded with; nothing is upgraded to VERIFIED_DATA.
    if (intelligence) {
      evidence.push({
        id: uuidv4(),
        type: 'AI_INFERENCE' as EvidenceType,
        content: 'Intelligent routing: ' + intelligence.nextStep.action + ' (' + (intelligence.nextStep.agent ?? 'no agent') + '). ' + intelligence.nextStep.reason,
        source: 'Deterministic router (intelligent-routing)',
      });
      evidence.push({
        id: uuidv4(),
        type: 'VERIFIED_DATA' as EvidenceType,
        content: 'Evidence strength: ' + intelligence.conflicts.considered.length + ' recorded agent position(s) assessed; strength basis: ' + (contextEvidenceStrength?.basis ?? 'not assessed'),
        source: 'AgentContext (stored provenance)',
      });
      if (intelligence.conflicts.hasConflict) {
        evidence.push({
          id: uuidv4(),
          type: 'VERIFIED_DATA' as EvidenceType,
          content: 'Conflict detected: ' + intelligence.conflicts.conflictDescription + ' Resolution: ' + intelligence.conflicts.resolutionReason,
          source: 'Deterministic conflict assessment (coordination)',
        });
      }
      if (contextHandoffCount > 0) {
        evidence.push({ id: uuidv4(), type: 'AI_INFERENCE' as EvidenceType, content: 'Upstream handoffs attached: ' + contextHandoffCount + ' (research → validation → product chain).', source: 'AgentContext handoffs' });
      }
      for (const item of contextMemory.slice(0, 5)) {
        evidence.push({ id: uuidv4(), type: 'AI_INFERENCE' as EvidenceType, content: 'Business memory [' + item.evidenceType + ']: ' + item.text, source: 'AgentContext memory (' + item.label + ')' });
      }
      for (const decision of contextPreviousDecisions.slice(0, 3)) {
        evidence.push({ id: uuidv4(), type: 'VERIFIED_DATA' as EvidenceType, content: 'Previous BM decision: ' + decision.decision + ' → ' + decision.action + ' (' + decision.recordedAt + ').', source: decision.sourceRef });
      }
    }

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

    const confidence = !hasOpportunity ? 0.1 : notAllowed ? 0.9 : humanReviewRequired ? 0.5 : hasRevenue && totalNetRevenue > 0 ? (profitabilityFacts?.revenueHealth === 'PROFITABLE' ? 0.85 : 0.75) : hasExperimentData ? 0.6 : 0.4;

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
      profitabilitySummary,
      profitabilityEvidenceType,
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
      ...(intelligence && contextAssembledAt
        ? {
            intelligence: {
              nextStep: {
                action: intelligence.nextStep.action,
                agent: intelligence.nextStep.agent,
                reason: intelligence.nextStep.reason,
                humanApprovalRequired: intelligence.nextStep.humanApprovalRequired,
                requiresAi: intelligence.nextStep.requiresAi,
              },
              conflict: {
                hasConflict: intelligence.conflicts.hasConflict,
                description: intelligence.conflicts.conflictDescription,
                safeAction: intelligence.conflicts.safeAction,
                resolutionReason: intelligence.conflicts.resolutionReason,
                positions: intelligence.conflicts.considered.map((p) => ({
                  agent: p.agent,
                  signal: p.signal,
                  evidenceType: p.evidenceType,
                })),
              },
              evidenceStrength: contextEvidenceStrength ?? { strength: 'MISSING', basis: 'Context assembly unavailable.' },
              contextSummary: {
                assembledAt: contextAssembledAt,
                provenance: contextProvenance,
                missingEvidence: contextMissingEvidence,
                businessMemory: contextMemory.slice(0, 6),
                handoffCount: contextHandoffCount,
                humanReviewState: contextHumanReviewState,
              },
            },
          }
        : {}),
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
