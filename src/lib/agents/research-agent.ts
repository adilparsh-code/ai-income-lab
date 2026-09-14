import { db } from '@/lib/db';
import { BaseAgent, buildAgentLogData } from './base-agent';
import {
  AgentRequest,
  AgentResult,
  EvidenceType,
  ResearchRequest,
  ResearchResult,
  AiUsageMetadata,
} from './types';
import { generateValidated, identifyExecutionMode } from '@/lib/ai/generate';
import { getModelPolicy } from '@/lib/ai/models';
import {
  RESEARCH_SCHEMA,
  ResearchAiOutput,
  buildResearchPrompt,
  buildResearchResult,
  buildMockResearchOutput,
  evaluateHalalGate,
} from '@/lib/ai/research';

const INFERENCE: EvidenceType = 'AI_INFERENCE';
// Neutral screening defaults, clearly documented: AI screening does not measure
// confidence, so these never promote output above AI_INFERENCE.
const MOCK_CONFIDENCE = 0.6;
const LIVE_CONFIDENCE = 0.5;
const PURPOSE = 'research.findings';

/**
 * Research Agent (Phase 4.2.2).
 *
 * Provider-agnostic by design: this agent NEVER imports a concrete AI provider.
 * It depends only on the generic generation layer (generateValidated) plus the
 * provider-agnostic research helpers. The configured provider (mock/gemini/…) is
 * resolved internally by that layer. Adding a new provider requires ZERO changes
 * to this agent.
 */
export class ResearchAgent extends BaseAgent {
  constructor() {
    super({
      id: 'research-agent',
      type: 'research',
      name: 'Research Agent',
      description: 'Finds opportunities and market signals. Identifies trends, demand patterns, and underserved niches.',
      purpose: 'Discover and validate potential income opportunities by analyzing market data and identifying emerging trends.',
      currentCapability:
        'Research workflow with real provider support (Gemini) behind a provider-agnostic generation layer. ' +
        'Structured research output, halal safety gate, provenance (AI_INFERENCE), controlled failure on provider ' +
        'failure. Mock mode works fully offline; set AI_PROVIDER=gemini with a valid key for live calls.',
      status: 'MOCKED',
      evidencePolicy: 'All research findings are classified as AI_INFERENCE until verified by human or trusted data sources.',
      safeExecutionState: true,
      icon: 'Search',
    });
  }

  // Validate research request structure
  private validateResearchRequest(input: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const request = input as Partial<ResearchRequest>;

    if (!request.researchObjective || typeof request.researchObjective !== 'string' || request.researchObjective.trim().length === 0) {
      errors.push('Valid research objective is required');
    }

    if (request.opportunityId && typeof request.opportunityId !== 'string') {
      errors.push('opportunityId must be a string if provided');
    }

    if (request.targetAudience && typeof request.targetAudience !== 'string') {
      errors.push('targetAudience must be a string if provided');
    }

    if (request.marketCategory && typeof request.marketCategory !== 'string') {
      errors.push('marketCategory must be a string if provided');
    }

    if (request.geography && typeof request.geography !== 'string') {
      errors.push('geography must be a string if provided');
    }

    if (request.constraints && !Array.isArray(request.constraints)) {
      errors.push('constraints must be an array if provided');
    }

    if (request.halalRequirements && !Array.isArray(request.halalRequirements)) {
      errors.push('halalRequirements must be an array if provided');
    }

    return { valid: errors.length === 0, errors };
  }

  private emptyResearchResult(
    researchObjective: string,
    halalConsiderations: string[],
    capabilityStatus: 'LIVE' | 'MOCKED'
  ): ResearchResult {
    return {
      researchObjective,
      findings: [],
      signals: [],
      assumptions: [],
      risks:
        halalConsiderations.length > 0
          ? halalConsiderations.map((c) => `REVIEW/BLOCKED: ${c}`)
          : ['No execution recommendation generated.'],
      competitors: [],
      demandIndicators: [],
      monetizationObservations: [],
      halalConsiderations,
      overallConfidence: 0,
      evidenceItems: [],
      capabilityStatus,
    };
  }

  private buildReasoning(reviewRequired: boolean, live: boolean, provider?: string, model?: string): string {
    const reviewNote = reviewRequired ? ' Findings require human review (REVIEW_REQUIRED).' : '';
    const providerNote =
      live && provider && model
        ? ` Generated at AI-inference level via ${provider}/${model}; not verified external data.`
        : '';
    return `AI research completed with structured findings.${reviewNote}${providerNote}`;
  }

  /**
   * Persist a successful research result and return the AgentLog id. Builds the
   * persisted payload via the shared pure buildAgentLogData mapper so AI usage
   * metadata (provider/model/tokens/cost/fallback) is captured consistently.
   */
  private async persistResearchLog(
    request: AgentRequest,
    researchResult: ResearchResult,
    reasoning: string,
    aiUsage?: AiUsageMetadata,
    fallbackUsed = false
  ): Promise<string> {
    const result: AgentResult = {
      success: true,
      output: researchResult,
      reasoning,
      evidenceType: INFERENCE,
      executionTime: 0,
      capabilityStatus: researchResult.capabilityStatus,
      ...(aiUsage ? { aiUsage, fallbackUsed } : {}),
    };
    const entry = await db.agentLog.create({
      data: buildAgentLogData({
        agentType: this.type,
        action: request.action,
        input: request.input,
        result,
      }),
    });
    return entry.id;
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const startTime = Date.now();
    const researchRequest = request.input as unknown as ResearchRequest;

    // 1. Input Validation
    const validation = this.validateResearchRequest(researchRequest);
    if (!validation.valid) {
      const errorMessage = `Invalid research request: ${validation.errors.join(', ')}`;
      const result: AgentResult = {
        success: false,
        output: {},
        reasoning: errorMessage,
        evidenceType: INFERENCE,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 2. Opportunity Context Loading
    let opportunity: { id: string; title: string; problemSolved?: string; halalStatus: string; overallScore?: number } | null = null;
    let opportunityHalalStatus: string | null = null;

    if (researchRequest.opportunityId) {
      try {
        opportunity = await db.opportunity.findUnique({
          where: { id: researchRequest.opportunityId },
          select: { id: true, title: true, problemSolved: true, halalStatus: true, overallScore: true },
        });

        if (!opportunity) {
          const errorMessage = `Opportunity with ID ${researchRequest.opportunityId} not found`;
          const result: AgentResult = {
            success: false,
            output: {},
            reasoning: errorMessage,
            evidenceType: INFERENCE,
            error: errorMessage,
            executionTime: Date.now() - startTime,
          };
          await this.logExecution(request.action, request.input, result);
          return result;
        }

        opportunityHalalStatus = opportunity.halalStatus;
      } catch (dbError) {
        console.error('Database error details:', dbError);
        const errorMessage = 'Database error while loading opportunity';
        const result: AgentResult = {
          success: false,
          output: {},
          reasoning: errorMessage,
          evidenceType: INFERENCE,
          error: errorMessage,
          executionTime: Date.now() - startTime,
        };
        await this.logExecution(request.action, request.input, result);
        return result;
      }
    }

    // 3. Halal Safety Gate (screening tool, not a religious ruling)
    const halalGate = evaluateHalalGate({
      researchObjective: researchRequest.researchObjective,
      targetAudience: researchRequest.targetAudience,
      marketCategory: researchRequest.marketCategory,
      halalRequirements: researchRequest.halalRequirements,
      opportunityHalalStatus,
    });

    const mode = identifyExecutionMode();
    const capabilityStatus: 'LIVE' | 'MOCKED' = mode.isLive ? 'LIVE' : 'MOCKED';

    if (halalGate.status === 'BLOCKED') {
      const researchResult = this.emptyResearchResult(
        researchRequest.researchObjective,
        halalGate.considerations,
        capabilityStatus
      );
      const result: AgentResult = {
        success: false,
        output: researchResult,
        reasoning: 'Research blocked due to halal compliance checks.',
        evidenceType: INFERENCE,
        capabilityStatus,
        error: 'Halal compliance check failed',
        fallbackUsed: false,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 4. Build the structured research prompt (provider-agnostic).
    const prompt = buildResearchPrompt({
      researchObjective: researchRequest.researchObjective,
      targetAudience: researchRequest.targetAudience,
      marketCategory: researchRequest.marketCategory,
      geography: researchRequest.geography,
      constraints: researchRequest.constraints,
      halalRequirements: researchRequest.halalRequirements,
      opportunity,
      halalConsiderations: halalGate.considerations,
    });

    const policy = getModelPolicy(PURPOSE);

    // 5a. LIVE path — route through the generic AI generation layer. The agent
    // has NO knowledge of which concrete provider serves this call; that is
    // resolved internally by generateValidated() -> getProvider(). Adding another
    // provider never requires changes to this agent.
    if (mode.isLive) {
      const outcome = await generateValidated<ResearchAiOutput>(
        prompt,
        PURPOSE,
        RESEARCH_SCHEMA,
        {
          model: policy.model,
          maxOutputTokens: policy.maxOutputTokens,
          temperature: policy.temperature,
        }
      );

      if (outcome.ok) {
        const researchResult = buildResearchResult({
          researchObjective: researchRequest.researchObjective,
          research: outcome.value,
          halalConsiderations: halalGate.considerations,
          overallConfidence: LIVE_CONFIDENCE,
          capabilityStatus: 'LIVE',
          isMocked: false,
        });
        const aiUsage: AiUsageMetadata = {
          provider: outcome.usage.provider,
          model: outcome.usage.model,
          purpose: PURPOSE,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          estimatedCostUsd: outcome.usage.estimatedCostUsd,
          latencyMs: outcome.usage.latencyMs,
        };
        const reasoning = this.buildReasoning(
          halalGate.status === 'REVIEW',
          true,
          outcome.usage.provider,
          outcome.usage.model
        );
        researchResult.agentLogId = await this.persistResearchLog(request, researchResult, reasoning, aiUsage, false);

        return {
          success: true,
          output: researchResult,
          reasoning,
          evidenceType: INFERENCE,
          capabilityStatus: 'LIVE',
          aiUsage,
          fallbackUsed: false,
          executionTime: Date.now() - startTime,
        };
      }

      // Live path failed closed (retries + repair could not produce valid output).
      const researchResult = this.emptyResearchResult(
        researchRequest.researchObjective,
        halalGate.considerations,
        'LIVE'
      );
      const categories = (outcome.categories ?? []).join(', ') || 'unknown';
      const detail = outcome.errors[0] ?? 'AI provider failed to produce valid structured output';
      const result: AgentResult = {
        success: false,
        output: researchResult,
        reasoning: `AI research failed after ${outcome.attempts} attempt(s). Error categories: ${categories}.`,
        evidenceType: INFERENCE,
        capabilityStatus: 'LIVE',
        error: detail,
        fallbackUsed: true,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 5b. MOCKED path — deterministic, offline, no key/network required.
    const mockOutput = buildMockResearchOutput({
      researchObjective: researchRequest.researchObjective,
      marketCategory: researchRequest.marketCategory,
    });
    const researchResult = buildResearchResult({
      researchObjective: researchRequest.researchObjective,
      research: mockOutput,
      halalConsiderations: halalGate.considerations,
      overallConfidence: MOCK_CONFIDENCE,
      capabilityStatus: 'MOCKED',
      isMocked: true,
    });
    researchResult.agentLogId = await this.persistResearchLog(request, researchResult, 'Mock research execution completed.');

    return {
      success: true,
      output: researchResult,
      reasoning:
        halalGate.status === 'REVIEW'
          ? 'Mock research completed, but findings require human review (REVIEW_REQUIRED).'
          : 'Mock research execution completed successfully with structured findings.',
      evidenceType: INFERENCE,
      capabilityStatus: 'MOCKED',
      fallbackUsed: false,
      executionTime: Date.now() - startTime,
    };
  }
}