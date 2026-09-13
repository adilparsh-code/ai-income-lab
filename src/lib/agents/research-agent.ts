import { BaseAgent } from './base-agent';
import { AgentRequest, AgentResult, EvidenceType } from './types';

export class ResearchAgent extends BaseAgent {
  constructor() {
    super({
      id: 'research-agent',
      type: 'research',
      name: 'Research Agent',
      description: 'Finds opportunities and market signals. Identifies trends, demand patterns, and underserved niches.',
      purpose: 'Discover and validate potential income opportunities by analyzing market data and identifying emerging trends.',
      currentCapability: 'Architecture implemented. Live research capabilities coming in Phase 3.2. Currently returns mocked results only.',
      status: 'MOCKED',
      evidencePolicy: 'All research findings are classified as AI_INFERENCE until verified by human or trusted data sources.',
      safeExecutionState: true,
      icon: 'Search',
    });
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    // If opportunityId is provided, check halal compliance first
    if (request.input.opportunityHalalStatus) {
      const isSafe = this.validateHalalCompliance(request.input.opportunityHalalStatus as string);
      if (!isSafe) {
        return {
          success: false,
          output: {},
          reasoning: 'Cannot research this opportunity - it has failed halal compliance checks.',
          evidenceType: 'AI_INFERENCE' as EvidenceType,
          error: 'Halal compliance check failed',
          executionTime: 0,
        };
      }
    }

    // Return mocked result as live capabilities are not yet implemented
    const result = this.getMockResult(request);
    await this.logExecution(request.action, request.input, result);
    return result;
  }
}