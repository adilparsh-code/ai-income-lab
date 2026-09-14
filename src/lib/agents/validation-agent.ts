import { db } from '@/lib/db';
import { BaseAgent } from './base-agent';
import { 
  AgentRequest, AgentResult, EvidenceType, 
  ValidationRequest, ValidationResult, 
  ValidationTest, ExperimentRecommendation, EvidenceItem 
} from './types';
import { v4 as uuidv4 } from 'uuid';

export class ValidationAgent extends BaseAgent {
  constructor() {
    super({
      id: 'validation-agent',
      type: 'validation',
      name: 'Validation Agent',
      description: 'Evaluates whether an opportunity is worth testing. Identifies risky assumptions, prioritizes tests, and defines validation requirements.',
      purpose: 'Help teams make evidence-based go/no-go decisions by systematically validating business assumptions and measuring real-world signals.',
      currentCapability: 'Mock validation workflow fully implemented. Executes structured validation requests with opportunity integration, halal safety checks, and evidence classification. All results are mocked examples.',
      status: 'MOCKED',
      evidencePolicy: 'All validation findings are classified as AI_INFERENCE until verified by human or trusted data sources.',
      safeExecutionState: true,
      icon: 'CheckCircle2',
    });
  }

  // Validate validation request structure
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

  async execute(request: AgentRequest): Promise<AgentResult> {
    const startTime = Date.now();
    const validationRequest = request.input as unknown as ValidationRequest;
    
    // 1. Input Validation
    const validation = this.validateValidationRequest(validationRequest);
    if (!validation.valid) {
      const errorMessage = `Invalid validation request: ${validation.errors.join(', ')}`;
      const result: AgentResult = {
        success: false,
        output: {},
        reasoning: errorMessage,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
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
          select: { id: true, title: true, problemSolved: true, halalStatus: true, overallScore: true }
        });
        
        if (!opportunity) {
          const errorMessage = `Opportunity with ID ${validationRequest.opportunityId} not found`;
          const result: AgentResult = {
            success: false,
            output: {},
            reasoning: errorMessage,
            evidenceType: 'AI_INFERENCE' as EvidenceType,
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
          evidenceType: 'AI_INFERENCE' as EvidenceType,
          error: errorMessage,
          executionTime: Date.now() - startTime,
        };
        await this.logExecution(request.action, request.input, result);
        return result;
      }
    }

    // 3. Halal Safety Check
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
          overallScore: opportunity.overallScore
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
        humanReviewRequired: humanReviewRequired,
        recommendation: 'BLOCKED',
        capabilityStatus: this.status
      };
      
      const result: AgentResult = {
        success: false,
        output: validationResult,
        reasoning: 'Validation blocked due to halal compliance checks',
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        error: 'Halal compliance check failed',
        executionTime: Date.now() - startTime,
      };
      
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 4. Generate Mock Validation Results
    const mockAssumptions: string[] = (validationRequest.keyAssumptions && validationRequest.keyAssumptions.length > 0) 
      ? validationRequest.keyAssumptions
      : ['Example assumption: The target market has a real pain point', 'Example assumption: Users are willing to pay for a solution'];

    const mockRisks: ValidationResult['prioritizedRisks'] = [
      {
        id: uuidv4(),
        risk: 'Example risk: Market demand may not meet expectations',
        severity: 'HIGH',
        likelihood: 0.6
      },
      {
        id: uuidv4(),
        risk: 'Example risk: Competitive landscape is more intense than anticipated',
        severity: 'MEDIUM',
        likelihood: 0.5
      },
      {
        id: uuidv4(),
        risk: 'Example risk: Technical implementation may take longer than planned',
        severity: 'MEDIUM',
        likelihood: 0.45
      }
    ];

    const mockTests: ValidationTest[] = [
      {
        id: uuidv4(),
        name: 'Market Interest Survey',
        method: 'SURVEY',
        description: 'Survey 50+ potential customers to validate pain point and willingness to pay',
        estimatedEffort: 'LOW',
        priority: 1
      },
      {
        id: uuidv4(),
        name: 'Landing Page Validation',
        method: 'LANDING_PAGE',
        description: 'Build a simple landing page to measure email capture rate and interest',
        estimatedEffort: 'MEDIUM',
        priority: 2
      },
      {
        id: uuidv4(),
        name: '1:1 Customer Interviews',
        method: 'INTERVIEW',
        description: 'Conduct 10-15 interviews with potential users to deep-dive into needs',
        estimatedEffort: 'MEDIUM',
        priority: 1
      }
    ];

    const mockExperiments: ExperimentRecommendation[] = [
      {
        id: uuidv4(),
        experimentName: 'Landing Page Conversion Test',
        hypothesis: 'At least 5% of visitors will provide their email if the value proposition is clear',
        method: 'EXPERIMENT',
        metric: 'Email capture rate',
        successThreshold: 0.05,
        failureThreshold: 0.01,
        estimatedEffort: 'LOW',
        priority: 1,
        evidenceNeeded: ['Traffic sources', 'Conversion rate', 'Bounce rate']
      },
      {
        id: uuidv4(),
        experimentName: 'Price Sensitivity Test',
        hypothesis: 'Customers will accept a price point of $49/month for the proposed solution',
        method: 'PRICE_TEST',
        metric: 'Purchase intent rate',
        successThreshold: 0.15,
        failureThreshold: 0.05,
        estimatedEffort: 'MEDIUM',
        priority: 2,
        evidenceNeeded: ['Survey responses', 'Price elasticity data']
      }
    ];

    // Add score suggestion if opportunity exists
    if (opportunity) {
      mockExperiments.push({
        id: uuidv4(),
        experimentName: 'Opportunity Score Validation',
        hypothesis: 'Validation will confirm current score is appropriate',
        method: 'MANUAL_RESEARCH',
        metric: 'Score correlation with real-world signals',
        successThreshold: 0.85,
        failureThreshold: 0.5,
        estimatedEffort: 'MEDIUM',
        priority: 3,
        evidenceNeeded: ['Validation signal / suggested input: Opportunity score could be updated to 7.2/10 based on initial validation']
      });
    }

    // Current evidence (only AI_INFERENCE and USER_ENTERED, no VERIFIED_DATA for mocks)
    const currentEvidence: EvidenceItem[] = [
      {
        id: uuidv4(),
        type: 'AI_INFERENCE',
        content: 'Preliminary analysis suggests market opportunity exists but requires validation',
        source: 'Validation Agent'
      }
    ];

    if (validationRequest.keyAssumptions?.length) {
      validationRequest.keyAssumptions.forEach(assumption => {
        currentEvidence.push({
          id: uuidv4(),
          type: 'USER_ENTERED',
          content: `User-provided assumption: ${assumption}`,
          source: 'User input'
        });
      });
    }

    // 5. Create final validation result
    const finalValidationResult: ValidationResult = {
      opportunityContext: opportunity ? {
        id: opportunity.id,
        title: opportunity.title,
        problemSolved: opportunity.problemSolved,
        overallScore: opportunity.overallScore
      } : undefined,
      validationObjective: validationRequest.validationObjective,
      assumptions: mockAssumptions,
      prioritizedRisks: mockRisks,
      validationTests: mockTests,
      experimentRecommendations: mockExperiments,
      successCriteria: ['Achieve 5%+ email capture rate on landing page', 'Validate 3+ core assumptions with customer interviews', 'Confirm price sensitivity in target market'],
      failureCriteria: ['<1% email capture rate for 1000+ visitors', 'None of the core assumptions validated in interviews', 'Price sensitivity <5% in target audience'],
      evidenceRequirements: ['Customer interview transcripts', 'Landing page analytics', 'Survey response data'],
      currentEvidence,
      confidence: 0.55,
      halalStatus: opportunityHalalStatus || 'UNKNOWN',
      humanReviewRequired: humanReviewRequired,
      recommendation: humanReviewRequired ? 'NEEDS_VALIDATION' : 'PROMISING',
      capabilityStatus: this.status
    };

    // 6. Create AgentLog entry
    const agentLog = await db.agentLog.create({
      data: {
        agentType: this.type,
        action: request.action,
        input: JSON.stringify(request.input),
        output: JSON.stringify(finalValidationResult),
        reasoning: 'Mock validation execution completed successfully',
        evidenceType: 'AI_INFERENCE'
      }
    });
    
    finalValidationResult.agentLogId = agentLog.id;

    const finalResult: AgentResult = {
      success: true,
      output: finalValidationResult,
      reasoning: humanReviewRequired 
        ? 'Mock validation completed, but findings require human review due to REVIEW_REQUIRED opportunity status'
        : 'Mock validation execution completed successfully with structured findings and experiment recommendations. Real-world validation has NOT been performed.',
      evidenceType: 'AI_INFERENCE' as EvidenceType,
      executionTime: Date.now() - startTime,
    };

    return finalResult;
  }
}