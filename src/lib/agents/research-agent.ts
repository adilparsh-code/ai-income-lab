import { db } from '@/lib/db';
import { BaseAgent } from './base-agent';
import { AgentRequest, AgentResult, EvidenceType, ResearchRequest, ResearchResult, ResearchFinding, ResearchSignal } from './types';
import { v4 as uuidv4 } from 'uuid';

export class ResearchAgent extends BaseAgent {
  constructor() {
    super({
      id: 'research-agent',
      type: 'research',
      name: 'Research Agent',
      description: 'Finds opportunities and market signals. Identifies trends, demand patterns, and underserved niches.',
      purpose: 'Discover and validate potential income opportunities by analyzing market data and identifying emerging trends.',
      currentCapability: 'Mock research workflow fully implemented. Executes structured research requests with opportunity integration, halal safety checks, and evidence classification. All results are mocked examples.',
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
    
    if (researchRequest.opportunityId) {
      try {
        opportunity = await db.opportunity.findUnique({
          where: { id: researchRequest.opportunityId },
          select: { id: true, title: true, problemSolved: true, halalStatus: true, overallScore: true }
        });
        
        if (!opportunity) {
          const errorMessage = `Opportunity with ID ${researchRequest.opportunityId} not found`;
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
    let researchBlocked = false;
    let reviewRequired = false;
    
    if (opportunityHalalStatus === 'NOT_ALLOWED') {
      researchBlocked = true;
      halalConsiderations.push('Research blocked: Opportunity has NOT_ALLOWED halal status');
      halalConsiderations.push('No execution recommendations will be generated per halal safety rules');
    } else if (opportunityHalalStatus === 'REVIEW_REQUIRED') {
      reviewRequired = true;
      halalConsiderations.push('Human review required: Opportunity has REVIEW_REQUIRED halal status');
      halalConsiderations.push('All findings must be reviewed by a qualified human before any execution');
    }

    if (researchBlocked) {
      const researchResult: ResearchResult = {
        researchObjective: researchRequest.researchObjective,
        findings: [],
        signals: [],
        assumptions: [],
        risks: ['Research blocked due to halal compliance issues'],
        competitors: [],
        demandIndicators: [],
        monetizationObservations: [],
        halalConsiderations,
        overallConfidence: 0,
        evidenceItems: [],
        capabilityStatus: this.status
      };
      
      const result: AgentResult = {
        success: false,
        output: researchResult,
        reasoning: 'Research blocked due to halal compliance checks',
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        error: 'Halal compliance check failed',
        executionTime: Date.now() - startTime,
      };
      
      await this.logExecution(request.action, request.input, result);
      return result;
    }

    // 4. Generate Mock Research Results
    const mockFindings: ResearchFinding[] = [
      {
        id: uuidv4(),
        content: `Example demand hypothesis for: ${researchRequest.researchObjective}`,
        evidenceType: 'AI_INFERENCE' as EvidenceType
      },
      {
        id: uuidv4(),
        content: reviewRequired 
          ? 'REVIEW REQUIRED: This finding requires human validation before use' 
          : 'Preliminary analysis suggests potential market opportunity',
        evidenceType: 'AI_INFERENCE' as EvidenceType
      }
    ];

    const mockSignals: ResearchSignal[] = [
      {
        id: uuidv4(),
        type: 'demand',
        content: 'Example demand signal: Potential user interest in this category',
        confidence: 0.65,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        isMocked: true
      },
      {
        id: uuidv4(),
        type: 'competitor',
        content: 'Example competitor category: Other projects in similar space exist',
        confidence: 0.8,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        isMocked: true
      },
      {
        id: uuidv4(),
        type: 'monetization',
        content: 'Example monetization hypothesis: Multiple potential revenue streams identified',
        confidence: 0.7,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        isMocked: true
      },
      {
        id: uuidv4(),
        type: 'risk',
        content: 'Example risk signal: Market entry barriers require further analysis',
        confidence: 0.75,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        isMocked: true
      }
    ];

    // Add score suggestion if opportunity exists
    if (opportunity) {
      mockSignals.push({
        id: uuidv4(),
        type: 'demand',
        content: 'Research signal / suggested input: Opportunity score could be updated to 6.8/10 based on preliminary research',
        confidence: 0.55,
        evidenceType: 'AI_INFERENCE' as EvidenceType,
        isMocked: true
      });
    }

    const finalResearchResult: ResearchResult = {
      researchObjective: researchRequest.researchObjective,
      findings: mockFindings,
      signals: mockSignals,
      assumptions: ['Example assumption: Target market exists as described', 'Example assumption: User need is real and unmet'],
      risks: reviewRequired 
        ? ['REVIEW REQUIRED: All risks must be validated by human reviewer'] 
        : ['Example risk: Market conditions may change', 'Example risk: Competition could intensify'],
      competitors: ['Example competitor category: Similar solutions in this space'],
      demandIndicators: ['Example indicator: Preliminary interest signals exist'],
      monetizationObservations: ['Example observation: Multiple potential models to explore'],
      halalConsiderations,
      overallConfidence: 0.6,
      evidenceItems: mockFindings.map(f => ({ id: f.id, type: f.evidenceType, content: f.content })),
      capabilityStatus: this.status
    };

    // 5. Create AgentLog entry
    const agentLog = await db.agentLog.create({
      data: {
        agentType: this.type,
        action: request.action,
        input: JSON.stringify(request.input),
        output: JSON.stringify(finalResearchResult),
        reasoning: 'Mock research execution completed successfully',
        evidenceType: 'AI_INFERENCE'
      }
    });
    
    finalResearchResult.agentLogId = agentLog.id;

    const finalResult: AgentResult = {
      success: true,
      output: finalResearchResult,
      reasoning: reviewRequired 
        ? 'Mock research completed, but findings require human review due to REVIEW_REQUIRED opportunity status'
        : 'Mock research execution completed successfully with structured findings',
      evidenceType: 'AI_INFERENCE' as EvidenceType,
      executionTime: Date.now() - startTime,
    };

    return finalResult;
  }
}