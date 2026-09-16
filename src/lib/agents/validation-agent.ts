import { BaseAgent } from './base-agent';
import { getExecutionMode, persistAgentLog } from './agent-ai';
import {
  AgentRequest, AgentResult, EvidenceType, AiUsageMetadata, AgentStatus,
  ValidationRequest, ValidationResult,
  ValidationTest, ExperimentRecommendation, EvidenceItem,
} from './types';
import { v4 as uuidv4 } from 'uuid';import { db } from '@/lib/db';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { generateValidated } from '@/lib/ai/generate';
import {
  VALIDATION_AI_SCHEMA,
  buildValidationPrompt,
  buildMockValidationOutput,
  normalizeValidationAiOutput,
  ValidationAiOutput,
} from '@/lib/ai/agent-prompts';

const INFERENCE: EvidenceType = 'AI_INFERENCE';
const PURPOSE = 'validation.tests';

/**
 * Validation Agent (Phase 4.2.3).
 *
 * Provider-agnostic by design: it never imports a concrete AI provider. Live
 * output flows through generateValidated() with the validation purpose policy;
 * mock mode stays fully deterministic/offline; AI failures fail closed to a
 * clearly-labelled deterministic fallback — a failed AI call can NEVER be
 * re-labelled as VERIFIED_DATA or presented as live output.
 */
export class ValidationAgent extends BaseAgent {
  constructor() {
    super({
      id: 'validation-agent',
      type: 'validation',
      name: 'Validation Agent',
      description: 'Evaluates whether an opportunity is worth testing. Identifies risky assumptions, prioritizes tests, and defines validation requirements.',
      purpose: 'Help teams make evidence-based go/no-go decisions by systematically validating business assumptions and measuring real-world signals.',
      currentCapability:
        'Validation workflow with real provider support behind the provider-agnostic generation layer. ' +
        'Structured validation plans, halal safety gates, provenance (AI_INFERENCE), and fail-closed fallback. ' +
        'Mock mode works fully offline; set AI_PROVIDER=gemini with a valid key for live calls.',
      status: 'MOCKED',
      evidencePolicy: 'All validation findings are classified as AI_INFERENCE until verified by human or trusted data sources. User-entered assumptions are USER_ENTERED.',
      safeExecutionState: true,
      icon: 'CheckCircle2',
    });
  }

  private validateValidationRequest(input: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const request = input as Partial<ValidationRequest>;

    if (!request.validationObjective || typeof request.validationObjective !== 'string' || request.validationObjective.trim().length === 0) {
      errors.push('Valid validation objective is required');
    }

    if (request.opportunityId && typeof request.opportunityId !== 'string') {
      errors.push('opportunityId must be a string if provided');
    }

    if (request.targetAudience && typeof request.targetAudience !== 'string') {
      errors.push('targetAudience must be a string if provided');
    }

    if (request.keyAssumptions && !Array.isArray(request.keyAssumptions)) {
      errors.push('keyAssumptions must be an array if provided');
    }

    if (request.validationConstraints && !Array.isArray(request.validationConstraints)) {
      errors.push('validationConstraints must be an array if provided');
    }

    if (request.preferredValidationMethod && !['LANDING_PAGE', 'SURVEY', 'INTERVIEW', 'PREORDER', 'CONTENT_TEST', 'PRICE_TEST', 'EXPERIMENT', 'MANUAL_RESEARCH'].includes(request.preferredValidationMethod)) {
      errors.push('Invalid preferredValidationMethod provided');
    }

    if (request.halalRequirements && !Array.isArray(request.halalRequirements)) {
      errors.push('halalRequirements must be an array if provided');
    }

    return { valid: errors.length === 0, errors };
  }

  private failure(message: string, error: string, executionTime: number, output: unknown = {}): AgentResult {
    return {
      success: false,
      output,
      reasoning: message,
      evidenceType: INFERENCE,
      error,
      executionTime,
    };
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const startTime = Date.now();
    const validationRequest = request.input as unknown as ValidationRequest;

    // 1. Input Validation
    const validation = this.validateValidationRequest(validationRequest);
    if (!validation.valid) {
      const errorMessage = `Invalid validation request: ${validation.errors.join(', ')}`;
      const result = this.failure(errorMessage, errorMessage, Date.now() - startTime);
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 2. Opportunity Context Loading
    let opportunity: { id: string; title: string; problemSolved?: string; halalStatus: string; overallScore?: number } | null = null;
    let opportunityHalalStatus: string | null = null;

    if (validationRequest.opportunityId) {
      try {
        opportunity = await db.opportunity.findUnique({
          where: { id: validationRequest.opportunityId },
          select: { id: true, title: true, problemSolved: true, halalStatus: true, overallScore: true },
        });

        if (!opportunity) {
          const errorMessage = `Opportunity with ID ${validationRequest.opportunityId} not found`;
          const result = this.failure(errorMessage, errorMessage, Date.now() - startTime);
          await this.logExecution(request.action, request.input, result);
          return result;
        }

        opportunityHalalStatus = opportunity.halalStatus;
      } catch (dbError) {
        console.error('Database error details:', dbError);
        const errorMessage = 'Database error while loading opportunity';
        const result = this.failure(errorMessage, errorMessage, Date.now() - startTime);
        await this.logExecution(request.action, request.input, result);
        return result;
      }
    }

    // 3. Halal Safety Gates — deterministic, before ANY AI call.
    const halalConsiderations: string[] = [];
    let validationBlocked = false;
    let humanReviewRequired = false;

    if (opportunityHalalStatus === 'NOT_ALLOWED') {
      validationBlocked = true;
      halalConsiderations.push('Validation blocked: Opportunity has NOT_ALLOWED halal status');
      halalConsiderations.push('No execution recommendations will be generated per halal safety rules');
    } else if (opportunityHalalStatus === 'REVIEW_REQUIRED') {
      humanReviewRequired = true;
      halalConsiderations.push('Human review required: Opportunity has REVIEW_REQUIRED halal status');
      halalConsiderations.push('All findings must be reviewed by a qualified human before any execution');
    }

    if (validationBlocked) {
      const validationResult: ValidationResult = {
        opportunityContext: opportunity ? {
          id: opportunity.id,
          title: opportunity.title,
          problemSolved: opportunity.problemSolved,
          overallScore: opportunity.overallScore,
        } : undefined,
        validationObjective: validationRequest.validationObjective,
        assumptions: [],
        prioritizedRisks: [],
        validationTests: [],
        experimentRecommendations: [],
        successCriteria: [],
        failureCriteria: [],
        evidenceRequirements: [],
        currentEvidence: [],
        confidence: 0,
        halalStatus: opportunityHalalStatus || 'UNKNOWN',
        humanReviewRequired: false,
        recommendation: 'BLOCKED',
        capabilityStatus: this.status,
      };

      const result: AgentResult = {
        success: false,
        output: validationResult,
        reasoning: 'Validation blocked due to halal compliance checks',
        evidenceType: INFERENCE,
        error: 'Halal compliance check failed',
        fallbackUsed: false,
        executionTime: Date.now() - startTime,
      };

      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 4. Resolve execution mode. For NOT_ALLOWED we NEVER call the provider —
    // guaranteed above because the blocked branch returns before this point.
    const mode = getExecutionMode();

    // 4b. Deterministic request-level halal screening on free-text fields —
    // catches impermissible objectives even when no opportunity is linked.
    // Runs BEFORE any AI call; screening is a tool, not a religious ruling.
    const requestScreen = screenForHalalCompliance(
      validationRequest.validationObjective,
      validationRequest.targetAudience ?? '',
      '',
      '',
      (validationRequest.halalRequirements ?? []).join(' ')
    );
    if (requestScreen.status === 'NOT_ALLOWED') {
      halalConsiderations.push('Validation blocked: the objective screened as NOT_ALLOWED by halal compliance rules.');
      const validationResult: ValidationResult = {
        validationObjective: validationRequest.validationObjective,
        assumptions: [],
        prioritizedRisks: [],
        validationTests: [],
        experimentRecommendations: [],
        successCriteria: [],
        failureCriteria: [],
        evidenceRequirements: [],
        currentEvidence: [],
        confidence: 0,
        halalStatus: 'NOT_ALLOWED',
        humanReviewRequired: false,
        recommendation: 'BLOCKED',
        capabilityStatus: mode.capabilityStatus,
      };
      const blockedResult: AgentResult = {
        success: false,
        output: validationResult,
        reasoning: 'Validation blocked due to halal compliance checks',
        evidenceType: INFERENCE,
        error: 'Halal compliance check failed',
        fallbackUsed: false,
        executionTime: Date.now() - startTime,
      };
      await this.logExecution(request.action, request.input, blockedResult);
      return blockedResult;
    }
    if (requestScreen.status === 'REVIEW_REQUIRED') {
      humanReviewRequired = true;
      halalConsiderations.push('Human review required: the objective screened as REVIEW_REQUIRED for halal compliance.');
    }

    // 5. Build the provider-agnostic prompt.
    const prompt = buildValidationPrompt({
      validationObjective: validationRequest.validationObjective,
      targetAudience: validationRequest.targetAudience,
      keyAssumptions: validationRequest.keyAssumptions,
      validationConstraints: validationRequest.validationConstraints,
      preferredValidationMethod: validationRequest.preferredValidationMethod,
      halalRequirements: validationRequest.halalRequirements,
      opportunity,
      halalConsiderations,
      isMocked: mode.isMocked,
    });

    // 6. MOCKED path — deterministic, offline, no key/network required.
    if (mode.isMocked) {
      const mockOutput = buildMockValidationOutput({
        validationObjective: validationRequest.validationObjective,
        keyAssumptions: validationRequest.keyAssumptions,
        opportunityExists: !!opportunity,
      });
      const output = this.buildValidationResult({
        aiOutput: mockOutput,
        validationRequest,
        opportunity,
        opportunityHalalStatus,
        halalConsiderations,
        humanReviewRequired,
        capabilityStatus: 'MOCKED',
        aiUsage: undefined,
        fallbackUsed: false,
      });

      const reasoning = humanReviewRequired
        ? 'Mock validation completed, but findings require human review due to REVIEW_REQUIRED opportunity status.'
        : 'Mock validation execution completed with structured findings. Real-world validation has NOT been performed.';

      const logId = await this.persistSingle(request, output, reasoning, mode.capabilityStatus, undefined, false);

      return {
        success: true,
        output: { ...output, agentLogId: logId },
        reasoning,
        evidenceType: INFERENCE,
        capabilityStatus: 'MOCKED',
        fallbackUsed: false,
        executionTime: Date.now() - startTime,
      };
    }

    // 7. LIVE path — route through the generic AI generation layer. Model/token
    // policy comes from the purpose-specific policy inside generateValidated()
    // (including AI_MODEL_VALIDATION env overrides); no redundant overrides here.
    const outcome = await generateValidated<Record<string, unknown>>(
      prompt,
      PURPOSE,
      VALIDATION_AI_SCHEMA,
    );

    if (outcome.ok) {
      const aiOutput: ValidationAiOutput = normalizeValidationAiOutput(outcome.value);
      const aiUsage: AiUsageMetadata = {
        provider: outcome.usage.provider,
        model: outcome.usage.model,
        purpose: PURPOSE,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        estimatedCostUsd: outcome.usage.estimatedCostUsd,
        latencyMs: outcome.usage.latencyMs,
      };
      const output = this.buildValidationResult({
        aiOutput,
        validationRequest,
        opportunity,
        opportunityHalalStatus,
        halalConsiderations,
        humanReviewRequired,
        capabilityStatus: 'LIVE',
        aiUsage,
        fallbackUsed: false,
      });
      const reasoning = this.buildReasoning(humanReviewRequired, aiUsage);
      const logId = await this.persistSingle(request, output, reasoning, 'LIVE', aiUsage, false);

      return {
        success: true,
        output: { ...output, agentLogId: logId },
        reasoning,
        evidenceType: INFERENCE,
        capabilityStatus: 'LIVE',
        aiUsage,
        fallbackUsed: false,
        executionTime: Date.now() - startTime,
      };
    }

    // 8. LIVE path failed closed: retries + repair could not produce schema-
    // valid output. Deterministic fallback is used and clearly marked — it is
    // NEVER presented as successful AI output and never VERIFIED_DATA.
    const fallbackOutput = buildMockValidationOutput({
      validationObjective: validationRequest.validationObjective,
      keyAssumptions: validationRequest.keyAssumptions,
      opportunityExists: !!opportunity,
    });
    const output = this.buildValidationResult({
      aiOutput: fallbackOutput,
      validationRequest,
      opportunity,
      opportunityHalalStatus,
      halalConsiderations,
      humanReviewRequired,
      capabilityStatus: 'MOCKED',
      aiUsage: undefined,
      fallbackUsed: true,
      degraded: true,
    });

    const categories = (outcome.categories ?? []).join(', ') || 'unknown';
    const reasoning =
      `AI validation failed after ${outcome.attempts} attempt(s) (categories: ${categories}). ` +
      'Deterministic fallback guidance is provided and clearly marked MOCKED; no live AI conclusions are included.';
    const logId = await this.persistSingle(request, output, reasoning, mode.capabilityStatus, undefined, true);

    return {
      success: false,
      output: { ...output, agentLogId: logId },
      reasoning,
      evidenceType: INFERENCE,
      capabilityStatus: mode.capabilityStatus,
      error: outcome.errors[0] ?? 'AI provider failed to produce valid structured output',
      fallbackUsed: true,
      executionTime: Date.now() - startTime,
    };
  }

  private buildReasoning(reviewRequired: boolean, aiUsage: AiUsageMetadata): string {
    const reviewNote = reviewRequired ? ' Findings require human review (REVIEW_REQUIRED).' : '';
    return `AI validation completed via ${aiUsage.provider}/${aiUsage.model}; all output is AI_INFERENCE, not verified data.${reviewNote}`;
  }

  /** Persist exactly one AgentLog entry for this execution. */
  private async persistSingle(
    request: AgentRequest,
    output: ValidationResult,
    reasoning: string,
    capabilityStatus: AgentStatus,
    aiUsage?: AiUsageMetadata,
    fallbackUsed = false,
  ): Promise<string | undefined> {
    const result: AgentResult = {
      success: true,
      output,
      reasoning,
      evidenceType: INFERENCE,
      executionTime: 0,
      capabilityStatus,
      ...(aiUsage ? { aiUsage, fallbackUsed } : { fallbackUsed }),
    };
    return persistAgentLog({ agentType: this.type, action: request.action, request, result });
  }

  private buildValidationResult(input: {
    aiOutput: ValidationAiOutput;
    validationRequest: ValidationRequest;
    opportunity: { id: string; title: string; problemSolved?: string; halalStatus: string; overallScore?: number } | null;
    opportunityHalalStatus: string | null;
    halalConsiderations: string[];
    humanReviewRequired: boolean;
    capabilityStatus: 'LIVE' | 'MOCKED';
    aiUsage?: AiUsageMetadata;
    fallbackUsed: boolean;
    degraded?: boolean;
  }): ValidationResult {
    const { aiOutput } = input;

    const validationTests: ValidationTest[] = aiOutput.tests.map((t) => ({
      id: uuidv4(),
      name: t.name,
      method: t.method,
      description: t.description,
      estimatedEffort: t.estimatedEffort,
      priority: t.priority,
    }));

    const experimentRecommendations: ExperimentRecommendation[] = aiOutput.experimentRecommendations.map((e) => ({
      id: uuidv4(),
      experimentName: e.experimentName,
      hypothesis: e.hypothesis,
      method: e.method,
      metric: e.metric,
      successThreshold: e.successThreshold,
      failureThreshold: e.failureThreshold,
      estimatedEffort: e.estimatedEffort,
      priority: e.priority,
      evidenceNeeded: e.evidenceNeeded,
    }));

    const prioritizedRisks = aiOutput.risks.map((r) => ({
      id: uuidv4(),
      risk: r.risk,
      severity: r.severity,
      likelihood: r.likelihood,
    }));

    // Current evidence: AI output is AI_INFERENCE; user-entered assumptions are
    // USER_ENTERED. AI output can NEVER be promoted to VERIFIED_DATA here.
    const currentEvidence: EvidenceItem[] = aiOutput.assumptions.map((a) => ({
      id: uuidv4(),
      type: INFERENCE,
      content: a,
      source: 'Validation Agent (AI)',
    }));
    if (input.validationRequest.keyAssumptions?.length) {
      input.validationRequest.keyAssumptions.forEach((assumption) => {
        currentEvidence.push({
          id: uuidv4(),
          type: 'USER_ENTERED',
          content: `User-provided assumption: ${assumption}`,
          source: 'User input',
        });
      });
    }

    const recommendation = input.humanReviewRequired ? 'NEEDS_VALIDATION' : aiOutput.recommendation;

    return {
      opportunityContext: input.opportunity ? {
        id: input.opportunity.id,
        title: input.opportunity.title,
        problemSolved: input.opportunity.problemSolved,
        overallScore: input.opportunity.overallScore,
      } : undefined,
      validationObjective: input.validationRequest.validationObjective,
      assumptions: aiOutput.assumptions,
      prioritizedRisks,
      validationTests,
      experimentRecommendations,
      successCriteria: aiOutput.successCriteria,
      failureCriteria: aiOutput.failureCriteria,
      evidenceRequirements: aiOutput.evidenceRequirements,
      currentEvidence,
      confidence: aiOutput.confidence,
      halalStatus: input.opportunityHalalStatus || 'UNKNOWN',
      humanReviewRequired: input.humanReviewRequired,
      recommendation,
      capabilityStatus: input.capabilityStatus,
    };
  }
}